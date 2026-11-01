import { access, readFile, readdir, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  gitTopLevel,
  isGitRepo,
  stripExcludeBlock,
  toRepoRelative,
  writeExcludeBlock,
} from "./git-exclude.js";
import { resolveProjectRoot } from "./git-exclude.js";
import { stripGitignoreBlock } from "./gitignore-project.js";
import { removeProjectHooks } from "./hooks-install.js";
import {
  loadManifest,
  saveManifest,
  type DecoyRecord,
  type Manifest,
} from "./manifest.js";
import {
  getHomeDir,
  getManifestPath,
  getOffsetsPath,
  getStateDir,
} from "./paths.js";
import { isPathInside, pathsEqual } from "./path-util.js";
import { sha256 } from "./plant.js";
import { loadInstallMeta, tripwireDir } from "./project-state.js";

export interface RemoveOptions {
  projectRoot?: string;
  /** Also remove home-scoped decoys. */
  home?: boolean;
  dryRun?: boolean;
}

export interface RemoveReport {
  projectRoot: string;
  home: boolean;
  dryRun: boolean;
  deleted: string[];
  keptModified: { path: string; reason: string }[];
  missing: string[];
  removedDirs: string[];
  excludeStripped: boolean;
  gitignoreStripped: boolean;
  hooksRestored: string[];
  hooksDeleted: string[];
  notes: string[];
}

function sameProject(record: DecoyRecord, projectRoot: string): boolean {
  if (record.scope !== "project") return false;
  if (!record.projectRoot) return false;
  return pathsEqual(record.projectRoot, projectRoot);
}

function isUnder(root: string, candidate: string): boolean {
  return isPathInside(root, candidate);
}

async function fileSha256(filePath: string): Promise<string | null> {
  try {
    const buf = await readFile(filePath);
    return sha256(buf);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

async function deleteQuietly(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

/** Unlink and report whether the file actually existed. */
async function deleteIfExists(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw err;
  }
}

/** Remove a directory only when it exists and is empty. */
export async function removeDirIfEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    if (entries.length > 0) return false;
    await rmdir(dir);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
      return false;
    }
    throw err;
  }
}

/**
 * When no decoys / createdDirs remain: delete manifest.json and the watcher's
 * offsets.json. Keep hits.jsonl (and any other user files) by default. Then
 * rmdir the state dir only if it is empty — never recursive rm.
 */
async function maybeClearStateDir(manifest: Manifest): Promise<{
  clearedManifest: boolean;
  clearedOffsets: boolean;
  removedStateDir: boolean;
}> {
  if (manifest.decoys.length > 0 || (manifest.createdDirs?.length ?? 0) > 0) {
    return {
      clearedManifest: false,
      clearedOffsets: false,
      removedStateDir: false,
    };
  }
  const clearedManifest = await deleteIfExists(getManifestPath());
  const clearedOffsets = await deleteIfExists(getOffsetsPath());
  // hits.jsonl intentionally kept
  const removedStateDir = await removeDirIfEmpty(getStateDir());
  return {
    clearedManifest,
    clearedOffsets,
    removedStateDir,
  };
}

/**
 * Delete hash-matched decoys for the current project (and optionally home).
 * Modified files are left in place with a warning. Only our exclude block lines
 * are removed/rewritten. Empty createdDirs are removed. Idempotent.
 */
export async function runRemove(
  options: RemoveOptions = {},
): Promise<RemoveReport> {
  const cwd = options.projectRoot ?? process.cwd();
  const { projectRoot } = resolveProjectRoot(cwd);
  const includeHome = options.home === true;
  const dryRun = options.dryRun === true;
  const notes: string[] = [];
  const deleted: string[] = [];
  const keptModified: { path: string; reason: string }[] = [];
  const missing: string[] = [];
  const removedDirs: string[] = [];

  let manifest = await loadManifest();
  const selected = manifest.decoys.filter((d) => {
    if (sameProject(d, projectRoot)) return true;
    if (includeHome && d.scope === "home") return true;
    return false;
  });

  const removePaths = new Set<string>();

  for (const record of selected) {
    const hash = await fileSha256(record.path);
    if (hash === null) {
      missing.push(record.path);
      removePaths.add(record.path);
      continue;
    }
    if (hash === record.sha256) {
      if (!dryRun) {
        await deleteQuietly(record.path);
      }
      deleted.push(record.path);
      removePaths.add(record.path);
      continue;
    }
    keptModified.push({
      path: record.path,
      reason: "sha256 mismatch — left in place (not deleted)",
    });
  }

  manifest = {
    version: 1,
    decoys: manifest.decoys.filter((d) => !removePaths.has(d.path)),
    createdDirs: manifest.createdDirs ?? [],
  };

  const home = getHomeDir();
  const dirsToTry = [...(manifest.createdDirs ?? [])].sort(
    (a, b) => b.length - a.length,
  );
  const keptDirs: string[] = [];
  for (const dir of dirsToTry) {
    const underProject = isUnder(projectRoot, dir);
    const underHome = isUnder(home, dir) && !underProject;
    const relevant = underProject || (includeHome && underHome);

    if (!relevant) {
      keptDirs.push(dir);
      continue;
    }
    if (dryRun) {
      keptDirs.push(dir);
      continue;
    }
    const removed = await removeDirIfEmpty(dir);
    if (removed) {
      removedDirs.push(dir);
    } else {
      keptDirs.push(dir);
    }
  }
  if (!dryRun) {
    manifest = { ...manifest, createdDirs: keptDirs };
  }

  let excludeStripped = false;
  let gitignoreStripped = false;
  const hooksRestored: string[] = [];
  const hooksDeleted: string[] = [];

  const remainingForProject = manifest.decoys.filter(
    (d) =>
      d.scope === "project" &&
      d.projectRoot !== undefined &&
      pathsEqual(d.projectRoot, projectRoot),
  );

  if (isGitRepo(projectRoot)) {
    const repoRoot = gitTopLevel(projectRoot);
    if (repoRoot) {
      if (!dryRun) {
        if (remainingForProject.length === 0) {
          excludeStripped = await stripExcludeBlock(repoRoot);
          if (excludeStripped) {
            notes.push(
              `Stripped agent-tripwire exclude block in ${repoRoot}.`,
            );
          }
        } else {
          const rels = remainingForProject.map((d) =>
            toRepoRelative(repoRoot, d.path),
          );
          await writeExcludeBlock(repoRoot, rels);
          notes.push(
            `Rewrote exclude block for ${remainingForProject.length} remaining decoy(s).`,
          );
        }
      } else {
        notes.push(
          remainingForProject.length === 0
            ? "(dry-run) would strip agent-tripwire exclude block"
            : `(dry-run) would rewrite exclude for ${remainingForProject.length} remaining decoy(s)`,
        );
      }
    }
  }

  // Project hooks + gitignore + .tripwire — only when no project decoys remain
  // and an install is still present (keeps second remove a true no-op).
  if (remainingForProject.length === 0) {
    const installMeta = await loadInstallMeta(projectRoot);
    const tw = tripwireDir(projectRoot);
    let tripwirePresent = false;
    try {
      await access(tw);
      tripwirePresent = true;
    } catch {
      tripwirePresent = false;
    }

    if (installMeta !== null || tripwirePresent) {
      const weCreatedGitignore =
        installMeta?.createdFiles.includes(".gitignore") === true;

      if (!dryRun) {
        const hooks = await removeProjectHooks(projectRoot);
        hooksRestored.push(...hooks.restored);
        hooksDeleted.push(...hooks.deleted);
        notes.push(...hooks.notes);

        const gi = await stripGitignoreBlock(projectRoot, {
          deleteIfEmpty: weCreatedGitignore,
        });
        gitignoreStripped = gi.stripped;
        if (gi.deleted) {
          deleted.push(path.join(projectRoot, ".gitignore"));
          notes.push("Deleted .gitignore (was created by Tripwire and empty).");
        } else if (gi.stripped) {
          notes.push("Stripped agent-tripwire block from .gitignore.");
        }

        if (tripwirePresent) {
          try {
            await rm(tw, { recursive: true, force: true });
            removedDirs.push(tw);
            notes.push(`Removed ${tw}`);
          } catch {
            // ignore
          }
        }
      } else {
        notes.push(
          "(dry-run) would remove project hooks, gitignore block, and .tripwire/",
        );
      }
    }
  }

  if (dryRun) {
    notes.push("(dry-run) no files or manifest changes were written.");
  } else if (manifest.decoys.length === 0 && manifest.createdDirs.length === 0) {
    const cleared = await maybeClearStateDir(manifest);
    if (cleared.clearedManifest) {
      notes.push(`Deleted ${getManifestPath()}.`);
    }
    if (cleared.clearedOffsets) {
      notes.push(`Deleted watcher offsets ${getOffsetsPath()}.`);
    }
    if (cleared.removedStateDir) {
      notes.push(`Removed empty state dir ${getStateDir()}.`);
    } else {
      notes.push(
        `Kept state dir ${getStateDir()} (hits log or other files remain).`,
      );
    }
  } else {
    await saveManifest(manifest);
  }

  if (
    deleted.length === 0 &&
    keptModified.length === 0 &&
    missing.length === 0 &&
    removedDirs.length === 0 &&
    hooksRestored.length === 0 &&
    hooksDeleted.length === 0
  ) {
    notes.push("Nothing to remove (no matching decoys in manifest).");
  }

  return {
    projectRoot,
    home: includeHome,
    dryRun,
    deleted,
    keptModified,
    missing,
    removedDirs,
    excludeStripped,
    gitignoreStripped,
    hooksRestored,
    hooksDeleted,
    notes,
  };
}

export function formatRemoveReport(report: RemoveReport): string {
  const lines: string[] = [];
  if (report.dryRun) {
    lines.push(`remove --dry-run for ${report.projectRoot}`);
  } else {
    lines.push(`remove for ${report.projectRoot}`);
  }

  for (const p of report.deleted) {
    lines.push(`  deleted ${p}`);
  }
  for (const p of report.missing) {
    lines.push(`  already absent ${p}`);
  }
  for (const d of report.removedDirs) {
    lines.push(`  removed empty dir ${d}`);
  }
  for (const p of report.hooksRestored) {
    lines.push(`  restored ${p}`);
  }
  for (const p of report.hooksDeleted) {
    lines.push(`  deleted hooks file ${p}`);
  }
  for (const k of report.keptModified) {
    lines.push(`  warning: kept ${k.path} (${k.reason})`);
  }
  for (const note of report.notes) {
    lines.push(`note: ${note}`);
  }
  return lines.join("\n");
}
