import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
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

/** Byte-exact copy of the user's .gitignore taken before our first edit. */
function originalCopyPath(projectRoot: string): string {
  return path.join(projectRoot, ".tripwire", "gitignore.orig");
}

async function readRaw(p: string): Promise<Buffer | null> {
  try {
    return await readFile(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
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
  const rawBuf = await readRaw(giPath);
  const created = rawBuf === null;
  const raw = rawBuf?.toString("utf8") ?? "";
  // Keep the user's line endings (CRLF stays CRLF).
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";

  // Save the pristine original once, before we ever touch it.
  const orig = originalCopyPath(projectRoot);
  if (rawBuf !== null && !raw.includes(GITIGNORE_BEGIN) && (await readRaw(orig)) === null) {
    await mkdir(path.dirname(orig), { recursive: true });
    await writeFile(orig, rawBuf);
  }

  const without = stripOurBlock(normalizeText(raw)).replace(/\n+$/, "");
  const block = buildGitignoreBlock(relativePaths);
  const nextLf =
    without.length > 0 ? `${without}\n${block}\n` : `${block}\n`;
  const next = eol === "\r\n" ? nextLf.replace(/\n/g, "\r\n") : nextLf;

  await writeFile(giPath, next, "utf8");
  return { path: giPath, created };
}

/** Remove only the marked agent-tripwire block. Deletes file if it becomes empty and we created it. */
export async function stripGitignoreBlock(
  projectRoot: string,
  options: { deleteIfEmpty?: boolean } = {},
): Promise<{ stripped: boolean; deleted: boolean }> {
  const giPath = path.join(projectRoot, ".gitignore");
  const rawBuf = await readRaw(giPath);
  if (rawBuf === null) return { stripped: false, deleted: false };
  const raw = rawBuf.toString("utf8");
  const existing = normalizeText(raw);

  if (!existing.includes(GITIGNORE_BEGIN)) {
    return { stripped: false, deleted: false };
  }

  const next = stripOurBlock(existing);
  const normalizedLf =
    next.length > 0 && !next.endsWith("\n") ? `${next}\n` : next;

  // Byte-exact restore when the user didn't change anything outside our block.
  const origBuf = await readRaw(originalCopyPath(projectRoot));
  if (origBuf !== null) {
    const origNorm = normalizeText(origBuf.toString("utf8"));
    const trimEnd = (t: string) => t.replace(/\n+$/, "");
    if (trimEnd(origNorm) === trimEnd(normalizedLf)) {
      await writeFile(giPath, origBuf);
      return { stripped: true, deleted: false };
    }
  }
  const normalized = raw.includes("\r\n")
    ? normalizedLf.replace(/\n/g, "\r\n")
    : normalizedLf;

  if (normalized.length === 0 && options.deleteIfEmpty === true) {
    await unlink(giPath);
    return { stripped: true, deleted: true };
  }

  await writeFile(giPath, normalized, "utf8");
  return { stripped: true, deleted: false };
}
