import path from "node:path";
import os from "node:os";
import { canonicalizePathSync } from "./path-util.js";

/**
 * Resolve the effective home directory.
 * Production uses os.homedir(). Tests may set AGENT_TRIPWIRE_HOME only
 * (never rely on mutating HOME for Tripwire state).
 * Always canonicalize so Windows 8.3 short names match git/realpath forms.
 */
export function getHomeDir(): string {
  const override = process.env.AGENT_TRIPWIRE_HOME;
  if (override !== undefined && override.length > 0) {
    return canonicalizePathSync(override);
  }
  return canonicalizePathSync(os.homedir());
}

/** State directory: ~/.agent-tripwire/ (respects AGENT_TRIPWIRE_HOME). */
export function getStateDir(): string {
  return path.join(getHomeDir(), ".agent-tripwire");
}

export function getManifestPath(): string {
  return path.join(getStateDir(), "manifest.json");
}

export function getOffsetsPath(): string {
  return path.join(getStateDir(), "offsets.json");
}

export function getHitsPath(): string {
  return path.join(getStateDir(), "hits.jsonl");
}

export function getConfigPath(): string {
  return path.join(getStateDir(), "config.json");
}
