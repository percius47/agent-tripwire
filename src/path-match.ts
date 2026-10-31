import path from "node:path";
import type { DecoyRecord } from "./manifest.js";
import { canonicalizePathSync } from "./path-util.js";

/** Fold for case-insensitive compare on win32. */
function fold(s: string): string {
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/** Normalize separators to `/` for suffix / equality checks. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True for `C:\…`, `C:/…`, or UNC `\\server\share`. */
export function isWindowsAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("//");
}

/** Absolute on this host, or a Windows absolute path (even when running on POSIX). */
export function isAbsoluteToolPath(p: string): boolean {
  return path.isAbsolute(p) || isWindowsAbsolutePath(p);
}

/**
 * Project-relative form used for suffix matching
 * (e.g. `.env.backup`, `config/secrets.legacy.json`).
 * Home decoys use the last two segments when available (`.aws/credentials.bak`).
 */
export function decoyProjectRelative(decoy: DecoyRecord): string {
  if (decoy.projectRoot) {
    return toPosixPath(path.relative(decoy.projectRoot, decoy.path));
  }
  const posix = toPosixPath(decoy.path);
  const parts = posix.split("/").filter((s) => s.length > 0);
  if (parts.length >= 2) {
    return parts.slice(-2).join("/");
  }
  return path.posix.basename(posix);
}

/**
 * Canonicalize when the file exists (realpathSync.native via path-util);
 * otherwise path.resolve for native absolutes. Windows-shaped paths on a
 * POSIX host are separator-normalized only — never resolved against cwd.
 * Relative paths are not resolved against cwd (UNVERIFIED appearance in logs).
 */
export function normalizeToolPathForCompare(toolPath: string): string {
  const trimmed = toolPath.trim();
  if (trimmed.length === 0) return "";

  if (isWindowsAbsolutePath(trimmed)) {
    if (process.platform === "win32") {
      try {
        return fold(toPosixPath(canonicalizePathSync(trimmed)));
      } catch {
        return fold(toPosixPath(path.resolve(trimmed)));
      }
    }
    return fold(toPosixPath(trimmed).replace(/\/+/g, "/"));
  }

  if (path.isAbsolute(trimmed)) {
    try {
      return fold(toPosixPath(canonicalizePathSync(trimmed)));
    } catch {
      return fold(toPosixPath(path.resolve(trimmed)));
    }
  }

  // Relative: do not resolve against process.cwd().
  return fold(toPosixPath(trimmed).replace(/\/+/g, "/"));
}

function underRoot(childNorm: string, rootNorm: string): boolean {
  if (rootNorm.length === 0) return false;
  return childNorm === rootNorm || childNorm.startsWith(`${rootNorm}/`);
}

/**
 * True when `toolPath` refers to the decoy file: canonical equality, or
 * normalized suffix equal to the decoy's project-relative path while under
 * the decoy's project root (tolerates 8.3 / long-name differences).
 * Relative tool paths match by basename / relative suffix only.
 */
export function pathRefersToDecoy(
  toolPath: string,
  decoy: DecoyRecord,
): boolean {
  const toolNorm = normalizeToolPathForCompare(toolPath);
  if (toolNorm.length === 0) return false;

  const decoyNorm = normalizeToolPathForCompare(decoy.path);
  if (toolNorm === decoyNorm) return true;

  const rel = fold(toPosixPath(decoyProjectRelative(decoy)));
  if (rel.length === 0) return false;

  const endsWithRel =
    toolNorm === rel ||
    toolNorm.endsWith(`/${rel}`) ||
    // Windows drive-less relative compare already folded
    (rel.includes("/") === false && path.posix.basename(toolNorm) === rel);

  if (!endsWithRel) return false;

  if (!isAbsoluteToolPath(toolPath)) {
    // Relative tool path (UNVERIFIED in Cursor logs): basename/suffix only.
    return true;
  }

  if (decoy.projectRoot) {
    const rootNorm = normalizeToolPathForCompare(decoy.projectRoot);
    if (underRoot(toolNorm, rootNorm)) return true;
    // Cross-platform fixture: Windows tool path vs POSIX decoy root — when
    // roots cannot be compared, still accept a clean relative-suffix match.
    const toolIsWin = isWindowsAbsolutePath(toolPath);
    const rootIsWin = isWindowsAbsolutePath(decoy.projectRoot);
    if (toolIsWin !== rootIsWin) {
      return endsWithRel;
    }
    return false;
  }

  // Home-scoped (no projectRoot): absolute equality already checked; accept
  // suffix of the home-relative form (e.g. `.aws/credentials.bak`).
  return endsWithRel;
}

/** First decoy whose path matches `toolPath`, or null. */
export function findDecoyForToolPath(
  toolPath: string,
  decoys: DecoyRecord[],
): DecoyRecord | null {
  for (const d of decoys) {
    if (pathRefersToDecoy(toolPath, d)) return d;
  }
  return null;
}

/**
 * Shell / Bash: flag when the command string contains the decoy's basename
 * or project-relative path (case-insensitive on win32).
 */
export function commandMentionsDecoy(
  command: string,
  decoy: DecoyRecord,
): boolean {
  const cmd = fold(toPosixPath(command));
  if (cmd.length === 0) return false;
  const base = fold(path.posix.basename(toPosixPath(decoy.path)));
  if (base.length > 0 && cmd.includes(base)) return true;
  const rel = fold(toPosixPath(decoyProjectRelative(decoy)));
  if (rel.length > 0 && cmd.includes(rel)) return true;
  return false;
}

export function findDecoyMentionedInCommand(
  command: string,
  decoys: DecoyRecord[],
): DecoyRecord | null {
  for (const d of decoys) {
    if (commandMentionsDecoy(command, d)) return d;
  }
  return null;
}
