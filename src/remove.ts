import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  defaultGitRunner,
  removeExcludePaths,
  toRepoRelative,
  type GitRunner,
} from "./git-exclude.js";
import {
  loadManifest,
  saveManifest,
  type DecoyRecord,
  type Manifest,
} from "./manifest.js";
import { getStateDir } from "./paths.js";
import { sha256 } from "./plant.js";
import { rm } from "node:fs/promises";

export interface RemoveOptions {
  projectRoot?: string;
  home?: boolean;
  dryRun?: boolean;
  git?: GitRunner;
}

export interface RemoveAction {
  path: string;
  action: "deleted" | "kept-modified" | "missing" | "would-delete" | "would-keep-modified";
  detail?: string;
}

export interface RemoveReport {
  projectRoot: string;
  home: boolean;
  dryRun: boolean;
  actions: RemoveAction[];
  excludePathsRemoved: string[];
  warnings: string[];
}

function matchesProject(record: DecoyRecord, projectRoot: string): boolean {
  if (record.scope !== "project") return false;
  if (record.projectRoot !== undefined) {
    return path.resolve(record.projectRoot) === path.resolve(projectRoot);
  }
  // Legacy/partial: treat as project if under projectRoot
  return record.path.startsWith(path.resolve(projectRoot) + path.sep) ||
    record.path === path.resolve(projectRoot);
}

function selectTargets(
  manifest: Manifest,
  projectRoot: string,
  includeHome: boolean,
): DecoyRecord[] {
  const project = manifest.decoys.filter((d) => matchesProject(d, projectRoot));
  if (!includeHome) return project;
  const home = manifest.decoys.filter((d) => d.scope === "home");
  return [...project, ...home];
}

async function currentSha(filePath: string): Promise<string | null> {
  try {
    const buf = await readFile(filePath);
    return sha256(buf);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

async function deleteStateDirIfEmpty(manifest: Manifest): Promise<void> {
  if (manifest.decoys.length > 0) return;
  try {
    await rm(getStateDir(), { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

export async function runRemove(options: RemoveOptions = {}): Promise<RemoveReport> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const includeHome = options.home === true;
  const dryRun = options.dryRun === true;
  const git = options.git ?? defaultGitRunner;

  let manifest = await loadManifest();
  const targets = selectTargets(manifest, projectRoot, includeHome);

  const actions: RemoveAction[] = [];
  const warnings: string[] = [];
  const deletedAbs: string[] = [];

  for (const record of targets) {
    const hash = await currentSha(record.path);
    if (hash === null) {
      actions.push({ path: record.path, action: "missing" });
      continue;
    }
    if (hash === record.sha256) {
      if (dryRun) {
        actions.push({ path: record.path, action: "would-delete" });
      } else {
        await unlink(record.path);
        actions.push({ path: record.path, action: "deleted" });
        deletedAbs.push(record.path);
      }
    } else {
      const msg = `modified decoy left in place (sha256 mismatch): ${record.path}`;
      warnings.push(msg);
      if (dryRun) {
        actions.push({
          path: record.path,
          action: "would-keep-modified",
          detail: msg,
        });
      } else {
        actions.push({
          path: record.path,
          action: "kept-modified",
          detail: msg,
        });
      }
    }
  }

  const excludePathsRemoved: string[] = [];

  if (!dryRun) {
    // Drop deleted + missing from manifest; keep modified.
    const removePaths = new Set(
      targets
        .filter((t) => {
          const a = actions.find((x) => x.path === t.path);
          return a?.action === "deleted" || a?.action === "missing";
        })
        .map((t) => t.path),
    );

    manifest = {
      ...manifest,
      decoys: manifest.decoys.filter((d) => !removePaths.has(d.path)),
    };

    // Strip exclude lines only for deleted project decoys in this repo.
    const gitRoot = await git.revParseToplevel(projectRoot);
    if (gitRoot !== null) {
      const toStrip = deletedAbs
        .filter((abs) => {
          const rec = targets.find((t) => t.path === abs);
          return rec?.scope === "project";
        })
        .map((abs) => toRepoRelative(gitRoot, abs));

      // Also strip missing ones that were project decoys (file gone, clean exclude).
      for (const t of targets) {
        if (t.scope !== "project") continue;
        const a = actions.find((x) => x.path === t.path);
        if (a?.action === "missing") {
          toStrip.push(toRepoRelative(gitRoot, t.path));
        }
      }

      if (toStrip.length > 0) {
        await removeExcludePaths(gitRoot, toStrip);
        excludePathsRemoved.push(...toStrip);
      }
    }

    if (manifest.decoys.length === 0) {
      await deleteStateDirIfEmpty(manifest);
    } else {
      await saveManifest(manifest);
    }
  }

  return {
    projectRoot,
    home: includeHome,
    dryRun,
    actions,
    excludePathsRemoved,
    warnings,
  };
}

export function formatRemoveReport(report: RemoveReport): string {
  const lines: string[] = [];
  if (report.dryRun) {
    lines.push(`remove --dry-run for ${report.projectRoot}`);
  } else {
    lines.push(`Removed tripwire decoys in ${report.projectRoot}`);
  }

  if (report.actions.length === 0) {
    lines.push("  (nothing to do)");
  }

  for (const a of report.actions) {
    switch (a.action) {
      case "deleted":
        lines.push(`  deleted ${a.path}`);
        break;
      case "would-delete":
        lines.push(`  would delete ${a.path}`);
        break;
      case "kept-modified":
        lines.push(`  kept (modified) ${a.path}`);
        break;
      case "would-keep-modified":
        lines.push(`  would keep (modified) ${a.path}`);
        break;
      case "missing":
        lines.push(`  already absent ${a.path}`);
        break;
    }
  }

  for (const w of report.warnings) {
    lines.push(`  warning: ${w}`);
  }

  if (report.excludePathsRemoved.length > 0) {
    lines.push(
      `  exclude cleaned: ${report.excludePathsRemoved.join(", ")}`,
    );
  }

  if (report.home) {
    lines.push("  (included --home decoys)");
  }

  return lines.join("\n");
}
