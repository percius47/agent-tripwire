import { unlink } from "node:fs/promises";
import path from "node:path";
import { homeDecoyPlans, projectDecoyPlans } from "./decoys.js";
import {
  addExcludePaths,
  defaultGitRunner,
  findTrackedDecoys,
  restoreExclude,
  toRepoRelative,
  verifyIgnored,
  type GitRunner,
} from "./git-exclude.js";
import { loadManifest, saveManifest, type Manifest } from "./manifest.js";
import { plantPlans, type PlantResult } from "./plant.js";

export interface InitOptions {
  projectRoot?: string;
  home?: boolean;
  git?: GitRunner;
}

export interface InitReport {
  projectRoot: string;
  home: boolean;
  project: PlantResult;
  homeResult?: PlantResult;
  /** Absolute git toplevel, or null when not a git repo. */
  gitRoot: string | null;
  /** True when we wrote/verified .git/info/exclude. */
  excludeApplied: boolean;
  /** Human-readable notes (e.g. not a git repo). */
  notes: string[];
  /** Decoys rolled back because check-ignore failed. */
  rolledBack: { path: string; reason: string }[];
  /** Non-null when init refused before planting. */
  refused?: string;
}

async function dropDecoysFromManifest(
  manifest: Manifest,
  paths: string[],
): Promise<Manifest> {
  const drop = new Set(paths);
  return { ...manifest, decoys: manifest.decoys.filter((d) => !drop.has(d.path)) };
}

async function deleteFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await unlink(p);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }
}

export async function runInit(options: InitOptions = {}): Promise<InitReport> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const includeHome = options.home === true;
  const git = options.git ?? defaultGitRunner;

  const notes: string[] = [];
  const rolledBack: { path: string; reason: string }[] = [];

  let manifest = await loadManifest();
  const projectPlans = projectDecoyPlans(projectRoot);
  const plannedPaths = projectPlans.map((p) => p.path);

  const gitRoot = await git.revParseToplevel(projectRoot);

  if (gitRoot !== null) {
    const tracked = await findTrackedDecoys(gitRoot, plannedPaths, git);
    if (tracked.length > 0) {
      const refused = `Refusing to init: decoy path(s) already tracked by git: ${tracked.join(", ")}`;
      return {
        projectRoot,
        home: includeHome,
        project: { created: [], skipped: [] },
        gitRoot,
        excludeApplied: false,
        notes: [],
        rolledBack: [],
        refused,
      };
    }
  } else {
    notes.push("Not a git repository: planted without .git/info/exclude");
  }

  const plantedProject = await plantPlans(projectPlans, manifest, projectRoot);
  manifest = plantedProject.manifest;

  let homeResult: PlantResult | undefined;
  if (includeHome) {
    const plantedHome = await plantPlans(homeDecoyPlans(), manifest);
    manifest = plantedHome.manifest;
    homeResult = plantedHome.result;
  }

  let excludeApplied = false;

  if (gitRoot !== null && plantedProject.result.created.length > 0) {
    const createdAbs = plantedProject.result.created.map((c) => c.path);
    const relPaths = createdAbs.map((abs) => toRepoRelative(gitRoot, abs));
    const { previous } = await addExcludePaths(gitRoot, relPaths);

    const { notIgnored } = await verifyIgnored(gitRoot, createdAbs, git);

    if (notIgnored.length > 0) {
      // Roll back only the decoys that failed check-ignore, and revert exclude.
      await restoreExclude(gitRoot, previous);
      await deleteFiles(notIgnored);
      manifest = await dropDecoysFromManifest(manifest, notIgnored);

      // Also drop successfully-ignored siblings we just planted? Design says abort +
      // rollback when any decoy isn't ignored. Revert exclude already restored the
      // prior file; delete only the not-ignored ones, but the ignored ones we kept
      // would no longer be in exclude. Safer: roll back ALL newly created project
      // decoys so we never leave unignored decoys and never leave decoys without
      // exclude coverage after a failed verify.
      const createdOk = createdAbs.filter((p) => !notIgnored.includes(p));
      if (createdOk.length > 0) {
        await deleteFiles(createdOk);
        manifest = await dropDecoysFromManifest(manifest, createdOk);
        for (const p of createdOk) {
          rolledBack.push({
            path: p,
            reason: "rolled back because sibling decoy failed git check-ignore",
          });
        }
      }

      for (const p of notIgnored) {
        rolledBack.push({
          path: p,
          reason: "not ignored by git after writing .git/info/exclude",
        });
      }

      // Clear created list in report — they were rolled back.
      plantedProject.result = {
        created: [],
        skipped: [
          ...plantedProject.result.skipped,
          ...createdAbs.map((p) => ({
            path: p,
            label: path.basename(p),
            reason: "rolled back: git check-ignore failed",
          })),
        ],
      };

      notes.push(
        "Rollback: restored .git/info/exclude and deleted planted project decoys because check-ignore failed",
      );
      excludeApplied = false;
    } else {
      excludeApplied = true;
      notes.push("Added decoy paths to .git/info/exclude and verified with git check-ignore");
    }
  }

  await saveManifest(manifest);

  return {
    projectRoot,
    home: includeHome,
    project: plantedProject.result,
    ...(homeResult !== undefined ? { homeResult } : {}),
    gitRoot,
    excludeApplied,
    notes,
    rolledBack,
  };
}

export function formatInitReport(report: InitReport): string {
  const lines: string[] = [];

  if (report.refused) {
    lines.push(report.refused);
    return lines.join("\n");
  }

  lines.push(`Planted project decoys in ${report.projectRoot}`);

  for (const c of report.project.created) {
    lines.push(`  created ${c.path} (token ${c.tokenId})`);
  }
  for (const s of report.project.skipped) {
    lines.push(`  skipped ${s.path} (${s.reason})`);
  }

  if (report.home && report.homeResult) {
    lines.push("Planted home decoys:");
    for (const c of report.homeResult.created) {
      lines.push(`  created ${c.path} (token ${c.tokenId})`);
    }
    for (const s of report.homeResult.skipped) {
      lines.push(`  skipped ${s.path} (${s.reason})`);
    }
  }

  for (const n of report.notes) {
    lines.push(`  note: ${n}`);
  }
  for (const r of report.rolledBack) {
    lines.push(`  rolled back ${r.path} (${r.reason})`);
  }

  return lines.join("\n");
}
