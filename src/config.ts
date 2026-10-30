import { readFile } from "node:fs/promises";
import { getConfigPath } from "./paths.js";

export type AdapterFormat = "jsonl" | "text";

export interface ConfigAdapterEntry {
  /** Glob (absolute or relative to home) of log files to watch. */
  glob: string;
  /** Optional label for alerts (defaults to the glob). */
  name?: string;
  /** Line format: jsonl extracts text fields; text matches raw lines. */
  format?: AdapterFormat;
}

export interface TripwireConfig {
  /** Extra log sources beyond built-in adapters. */
  adapters: ConfigAdapterEntry[];
}

export function emptyConfig(): TripwireConfig {
  return { adapters: [] };
}

function assertConfig(parsed: unknown): TripwireConfig {
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Invalid config: expected an object");
  }
  const obj = parsed as Record<string, unknown>;
  const adaptersRaw = obj.adapters;
  if (adaptersRaw === undefined) {
    return emptyConfig();
  }
  if (!Array.isArray(adaptersRaw)) {
    throw new Error("Invalid config: adapters must be an array");
  }
  const adapters: ConfigAdapterEntry[] = [];
  for (const entry of adaptersRaw) {
    if (entry === null || typeof entry !== "object") {
      throw new Error("Invalid config: each adapter must be an object");
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.glob !== "string" || e.glob.length === 0) {
      throw new Error("Invalid config: adapter.glob must be a non-empty string");
    }
    const format = e.format;
    if (
      format !== undefined &&
      format !== "jsonl" &&
      format !== "text"
    ) {
      throw new Error('Invalid config: adapter.format must be "jsonl" or "text"');
    }
    const item: ConfigAdapterEntry = { glob: e.glob };
    if (typeof e.name === "string") {
      item.name = e.name;
    }
    if (format === "jsonl" || format === "text") {
      item.format = format;
    }
    adapters.push(item);
  }
  return { adapters };
}

/** Load ~/.agent-tripwire/config.json; missing file → empty config. */
export async function loadConfig(): Promise<TripwireConfig> {
  try {
    const raw = await readFile(getConfigPath(), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid config: not valid JSON");
    }
    return assertConfig(parsed);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return emptyConfig();
    }
    throw err;
  }
}
