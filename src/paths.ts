import path from "node:path";
import os from "node:os";

/** Resolve the effective home directory. HOME is overridable for tests. */
export function getHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

/** State directory: ~/.agent-tripwire/ (respects HOME override). */
export function getStateDir(): string {
  return path.join(getHomeDir(), ".agent-tripwire");
}

export function getManifestPath(): string {
  return path.join(getStateDir(), "manifest.json");
}
