import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

export const GITIGNORE_BEGIN = "# >>> agent-tripwire";
export const GITIGNORE_END = "# <<< agent-tripwire";

function normalizeText(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripOurBlock(content: string): string {
  const begin = content.indexOf(GITIGNORE_BEGIN);
  if (begin === -1) return content;
  const end = content.indexOf(GITIGNORE_END, begin);
  if (end === -1) {
    return content.slice(0, begin).replace(/\n+$/, "");
  }
  const after = end + GITIGNORE_END.length;
  const before = content.slice(0, begin);
  let rest = content.slice(after);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  return (before.replace(/\n+$/, "") + (rest ? `\n${rest}` : "")).replace(
    /^\n+/,
    "",
  );
}

export function buildGitignoreBlock(relativePaths: string[]): string {
  const unique = [...new Set([".tripwire/", ...relativePaths])].sort();
  return [GITIGNORE_BEGIN, ...unique, GITIGNORE_END].join("\n");
}

/**
 * Write or replace the marked agent-tripwire block in project `.gitignore`.
 * Preserves user content outside the block.
 */
export async function writeGitignoreBlock(
  projectRoot: string,
  relativePaths: string[],
): Promise<{ path: string; created: boolean }> {
  const giPath = path.join(projectRoot, ".gitignore");
  let existing = "";
  let created = false;
  try {
    existing = normalizeText(await readFile(giPath, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    created = true;
  }

  const without = stripOurBlock(existing).replace(/\n+$/, "");
  const block = buildGitignoreBlock(relativePaths);
  const next =
    without.length > 0 ? `${without}\n${block}\n` : `${block}\n`;

  await writeFile(giPath, next, "utf8");
  return { path: giPath, created };
}

/** Remove only the marked agent-tripwire block. Deletes file if it becomes empty and we created it. */
export async function stripGitignoreBlock(
  projectRoot: string,
  options: { deleteIfEmpty?: boolean } = {},
): Promise<{ stripped: boolean; deleted: boolean }> {
  const giPath = path.join(projectRoot, ".gitignore");
  let existing: string;
  try {
    existing = normalizeText(await readFile(giPath, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { stripped: false, deleted: false };
    throw err;
  }

  if (!existing.includes(GITIGNORE_BEGIN)) {
    return { stripped: false, deleted: false };
  }

  const next = stripOurBlock(existing);
  const normalized =
    next.length > 0 && !next.endsWith("\n") ? `${next}\n` : next;

  if (normalized.length === 0 && options.deleteIfEmpty === true) {
    await unlink(giPath);
    return { stripped: true, deleted: true };
  }

  await writeFile(giPath, normalized, "utf8");
  return { stripped: true, deleted: false };
}
