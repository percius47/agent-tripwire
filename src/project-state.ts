import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { PRIVATE_FILE_MODE } from "./fs-mode.js";

export const TRIPWIRE_DIR = ".tripwire";
export const HOOK_MARKER = "agentTripwire";
export const HOOK_COMMAND = "agent-tripwire-hook";

export interface ProjectConfig {
  version: 1;
  /** When true, real-secret reads/commands are denied instead of alert+allow. */
  blockRealSecrets: boolean;
  notify: boolean;
}

export interface ProjectAllowlist {
  version: 1;
  /** Absolute or project-relative paths that suppress alerts/denies. */
  paths: string[];
  /** Command substrings (case-insensitive) that suppress alerts/denies. */
  commands: string[];
}

export interface InstallMeta {
  version: 1;
  createdAt: string;
  projectRoot: string;
  /** Relative paths we created from scratch (delete on remove if empty of foreign content). */
  createdFiles: string[];
  /** Relative path → backup relative path under .tripwire/backups/. */
  backups: Record<string, string>;
  /** Relative decoy paths planted for this project (for gitignore). */
  decoyRelPaths: string[];
}

export interface IncidentRecord {
  at: string;
  agent: "cursor" | "claude-code" | "unknown";
  sessionId: string;
  transcriptPath: string;
  rule: "decoy" | "real-secret" | "exfil" | "tamper" | "allowlist" | "none";
  severity: "high" | "medium" | "low" | "info";
  action: "deny" | "ask" | "allow" | "alert";
  target: string;
  verdict: string;
  /** sha256 of a sensitive value when applicable — never the raw value. */
  valueSha256?: string;
  /** First 4 chars + length; never the full secret. */
  valuePreview?: string;
}

export function tripwireDir(projectRoot: string): string {
  return path.join(projectRoot, TRIPWIRE_DIR);
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(tripwireDir(projectRoot), "config.json");
}

export function projectAllowPath(projectRoot: string): string {
  return path.join(tripwireDir(projectRoot), "allow.json");
}

export function projectIncidentsPath(projectRoot: string): string {
  return path.join(tripwireDir(projectRoot), "incidents.log");
}

export function projectInstallPath(projectRoot: string): string {
  return path.join(tripwireDir(projectRoot), "install.json");
}

export function projectBackupsDir(projectRoot: string): string {
  return path.join(tripwireDir(projectRoot), "backups");
}

export function defaultProjectConfig(): ProjectConfig {
  return { version: 1, blockRealSecrets: false, notify: true };
}

export function defaultAllowlist(): ProjectAllowlist {
  return { version: 1, paths: [], commands: [] };
}

export async function ensureTripwireDir(projectRoot: string): Promise<string> {
  const dir = tripwireDir(projectRoot);
  await mkdir(dir, { recursive: true });
  await mkdir(projectBackupsDir(projectRoot), { recursive: true });
  return dir;
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  await chmod(filePath, PRIVATE_FILE_MODE);
}

export async function loadProjectConfig(
  projectRoot: string,
): Promise<ProjectConfig> {
  try {
    const raw = await readFile(projectConfigPath(projectRoot), "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectConfig>;
    return {
      version: 1,
      blockRealSecrets: parsed.blockRealSecrets === true,
      notify: parsed.notify !== false,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return defaultProjectConfig();
    throw err;
  }
}

export async function saveProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  await ensureTripwireDir(projectRoot);
  await writePrivateJson(projectConfigPath(projectRoot), {
    version: 1,
    blockRealSecrets: config.blockRealSecrets,
    notify: config.notify,
  });
}

export async function loadAllowlist(
  projectRoot: string,
): Promise<ProjectAllowlist> {
  try {
    const raw = await readFile(projectAllowPath(projectRoot), "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectAllowlist>;
    return {
      version: 1,
      paths: Array.isArray(parsed.paths)
        ? parsed.paths.filter((p): p is string => typeof p === "string")
        : [],
      commands: Array.isArray(parsed.commands)
        ? parsed.commands.filter((c): c is string => typeof c === "string")
        : [],
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return defaultAllowlist();
    throw err;
  }
}

export async function saveAllowlist(
  projectRoot: string,
  allow: ProjectAllowlist,
): Promise<void> {
  await ensureTripwireDir(projectRoot);
  await writePrivateJson(projectAllowPath(projectRoot), {
    version: 1,
    paths: allow.paths,
    commands: allow.commands,
  });
}

export async function loadInstallMeta(
  projectRoot: string,
): Promise<InstallMeta | null> {
  try {
    const raw = await readFile(projectInstallPath(projectRoot), "utf8");
    return JSON.parse(raw) as InstallMeta;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function saveInstallMeta(
  projectRoot: string,
  meta: InstallMeta,
): Promise<void> {
  await ensureTripwireDir(projectRoot);
  await writePrivateJson(projectInstallPath(projectRoot), meta);
}

export function redactValue(value: string): {
  valueSha256: string;
  valuePreview: string;
} {
  const valueSha256 = createHash("sha256").update(value, "utf8").digest("hex");
  const prefix = value.slice(0, Math.min(4, value.length));
  return {
    valueSha256,
    valuePreview: `${prefix}…(len=${value.length})`,
  };
}

export async function appendIncident(
  projectRoot: string,
  incident: IncidentRecord,
): Promise<void> {
  await ensureTripwireDir(projectRoot);
  const line = `${JSON.stringify(incident)}\n`;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(projectIncidentsPath(projectRoot), line, {
    mode: PRIVATE_FILE_MODE,
  });
}

export async function loadIncidents(
  projectRoot: string,
): Promise<IncidentRecord[]> {
  try {
    const raw = await readFile(projectIncidentsPath(projectRoot), "utf8");
    const out: IncidentRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as IncidentRecord);
      } catch {
        // skip malformed lines
      }
    }
    return out;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
}
