import { readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { tripwireDir } from "./project-state.js";

export interface PauseState {
  version: 1;
  /** ISO time when the pause ends on its own. */
  until: string;
  createdAt: string;
}

/** Longest allowed snooze, so a forgotten pause can't last forever. */
export const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PAUSE = "30m";

export function pausePath(projectRoot: string): string {
  return path.join(tripwireDir(projectRoot), "pause.json");
}

/** Parse "30m", "2h", "90s", "1h30m". Returns ms or null when invalid. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!/^(\d+[smh])+$/.test(t)) return null;
  let ms = 0;
  for (const m of t.matchAll(/(\d+)([smh])/g)) {
    const n = Number.parseInt(m[1]!, 10);
    ms += n * (m[2] === "s" ? 1000 : m[2] === "m" ? 60_000 : 3_600_000);
  }
  return ms > 0 ? ms : null;
}

export async function pauseProject(
  projectRoot: string,
  durationText: string,
  now: Date = new Date(),
): Promise<PauseState> {
  const ms = parseDuration(durationText);
  if (ms === null) {
    throw new Error(
      `Invalid duration "${durationText}". Use e.g. 15m, 2h, 1h30m.`,
    );
  }
  if (ms > MAX_PAUSE_MS) {
    throw new Error("Pause can be at most 24h.");
  }
  const state: PauseState = {
    version: 1,
    until: new Date(now.getTime() + ms).toISOString(),
    createdAt: now.toISOString(),
  };
  const p = pausePath(projectRoot);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export async function resumeProject(projectRoot: string): Promise<boolean> {
  try {
    await unlink(pausePath(projectRoot));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Active pause, or null. Expired, unreadable or out-of-range pause files
 * count as NOT paused (fail closed: guarding stays on).
 */
export async function activePause(
  projectRoot: string,
  now: Date = new Date(),
): Promise<PauseState | null> {
  let raw: string;
  try {
    raw = await readFile(pausePath(projectRoot), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PauseState>;
    if (typeof parsed.until !== "string" || typeof parsed.createdAt !== "string") {
      return null;
    }
    const until = Date.parse(parsed.until);
    const created = Date.parse(parsed.createdAt);
    if (!Number.isFinite(until) || !Number.isFinite(created)) return null;
    // Reject hand-edited pauses longer than the max.
    if (until - created > MAX_PAUSE_MS + 60_000) return null;
    if (until <= now.getTime()) return null;
    return { version: 1, until: parsed.until, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

/** Matches an agent's shell command trying to switch Tripwire off. */
export function isTamperCommand(command: string): boolean {
  const c = command.toLowerCase();
  if (/agent-tripwire(?:\.cmd)?\s+(?:pause|remove)\b/.test(c)) return true;
  // Direct writes / deletes of Tripwire state or hook files.
  if (
    /(?:\.tripwire[\\/](?:pause|config|allow|install)\.json|\.cursor[\\/]hooks\.json|\.claude[\\/]settings(?:\.local)?\.json)/.test(c) &&
    /(?:>|\brm\b|\bdel\b|remove-item|set-content|out-file|\bmv\b|move-item|\bcp\b|copy-item|tee\b|sed\s+-i|echo\b|new-item)/.test(c)
  ) {
    return true;
  }
  return false;
}
