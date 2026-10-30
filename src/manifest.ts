import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getManifestPath, getStateDir } from "./paths.js";

export interface DecoyRecord {
  path: string;
  sha256: string;
  tokenId: string;
  createdAt: string;
  scope: "project" | "home";
  /** Absolute project root when scope is project. */
  projectRoot?: string;
}

export interface Manifest {
  version: 1;
  decoys: DecoyRecord[];
}

export function emptyManifest(): Manifest {
  return { version: 1, decoys: [] };
}

export async function ensureStateDir(): Promise<string> {
  const dir = getStateDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function loadManifest(): Promise<Manifest> {
  const manifestPath = getManifestPath();
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.decoys)) {
      return emptyManifest();
    }
    return parsed;
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
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function upsertDecoy(manifest: Manifest, record: DecoyRecord): Manifest {
  const decoys = manifest.decoys.filter((d) => d.path !== record.path);
  decoys.push(record);
  return { ...manifest, decoys };
}

export function absoluteWithin(root: string, relative: string): string {
  return path.resolve(root, relative);
}
