import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PRIVATE_FILE_MODE } from "./fs-mode.js";
import { getManifestPath, getStateDir } from "./paths.js";

export interface DecoyRecord {
  path: string;
  sha256: string;
  tokenId: string;
  /**
   * Every planted string that should trigger a hit for this decoy
   * (primary tokenId plus any generated secret-likes). Older manifests
   * may omit this; matchers fall back to `[tokenId]`.
   */
  matchValues?: string[];
  createdAt: string;
  scope: "project" | "home";
  /** Absolute project root when scope is project. */
  projectRoot?: string;
}

export interface Manifest {
  version: 1;
  decoys: DecoyRecord[];
  /** Directories created by Tripwire (removed on `remove` only if empty). */
  createdDirs: string[];
}

export function emptyManifest(): Manifest {
  return { version: 1, decoys: [], createdDirs: [] };
}

export async function ensureStateDir(): Promise<string> {
  const dir = getStateDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

function assertManifestShape(parsed: unknown): Manifest {
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Invalid manifest: expected an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(
      `Invalid manifest: unsupported version ${String(obj.version)} (expected 1)`,
    );
  }
  if (!Array.isArray(obj.decoys)) {
    throw new Error("Invalid manifest: decoys must be an array");
  }
  const createdDirs = obj.createdDirs;
  if (createdDirs === undefined) {
    return { version: 1, decoys: obj.decoys as DecoyRecord[], createdDirs: [] };
  }
  if (!Array.isArray(createdDirs)) {
    throw new Error("Invalid manifest: createdDirs must be an array");
  }
  return {
    version: 1,
    decoys: obj.decoys as DecoyRecord[],
    createdDirs: createdDirs as string[],
  };
}

export async function loadManifest(): Promise<Manifest> {
  const manifestPath = getManifestPath();
  try {
    const raw = await readFile(manifestPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid manifest: not valid JSON");
    }
    return assertManifestShape(parsed);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return emptyManifest();
    }
    throw err;
  }
}

export async function saveManifest(manifest: Manifest): Promise<void> {
  await ensureStateDir();
  const manifestPath = getManifestPath();
  const normalized: Manifest = {
    version: 1,
    decoys: manifest.decoys,
    createdDirs: manifest.createdDirs ?? [],
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    { mode: PRIVATE_FILE_MODE },
  );
  // writeFile mode only applies on create; force 0600 on overwrite too.
  await chmod(manifestPath, PRIVATE_FILE_MODE);
}

export function upsertDecoy(manifest: Manifest, record: DecoyRecord): Manifest {
  const decoys = manifest.decoys.filter((d) => d.path !== record.path);
  decoys.push(record);
  return { ...manifest, decoys, createdDirs: manifest.createdDirs ?? [] };
}

export function addCreatedDirs(manifest: Manifest, dirs: string[]): Manifest {
  const set = new Set(manifest.createdDirs ?? []);
  for (const d of dirs) {
    set.add(path.resolve(d));
  }
  return { ...manifest, createdDirs: [...set].sort() };
}

export function absoluteWithin(root: string, relative: string): string {
  return path.resolve(root, relative);
}
