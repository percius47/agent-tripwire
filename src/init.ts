import { unlink } from "node:fs/promises";
import path from "node:path";
import { homeDecoyPlans, projectDecoyPlans } from "./decoys.js";
import {
  gitTopLevel,
  resolveProjectRoot,
  isIgnored,
  toRepoRelative,
  trackedPaths,
  writeExcludeBlock,
} from "./git-exclude.js";
import {
  loadManifest,
  saveManifest,
  type DecoyRecord,
  type Manifest,
} from "./manifest.js";
import { plantPlans, type PlantResult } from "./plant.js";
import { formatTokenLabel } from "./token-label.js";

export { resolveProjectRoot } from "./git-exclude.js";

export interface InitOptions {
  projectRoot?: string;
  home?: boolean;
}

export interface InitReport {
  projectRoot: string;
  home: boolean;
  project: PlantResult;
  homeResult?: PlantResult;
  /** Whether the project root is inside a git work tree. */
  gitRepo: boolean;
  /** Absolute path of .git/info/exclude when we wrote an exclude block. */
  excludePath?: string;
  /** Decoys rolled back because check-ignore failed. */
  rolledBack: { path: string; reason: string }[];
  /** Tracked decoy paths that caused refusal (not planted). */
  refusedTracked: string[];
  /** Human-readable notes (e.g. not a git repo). */
  notes: string[];
}

async function deleteQuietly(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

function removeDecoysFromManifest(
  manifest: Manifest,
  paths: Set<string>,
): Manifest {
  return {
    ...manifest,
    decoys: manifest.decoys.filter((d) => !paths.has(d.path)),
    createdDirs: manifest.createdDirs ?? [],
  };
}

/** All project decoys in `manifest` that belong to `projectRoot`. */
function decoysForProject(
  manifest: Manifest,
  projectRoot: string,
): DecoyRecord[] {
  const root = path.resolve(projectRoot);
  return manifest.decoys.filter(
    (d) =>
      d.scope === "project" &&
      d.projectRoot !== undefined &&
      path.resolve(d.projectRoot) === root,
  );
}

/**
 * After planting project decoys in a git repo: write .git/info/exclude from
 * ALL manifest decoys for this repo (not just this run's creates), verify
 * newly created paths with check-ignore, and roll back any that fail.
 */
async function secureGitIgnore(
  repoRoot: string,
  created: DecoyRecord[],
  manifest: Manifest,
  projectRoot: string,
): Promise<{
  manifest: Manifest;
  excludePath: string;
  rolledBack: { path: string; reason: string }[];
  kept: DecoyRecord[];
}> {
  // Always rewrite exclude from every decoy recorded for this project so a
  // partial re-init (some paths skipped as already present) cannot drop
  // earlier ignore lines.
  const allForRepo = decoysForProject(manifest, projectRoot);
  const relativePaths = allForRepo.map((c) =>
    toRepoRelative(repoRoot, c.path),
  );
  const excludePath = await writeExcludeBlock(repoRoot, relativePaths);

  const failed: DecoyRecord[] = [];
  for (const record of created) {
    const rel = toRepoRelative(repoRoot, record.path);
    if (!isIgnored(repoRoot, rel)) {
      failed.push(record);
    }
  }

  if (failed.length === 0) {
    return { manifest, excludePath, rolledBack: [], kept: created };
  }

  const rolledBack: { path: string; reason: string }[] = [];
  const failedPaths = new Set(failed.map((f) => f.path));

  for (const f of failed) {
    await deleteQuietly(f.path);
    rolledBack.push({
      path: f.path,
      reason: "not ignored by git after exclude update (rolled back)",
    });
  }

  const kept = created.filter((c) => !failedPaths.has(c.path));
  const next = removeDecoysFromManifest(manifest, failedPaths);
  // Rewrite exclude from remaining ALL decoys for this repo (same as remove).
  const remaining = decoysForProject(next, projectRoot);
  if (remaining.length === 0) {
    await writeExcludeBlock(repoRoot, []);
  } else {
    await writeExcludeBlock(
      repoRoot,
      remaining.map((d) => toRepoRelative(repoRoot, d.path)),
    );
  }

  await saveManifest(next);
  return { manifest: next, excludePath, rolledBack, kept };
}

export async function runInit(options: InitOptions = {}): Promise<InitReport> {
  const cwd = path.resolve(options.projectRoot ?? process.cwd());
  const resolved = resolveProjectRoot(cwd);
  const projectRoot = resolved.projectRoot;
  const includeHome = options.home === true;
  const notes: string[] = [];
  const refusedTracked: string[] = [];
  let rolledBack: { path: string; reason: string }[] = [];
  let excludePath: string | undefined;

  if (resolved.fromSubdir) {
    notes.push(
      `Using git toplevel ${projectRoot} (ran from subdirectory ${cwd}).`,
    );
  }

  let manifest = await loadManifest();

  const projectPlans = projectDecoyPlans(projectRoot);
  const inGit = resolved.gitRepo;
  const repoRoot = inGit ? gitTopLevel(projectRoot) : null;

  let plansToPlant = projectPlans;
  if (repoRoot) {
    const rels = projectPlans.map((p) => toRepoRelative(repoRoot, p.path));
    const tracked = trackedPaths(repoRoot, rels);
    if (tracked.length > 0) {
      const trackedSet = new Set(
        tracked.map((t) => path.resolve(repoRoot, t)),
      );
      for (const plan of projectPlans) {
        if (trackedSet.has(path.resolve(plan.path))) {
          refusedTracked.push(plan.path);
        }
      }
      plansToPlant = projectPlans.filter(
        (p) => !trackedSet.has(path.resolve(p.path)),
      );
      notes.push(
        `Refused ${refusedTracked.length} tracked decoy path(s); not planted.`,
      );
    }
  }

  const plantedProject = await plantPlans(plansToPlant, manifest, projectRoot);
  manifest = plantedProject.manifest;

  const projectResult: PlantResult = {
    created: plantedProject.result.created,
    skipped: [
      ...plantedProject.result.skipped,
      ...refusedTracked.map((p) => ({
        path: p,
        label: path.relative(projectRoot, p) || p,
        reason: "already tracked by git",
      })),
    ],
    createdDirs: plantedProject.result.createdDirs,
  };

  if (inGit && repoRoot) {
    // Always refresh exclude from the full project decoy set, even when this
    // run created nothing new (e.g. all paths already existed).
    if (
      projectResult.created.length > 0 ||
      decoysForProject(manifest, projectRoot).length > 0
    ) {
      const secured = await secureGitIgnore(
        repoRoot,
        projectResult.created,
        manifest,
        projectRoot,
      );
      manifest = secured.manifest;
      excludePath = secured.excludePath;
      rolledBack = secured.rolledBack;
      projectResult.created = secured.kept;
      if (rolledBack.length > 0) {
        notes.push(
          `Rolled back ${rolledBack.length} decoy(s) that were not ignored by git.`,
        );
      } else {
        notes.push(
          `Updated ${excludePath} (local exclude; .gitignore untouched).`,
        );
      }
    } else {
      notes.push("Git repo detected; no new project decoys to exclude.");
    }
  } else {
    notes.push(
      "Not a git repository: planted without .git/info/exclude. Decoys may be committed if you init a repo later.",
    );
  }

  let homeResult: PlantResult | undefined;
  if (includeHome) {
    const plantedHome = await plantPlans(homeDecoyPlans(), manifest);
    manifest = plantedHome.manifest;
    homeResult = plantedHome.result;
  }

  // plantPlans already saved per file; final save covers rollback / notes-only paths.
  await saveManifest(manifest);

  return {
    projectRoot,
    home: includeHome,
    project: projectResult,
    ...(homeResult !== undefined ? { homeResult } : {}),
    gitRepo: inGit,
    ...(excludePath !== undefined ? { excludePath } : {}),
    rolledBack,
    refusedTracked,
    notes,
  };
}

export function formatInitReport(report: InitReport): string {
  const lines: string[] = [];
  lines.push(`Planted project decoys in ${report.projectRoot}`);

  for (const c of report.project.created) {
    lines.push(`  created ${c.path} (${formatTokenLabel(c.tokenId)})`);
  }
  for (const s of report.project.skipped) {
    lines.push(`  skipped ${s.path} (${s.reason})`);
  }
  for (const r of report.rolledBack) {
    lines.push(`  rolled back ${r.path} (${r.reason})`);
  }

  if (report.home && report.homeResult) {
    lines.push("Planted home decoys:");
    for (const c of report.homeResult.created) {
      lines.push(`  created ${c.path} (${formatTokenLabel(c.tokenId)})`);
    }
    for (const s of report.homeResult.skipped) {
      lines.push(`  skipped ${s.path} (${s.reason})`);
    }
  }

  for (const note of report.notes) {
    lines.push(`note: ${note}`);
  }

  return lines.join("\n");
}
