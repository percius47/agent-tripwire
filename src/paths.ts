import path from "node:path";
import os from "node:os";

/**
 * Resolve the effective home directory.
 * Production uses os.homedir(). Tests may set AGENT_TRIPWIRE_HOME only
 * (never rely on mutating HOME for Tripwire state).
 */
export function getHomeDir(): string {
  const override = process.env.AGENT_TRIPWIRE_HOME;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return os.homedir();
}

/** State directory: ~/.agent-tripwire/ (respects AGENT_TRIPWIRE_HOME). */
export function getStateDir(): string {
  return path.join(getHomeDir(), ".agent-tripwire");
}

export function getManifestPath(): string {
  return path.join(getStateDir(), "manifest.json");
}
