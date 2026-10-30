import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const EXCLUDE_BEGIN = "# >>> agent-tripwire";
export const EXCLUDE_END = "# <<< agent-tripwire";

export interface GitRunner {
  revParseToplevel(cwd: string): Promise<string | null>;
  lsFiles(cwd: string, relPath: string): Promise<string[]>;
  checkIgnore(cwd: string, relPath: string): Promise<boolean>;
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const code = typeof e.code === "number" ? e.code : 1;
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      code,
    };
  }
}

export const defaultGitRunner: GitRunner = {
  async revParseToplevel(cwd) {
    const { stdout, code } = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (code !== 0) return null;
    const top = stdout.trim();
    return top.length > 0 ? top : null;
  },

  async lsFiles(cwd, relPath) {
    const { stdout, code } = await runGit(cwd, ["ls-files", "--", relPath]);
    if (code !== 0) return [];
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  },

  async checkIgnore(cwd, relPath) {
    const { code } = await runGit(cwd, ["check-ignore", "-q", "--", relPath]);
    return code === 0;
  },
};

export function excludeFilePath(gitRoot: string): string {
  return path.join(gitRoot, ".git", "info", "exclude");
}

export function toRepoRelative(gitRoot: string, absolutePath: string): string {
  const rel = path.relative(gitRoot, absolutePath);
  // gitignore-style paths use forward slashes
  return rel.split(path.sep).join("/");
}

/** Parse marked tripwire block; returns null if absent. */
export function parseExcludeBlock(content: string): {
  before: string;
  paths: string[];
  after: string;
} | null {
  const beginIdx = content.indexOf(EXCLUDE_BEGIN);
  const endIdx = content.indexOf(EXCLUDE_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    return null;
  }
  const before = content.slice(0, beginIdx);
  const after = content.slice(endIdx + EXCLUDE_END.length);
  const blockBody = content.slice(beginIdx + EXCLUDE_BEGIN.length, endIdx);
  const paths = blockBody
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  return { before, paths, after };
}

export function renderExcludeFile(
  before: string,
  paths: string[],
  after: string,
): string {
  const unique = [...new Set(paths)].sort();
  if (unique.length === 0) {
    // Drop the marked block entirely when empty.
    const left = before.replace(/\n+$/, "");
    const right = after.replace(/^\n+/, "");
    if (left.length === 0) return right.startsWith("\n") ? right : right ? `${right}` : "";
    if (right.length === 0) return left.endsWith("\n") ? left : `${left}\n`;
    return `${left.endsWith("\n") ? left : `${left}\n`}${right.startsWith("\n") ? right.slice(1) : right}`;
  }
  const block = `${EXCLUDE_BEGIN}\n${unique.join("\n")}\n${EXCLUDE_END}`;
  const left = before;
  let right = after;
  // Ensure a newline before the block if needed.
  const prefix =
    left.length === 0 || left.endsWith("\n") ? left : `${left}\n`;
  if (right.startsWith("\n")) {
    // keep
  } else if (right.length > 0) {
    right = `\n${right}`;
  } else {
    right = "\n";
  }
  return `${prefix}${block}${right}`;
}

export async function readExclude(gitRoot: string): Promise<string> {
  try {
    return await readFile(excludeFilePath(gitRoot), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw err;
  }
}

export async function writeExclude(gitRoot: string, content: string): Promise<void> {
  const file = excludeFilePath(gitRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

/** Add decoy relative paths into the marked exclude block. Returns previous content for rollback. */
export async function addExcludePaths(
  gitRoot: string,
  relPaths: string[],
): Promise<{ previous: string; next: string }> {
  const previous = await readExclude(gitRoot);
  const parsed = parseExcludeBlock(previous);
  const before = parsed?.before ?? (previous.endsWith("\n") || previous.length === 0 ? previous : `${previous}\n`);
  const after = parsed?.after ?? "";
  const existing = parsed?.paths ?? [];
  const nextPaths = [...existing, ...relPaths];
  const next = renderExcludeFile(before, nextPaths, after);
  await writeExclude(gitRoot, next);
  return { previous, next };
}

/** Remove specific paths from the marked block (or drop the block if empty). */
export async function removeExcludePaths(
  gitRoot: string,
  relPaths: string[],
): Promise<void> {
  const previous = await readExclude(gitRoot);
  const parsed = parseExcludeBlock(previous);
  if (!parsed) return;
  const removeSet = new Set(relPaths);
  const remaining = parsed.paths.filter((p) => !removeSet.has(p));
  const next = renderExcludeFile(parsed.before, remaining, parsed.after);
  await writeExclude(gitRoot, next);
}

/** Restore exclude file to a prior snapshot. */
export async function restoreExclude(gitRoot: string, previous: string): Promise<void> {
  if (previous.length === 0) {
    // If there was no file, write empty or leave — write empty exclude is fine.
    await writeExclude(gitRoot, "");
    return;
  }
  await writeExclude(gitRoot, previous);
}

export async function findTrackedDecoys(
  gitRoot: string,
  absolutePaths: string[],
  git: GitRunner = defaultGitRunner,
): Promise<string[]> {
  const tracked: string[] = [];
  for (const abs of absolutePaths) {
    const rel = toRepoRelative(gitRoot, abs);
    const files = await git.lsFiles(gitRoot, rel);
    if (files.length > 0) tracked.push(abs);
  }
  return tracked;
}

export async function verifyIgnored(
  gitRoot: string,
  absolutePaths: string[],
  git: GitRunner = defaultGitRunner,
): Promise<{ ignored: string[]; notIgnored: string[] }> {
  const ignored: string[] = [];
  const notIgnored: string[] = [];
  for (const abs of absolutePaths) {
    const rel = toRepoRelative(gitRoot, abs);
    const ok = await git.checkIgnore(gitRoot, rel);
    if (ok) ignored.push(abs);
    else notIgnored.push(abs);
  }
  return { ignored, notIgnored };
}
