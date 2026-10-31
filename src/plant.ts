import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { FORBIDDEN_WRITE_PATHS, type DecoyPlan } from "./decoys.js";
import { PRIVATE_FILE_MODE } from "./fs-mode.js";
import {
  addCreatedDirs,
  saveManifest,
  upsertDecoy,
  type DecoyRecord,
  type Manifest,
} from "./manifest.js";
import { getHomeDir } from "./paths.js";
import { canonicalizePathSync, pathKey, pathsEqual } from "./path-util.js";

export interface PlantResult {
  created: DecoyRecord[];
  skipped: { path: string; label: string; reason: string }[];
  createdDirs: string[];
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** True when a basename looks like .env* without an allowed decoy suffix. */
export function isForbiddenEnvName(filePath: string): boolean {
  const base = path.basename(filePath);
  if (!base.startsWith(".env")) return false;
  return !(base.endsWith(".backup") || base.endsWith(".old"));
}

export function assertSafePlantTarget(
  targetPath: string,
  projectRoot?: string,
): void {
  const resolved = path.resolve(targetPath);
  const home = getHomeDir();
  const forbidden = new Set<string>();
  if (projectRoot !== undefined) {
    for (const f of FORBIDDEN_WRITE_PATHS(projectRoot, home)) {
      forbidden.add(pathKey(f));
    }
  } else {
    forbidden.add(pathKey(path.join(home, ".aws", "credentials")));
    forbidden.add(pathKey(path.join(home, ".npmrc")));
  }

  if (forbidden.has(pathKey(resolved))) {
    throw new Error(`Refusing to write forbidden path: ${resolved}`);
  }
  if (isForbiddenEnvName(resolved)) {
    throw new Error(
      `Refusing to write .env* path without .backup/.old suffix: ${resolved}`,
    );
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Ensure `dir` exists. Refuse when an existing path component is a symlink
 * whose real path points outside `boundary` (project root for project decoys).
 * Returns directories that were newly created.
 */
export async function ensureDirsCreated(
  dir: string,
  boundary?: string,
): Promise<string[]> {
  const resolved = path.resolve(dir);
  const missing: string[] = [];
  let cur = resolved;

  for (;;) {
    try {
      const st = await fsp.lstat(cur);
      if (st.isSymbolicLink()) {
        const real = await fsp.realpath(cur);
        if (boundary !== undefined && !isPathInside(boundary, real)) {
          throw new Error(
            `Refusing to use directory symlink pointing outside the project: ${cur} -> ${real}`,
          );
        }
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      missing.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  missing.reverse();
  for (const d of missing) {
    await fsp.mkdir(d);
  }
  return missing;
}

/**
 * Write to an wx-opened handle. If write fails, close and delete `filePath`
 * so a partial decoy is never left behind.
 */
export async function commitWxWrite(
  handle: {
    writeFile: (data: string, encoding: BufferEncoding) => Promise<void>;
    close: () => Promise<void>;
  },
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await handle.writeFile(content, "utf8");
  } catch (writeErr) {
    await handle.close().catch(() => undefined);
    await fsp.unlink(filePath).catch(() => undefined);
    throw writeErr;
  }
}

/**
 * Create a decoy file with flag 'wx' (fail if exists). Never overwrites.
 * If write fails after open, the empty/partial file is deleted.
 * Files are chmod'd to 0600.
 */
export async function plantOne(
  plan: DecoyPlan,
  projectRoot?: string,
): Promise<
  | { record: DecoyRecord; createdDirs: string[] }
  | { skipped: true; reason: string; createdDirs: string[] }
> {
  assertSafePlantTarget(plan.path, projectRoot);

  // Existing path (file or symlink, including dangling) → skip, never follow.
  try {
    await fsp.lstat(plan.path);
    return { skipped: true, reason: "already exists", createdDirs: [] };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }

  const { content, tokenId, matchValues } = plan.render();
  const dir = path.dirname(plan.path);
  const boundary = plan.scope === "project" ? projectRoot : undefined;
  const createdDirs = await ensureDirsCreated(dir, boundary);

  let handle;
  try {
    handle = await fsp.open(plan.path, "wx");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return { skipped: true, reason: "already exists", createdDirs };
    }
    throw err;
  }

  try {
    await commitWxWrite(handle, plan.path, content);
  } finally {
    await handle.close().catch(() => undefined);
  }

  await fsp.chmod(plan.path, PRIVATE_FILE_MODE);

  const record: DecoyRecord = {
    path: canonicalizePathSync(plan.path),
    sha256: sha256(content),
    tokenId,
    matchValues: [...new Set(matchValues.length > 0 ? matchValues : [tokenId])],
    createdAt: new Date().toISOString(),
    scope: plan.scope,
    ...(projectRoot !== undefined
      ? { projectRoot: canonicalizePathSync(projectRoot) }
      : {}),
  };

  return {
    record,
    createdDirs: createdDirs.map((d) => canonicalizePathSync(d)),
  };
}

export async function plantPlans(
  plans: DecoyPlan[],
  manifest: Manifest,
  projectRoot?: string,
): Promise<{ manifest: Manifest; result: PlantResult }> {
  const created: DecoyRecord[] = [];
  const skipped: PlantResult["skipped"] = [];
  const allCreatedDirs: string[] = [];
  let next = manifest;

  for (const plan of plans) {
    const outcome = await plantOne(plan, projectRoot);
    if (outcome.createdDirs.length > 0) {
      allCreatedDirs.push(...outcome.createdDirs);
      next = addCreatedDirs(next, outcome.createdDirs);
    }
    if ("skipped" in outcome) {
      skipped.push({
        path: plan.path,
        label: plan.label,
        reason: outcome.reason,
      });
      if (outcome.createdDirs.length > 0) {
        await saveManifest(next);
      }
      continue;
    }
    created.push(outcome.record);
    next = upsertDecoy(next, outcome.record);
    // Persist after each planted file so a crash never loses prior plants.
    await saveManifest(next);
  }

  return {
    manifest: next,
    result: { created, skipped, createdDirs: [...new Set(allCreatedDirs)] },
  };
}

/** Test helper: path exists via lstat (follows nothing). */
export async function pathExistsLstat(filePath: string): Promise<boolean> {
  try {
    await fsp.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}
