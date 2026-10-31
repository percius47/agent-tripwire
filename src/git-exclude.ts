import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathsEqual } from "./path-util.js";

export const EXCLUDE_BEGIN = "# >>> agent-tripwire";
export const EXCLUDE_END = "# <<< agent-tripwire";

/** Normalize exclude file text to LF so markers / edits work with CRLF checkouts. */
function normalizeExcludeText(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function runGit(
  cwd: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    // Bound every git call so a stuck helper cannot freeze the suite.
    timeout: 15_000,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ASKPASS: "",
      GIT_EDITOR: "true",
      GC_AUTO: "0",
    },
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { status: 1, stdout: "", stderr: `git ${args.join(" ")} timed out` };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** True when `dir` is inside a git working tree. */
export function isGitRepo(dir: string): boolean {
  const r = runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
  return r.status === 0 && r.stdout.trim() === "true";
}

/** Absolute path of the git toplevel, or null. */
export function gitTopLevel(dir: string): string | null {
  const r = runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (r.status !== 0) return null;
  // Git-for-Windows often prints forward slashes / lowercase drive letters.
  return path.resolve(r.stdout.trim());
}

export function excludeFilePath(repoRoot: string): string {
  return path.join(repoRoot, ".git", "info", "exclude");
}

/** Paths relative to repo root that are already tracked. */
export function trackedPaths(repoRoot: string, relativePaths: string[]): string[] {
  if (relativePaths.length === 0) return [];
  const r = runGit(repoRoot, ["ls-files", "--", ...relativePaths]);
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** True when git considers `relativePath` ignored. */
export function isIgnored(repoRoot: string, relativePath: string): boolean {
  return checkIgnoreFn(repoRoot, relativePath);
}

function defaultCheckIgnore(repoRoot: string, relativePath: string): boolean {
  const r = runGit(repoRoot, ["check-ignore", "-q", "--", relativePath]);
  return r.status === 0;
}

let checkIgnoreFn: (repoRoot: string, relativePath: string) => boolean =
  defaultCheckIgnore;

/** Test-only seam to force check-ignore failures (rollback path). */
export function setCheckIgnoreForTests(
  fn: ((repoRoot: string, relativePath: string) => boolean) | null,
): void {
  checkIgnoreFn = fn ?? defaultCheckIgnore;
}

function stripOurBlock(content: string): string {
  const begin = content.indexOf(EXCLUDE_BEGIN);
  if (begin === -1) return content;
  const end = content.indexOf(EXCLUDE_END, begin);
  if (end === -1) {
    // Malformed: drop from begin marker to EOF
    return content.slice(0, begin).replace(/\n+$/, "");
  }
  const after = end + EXCLUDE_END.length;
  const before = content.slice(0, begin);
  let rest = content.slice(after);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  return (before.replace(/\n+$/, "") + (rest ? `\n${rest}` : "")).replace(/^\n+/, "");
}

/** Build a marked exclude block for the given relative paths (deduped, sorted). */
export function buildExcludeBlock(relativePaths: string[]): string {
  const unique = [...new Set(relativePaths)].sort();
  return [EXCLUDE_BEGIN, ...unique, EXCLUDE_END].join("\n");
}

/**
 * Write (or replace) the agent-tripwire exclude block with `relativePaths`.
 * Never touches .gitignore.
 */
export async function writeExcludeBlock(
  repoRoot: string,
  relativePaths: string[],
): Promise<string> {
  const excludePath = excludeFilePath(repoRoot);
  await mkdir(path.dirname(excludePath), { recursive: true });

  let existing = "";
  try {
    existing = normalizeExcludeText(await readFile(excludePath, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }

  const without = stripOurBlock(existing).replace(/\n+$/, "");
  const block = buildExcludeBlock(relativePaths);
  const next =
    relativePaths.length === 0
      ? without
      : without.length > 0
        ? `${without}\n${block}\n`
        : `${block}\n`;

  // Always write LF; git exclude accepts forward-slash paths + LF on Windows.
  await writeFile(excludePath, next.length > 0 ? next : "", "utf8");
  return excludePath;
}

/** Remove only the marked agent-tripwire exclude block. */
export async function stripExcludeBlock(repoRoot: string): Promise<boolean> {
  const excludePath = excludeFilePath(repoRoot);
  let existing: string;
  try {
    existing = normalizeExcludeText(await readFile(excludePath, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw err;
  }

  if (!existing.includes(EXCLUDE_BEGIN)) return false;
  const next = stripOurBlock(existing);
  const normalized = next.length > 0 && !next.endsWith("\n") ? `${next}\n` : next;
  await writeFile(excludePath, normalized, "utf8");
  return true;
}

export function toRepoRelative(repoRoot: string, absolutePath: string): string {
  const rel = path.relative(repoRoot, absolutePath);
  // git exclude / check-ignore prefer forward slashes
  return rel.split(path.sep).join("/");
}

/**
 * Resolve the working directory to the git toplevel when inside a repo.
 */
export function resolveProjectRoot(cwd: string): {
  projectRoot: string;
  fromSubdir: boolean;
  gitRepo: boolean;
} {
  const resolved = path.resolve(cwd);
  if (!isGitRepo(resolved)) {
    return { projectRoot: resolved, fromSubdir: false, gitRepo: false };
  }
  const top = gitTopLevel(resolved);
  if (!top) {
    return { projectRoot: resolved, fromSubdir: false, gitRepo: true };
  }
  const topResolved = path.resolve(top);
  const fromSubdir = !pathsEqual(topResolved, resolved);
  return { projectRoot: topResolved, fromSubdir, gitRepo: true };
}
