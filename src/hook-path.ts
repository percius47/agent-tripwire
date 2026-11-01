import { statSync } from "node:fs";
import path from "node:path";

export const HOOK_BIN = "agent-tripwire-hook";

export type HookPathStatus =
  | { ok: true; path: string }
  | { ok: false; reason: "missing" | "npx-temporary"; path?: string };

/**
 * Find a command on PATH the way a shell would (PATHEXT on Windows).
 * Pure over its inputs so tests can pass a fake env.
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  const sep = platform === "win32" ? ";" : ":";
  const exts =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * Is the hook binary installed somewhere that will still exist after this
 * command exits? `npx` puts its temporary cache on PATH only while it runs,
 * so a hit inside an `_npx` folder does not count.
 */
export function hookPathStatus(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): HookPathStatus {
  const found = findOnPath(HOOK_BIN, env, platform);
  if (!found) return { ok: false, reason: "missing" };
  const parts = found.split(/[\\/]/);
  if (parts.includes("_npx")) {
    return { ok: false, reason: "npx-temporary", path: found };
  }
  return { ok: true, path: found };
}

export function hookPathWarning(status: HookPathStatus): string | null {
  if (status.ok) return null;
  const why =
    status.reason === "npx-temporary"
      ? "it is only on PATH temporarily because you ran this through npx"
      : "it was not found on your PATH";
  return [
    `WARNING: Tripwire is NOT protecting this project yet: \`${HOOK_BIN}\` ${why}.`,
    "Cursor and Claude Code will not find the hook, so nothing gets blocked.",
    "Fix: run `npm i -g agent-tripwire`, then `agent-tripwire init` again.",
  ].join("\n");
}
