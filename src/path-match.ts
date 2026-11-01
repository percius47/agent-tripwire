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
 * Map Git-Bash style `/c/Users/...` → `C:/Users/...` so win32 hosts can
 * require projectRoot instead of accepting any project.
 */
export function mapGitBashStylePath(p: string): string {
  const m = /^\/([A-Za-z])\/(.*)$/.exec(p.replace(/\\/g, "/"));
  if (!m) return p;
  return `${m[1]!.toUpperCase()}:/${m[2]}`;
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
 * Cursor project-folder slug for an absolute project root.
 * Approximate form used when planting fixture dirs; identity compares go through
 * {@link normalizeProjectIdentity} so spaces / `:\` vs `-` differences still match.
 * `C:\Users\Name\Documents\GitHub\LAMP` → `c-Users-Name-Documents-GitHub-LAMP`
 */
export function toCursorProjectSlug(projectRoot: string): string {
  let p = toPosixPath(projectRoot);
  p = p.replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase());
  p = p.replace(/:/g, "");
  p = p.replace(/^\/+/, "");
  p = p.replace(/\//g, "-");
  return p;
}

/**
 * Claude Code mangled project dir for an absolute cwd/root.
 * Approximate form; identity compares use {@link normalizeProjectIdentity}.
 * `C:\Users\Name\LAMP` → `C--Users-Name-LAMP` (`:` and separators → `-`).
 */
export function toClaudeProjectSlug(projectRoot: string): string {
  let p = toPosixPath(projectRoot);
  p = p.replace(/:/g, "-");
  p = p.replace(/\//g, "-");
  return p;
}

/**
 * Canonical project-identity key for slug ↔ projectRoot compares.
 * Lowercases, collapses every run of non-alphanumeric characters into a single
 * `-`, then trims leading/trailing dashes. Exact equality only — a prefix must
 * not match (`…-app` ≠ `…-app2`).
 *
 * Absorbs Cursor (`c-Users-…`, `:\` → one `-`) and Claude (`C--Users-…`,
 * `:\` → two `-`) folder slugs, and Windows roots with spaces in the home path.
 */
export function normalizeProjectIdentity(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function cursorProjectSlugFromLogPath(filePath: string): string | undefined {
  const parts = toPosixPath(filePath).split("/");
  for (let i = 0; i < parts.length - 2; i++) {
    if (
      parts[i] === "projects" &&
      parts[i + 2] === "agent-transcripts" &&
      parts[i + 1] &&
      parts[i + 1]!.length > 0
    ) {
      return parts[i + 1];
    }
  }
  return undefined;
}

export function claudeProjectSlugFromLogPath(filePath: string): string | undefined {
  const parts = toPosixPath(filePath).split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (
      parts[i] === "projects" &&
      parts[i + 1] &&
      parts[i + 1]!.length > 0 &&
      parts[i + 2] !== undefined &&
      parts[i + 2]!.endsWith(".jsonl")
    ) {
      return parts[i + 1];
    }
  }
  return undefined;
}

export interface TranscriptProjectContext {
  /** Adapter id (`cursor`, `claude-code`, …). */
  adapterId: string;
  /**
   * Cursor: project slug from the log path.
   * Claude: absolute `cwd` from the record when present, else mangled slug.
   */
  projectHint?: string;
}

/**
 * True when the decoy's projectRoot corresponds to the transcript project.
 * Home-scoped decoys (no projectRoot) never match. Missing projectHint → false.
 * Cursor / Claude slug hints are compared via {@link normalizeProjectIdentity}
 * so Windows homes with spaces still match real Cursor/Claude folder names.
 */
export function decoyBelongsToTranscriptProject(
  decoy: DecoyRecord,
  ctx: TranscriptProjectContext,
): boolean {
  if (!decoy.projectRoot) return false;
  const hint = ctx.projectHint?.trim();
  if (!hint) return false;

  if (ctx.adapterId === "cursor") {
    return (
      normalizeProjectIdentity(hint) ===
      normalizeProjectIdentity(decoy.projectRoot)
    );
  }

  if (ctx.adapterId === "claude-code") {
    // Prefer absolute cwd from the Claude record when present.
    if (isAbsoluteToolPath(hint) || path.isAbsolute(hint) || hint.startsWith("/")) {
      const mapped = mapGitBashStylePath(hint);
      return (
        normalizeToolPathForCompare(mapped) ===
        normalizeToolPathForCompare(decoy.projectRoot)
      );
    }
    return (
      normalizeProjectIdentity(hint) ===
      normalizeProjectIdentity(decoy.projectRoot)
    );
  }

  return false;
}

/**
 * Canonicalize when the file exists (realpathSync.native via path-util);
 * otherwise path.resolve for native absolutes. Windows-shaped paths on a
 * POSIX host are separator-normalized only — never resolved against cwd.
 * Relative paths are not resolved against cwd (UNVERIFIED appearance in logs).
 */
export function normalizeToolPathForCompare(toolPath: string): string {
  let trimmed = toolPath.trim();
  if (trimmed.length === 0) return "";

  // Git-Bash `/c/Users/...` → `C:/Users/...` before absolute checks.
  if (!isWindowsAbsolutePath(trimmed) && /^\/[A-Za-z]\//.test(trimmed.replace(/\\/g, "/"))) {
    trimmed = mapGitBashStylePath(trimmed);
  }

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
 * Relative tool paths match by basename / relative suffix only when the
 * caller has already project-scoped the decoy list.
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
    (rel.includes("/") === false && path.posix.basename(toolNorm) === rel);

  if (!endsWithRel) return false;

  if (!isAbsoluteToolPath(toolPath) && !/^\/[A-Za-z]\//.test(toolPath.replace(/\\/g, "/"))) {
    // Relative tool path (UNVERIFIED): basename/suffix only (project scope
    // enforced by findDecoyForToolPath when a transcript context is present).
    return true;
  }

  if (decoy.projectRoot) {
    const rootNorm = normalizeToolPathForCompare(decoy.projectRoot);
    if (underRoot(toolNorm, rootNorm)) return true;
    // Cross-platform fixture only: foreign Windows absolute on a POSIX host
    // vs a POSIX decoy root — roots cannot be compared, accept suffix.
    // On win32 (incl. after /c/ → C:/ map), projectRoot is required.
    if (process.platform !== "win32") {
      const toolIsWin = isWindowsAbsolutePath(toolPath) || isWindowsAbsolutePath(toolNorm);
      const rootIsWin = isWindowsAbsolutePath(decoy.projectRoot);
      if (toolIsWin !== rootIsWin) {
        return endsWithRel;
      }
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
  ctx?: TranscriptProjectContext,
): DecoyRecord | null {
  const relative =
    !isAbsoluteToolPath(toolPath) &&
    !/^\/[A-Za-z]\//.test(toolPath.replace(/\\/g, "/"));
  for (const d of decoys) {
    if (!pathRefersToDecoy(toolPath, d)) continue;
    // Relative paths are project-scoped when we know the transcript project.
    if (relative) {
      if (!ctx?.projectHint) continue;
      if (!decoyBelongsToTranscriptProject(d, ctx)) continue;
    }
    return d;
  }
  return null;
}

/**
 * True when `needle` appears in `command` as a whole path token: bounded by
 * start/end, whitespace, quotes, or path separators (`/` or `\`).
 */
export function commandHasBoundedPathToken(
  command: string,
  needle: string,
): boolean {
  if (needle.length === 0 || command.length === 0) return false;
  const cmd = fold(command);
  const n = fold(needle);
  // Search in both separator forms so `config\secrets…` matches `config/secrets…`.
  const variants = new Set([n, n.replace(/\//g, "\\"), n.replace(/\\/g, "/")]);

  for (const token of variants) {
    if (token.length === 0) continue;
    let from = 0;
    while (from <= cmd.length - token.length) {
      const idx = cmd.indexOf(token, from);
      if (idx === -1) break;
      const before = idx === 0 ? "" : cmd[idx - 1]!;
      const afterIdx = idx + token.length;
      const after = afterIdx >= cmd.length ? "" : cmd[afterIdx]!;
      const boundBefore =
        idx === 0 || /[\s"'/\\]/.test(before);
      const boundAfter =
        afterIdx >= cmd.length || /[\s"'/\\]/.test(after);
      if (boundBefore && boundAfter) return true;
      from = idx + 1;
    }
  }
  return false;
}

/**
 * Shell / Bash: flag when the command contains the decoy's basename or
 * project-relative path as a whole path token (case-insensitive on win32).
 * Caller must already restrict to decoys in the transcript's project.
 */
export function commandMentionsDecoy(
  command: string,
  decoy: DecoyRecord,
): boolean {
  if (command.trim().length === 0) return false;
  const rel = decoyProjectRelative(decoy);
  if (rel.length > 0 && commandHasBoundedPathToken(command, rel)) return true;
  const base = path.posix.basename(toPosixPath(decoy.path));
  if (base.length > 0 && commandHasBoundedPathToken(command, base)) return true;
  return false;
}

/**
 * First decoy mentioned in `command` that belongs to the transcript project.
 * If the project cannot be determined, returns null (no shell-mention).
 */
export function findDecoyMentionedInCommand(
  command: string,
  decoys: DecoyRecord[],
  ctx?: TranscriptProjectContext,
): DecoyRecord | null {
  if (!ctx?.projectHint) return null;
  for (const d of decoys) {
    if (!decoyBelongsToTranscriptProject(d, ctx)) continue;
    if (commandMentionsDecoy(command, d)) return d;
  }
  return null;
}
