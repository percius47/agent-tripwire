import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Tiny glob matcher for absolute paths (`*` / `**` segments only).
 * Used to filter chokidar events and to walk adapter globs without fs.glob
 * (Node 20-compatible).
 */
export function minimatchSimple(filePath: string, pattern: string): boolean {
  const normFile = filePath.split(path.sep).join("/");
  const normPat = pattern.split(path.sep).join("/");
  // Protect wildcards before escaping regex metacharacters (otherwise `**`
  // becomes an invalid quantifier and `*` binds to the previous char).
  const DD = "\u0000DD\u0000";
  const ST = "\u0000ST\u0000";
  const protectedPat = normPat.replace(/\*\*/g, DD).replace(/\*/g, ST);
  const escaped = protectedPat.replace(/[.+^${}()|[\]\\]/g, (ch) => `\\${ch}`);
  const reBody = escaped.replaceAll(DD, ".*").replaceAll(ST, "[^/]*");
  return new RegExp(`^${reBody}$`).test(normFile);
}

export interface DerivedWatchRoot {
  /** Directory to hand to chokidar (v4 has no glob support). */
  root: string;
  /**
   * Max depth below `root` (files at depth 1 are direct children).
   * `undefined` means recursive (pattern used `**`).
   */
  depth?: number;
}

/**
 * Derive a chokidar watch root + depth from a glob.
 * Everything before the first wildcard segment is the root; each remaining
 * path segment (including `*` or a literal filename pattern) counts toward
 * depth, unless `**` appears (unlimited).
 */
export function deriveWatchRoot(globPattern: string): DerivedWatchRoot {
  const normalized = path.normalize(globPattern);
  const parts = normalized.split(path.sep);
  const rootParts: string[] = [];
  let hitWildcard = false;
  let recursive = false;
  let after = 0;

  for (const part of parts) {
    if (!hitWildcard && !part.includes("*") && !part.includes("?")) {
      rootParts.push(part);
      continue;
    }
    hitWildcard = true;
    if (part === "**") {
      recursive = true;
    } else {
      after += 1;
    }
  }

  // Absolute Unix paths begin with "" after split; path.join restores "/…".
  const root =
    rootParts.length === 0
      ? path.parse(normalized).root || "."
      : rootParts.join(path.sep);

  return {
    root: root.length > 0 ? root : ".",
    ...(recursive ? {} : { depth: after }),
  };
}

async function walkDir(
  dir: string,
  depthLeft: number | undefined,
  onFile: (abs: string) => void,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return;
    throw err;
  }

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    // Dirent may not follow symlinks; stat when type is unclear.
    if (!isDir && !isFile) {
      try {
        const st = await stat(abs);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isFile) {
      onFile(abs);
      continue;
    }
    if (!isDir) continue;
    if (depthLeft === undefined) {
      await walkDir(abs, undefined, onFile);
    } else if (depthLeft > 1) {
      await walkDir(abs, depthLeft - 1, onFile);
    }
  }
}

/** Expand one glob to existing file paths (Node >= 20; no fs.glob). */
export async function expandGlob(globPattern: string): Promise<string[]> {
  const absPattern = path.resolve(globPattern);
  // Literal path (no wildcards): accept an existing file directly.
  if (!absPattern.includes("*") && !absPattern.includes("?")) {
    try {
      const st = await stat(absPattern);
      if (st.isFile()) return [absPattern];
    } catch {
      // missing
    }
    return [];
  }

  const { root, depth } = deriveWatchRoot(absPattern);
  const out: string[] = [];
  await walkDir(root, depth, (abs) => {
    if (minimatchSimple(abs, absPattern)) {
      out.push(abs);
    }
  });
  return out.sort();
}
