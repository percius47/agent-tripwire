import path from "node:path";

/**
 * Path key for equality / prefix checks.
 * Windows paths are compared case-insensitively (NTFS); drive letter case
 * from git vs Node otherwise breaks startsWith / Set lookups.
 */
export function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function pathsEqual(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when `child` is `parent` or a descendant of `parent`. */
export function isPathInside(parent: string, child: string): boolean {
  const p = pathKey(parent);
  const c = pathKey(child);
  return c === p || c.startsWith(p + path.sep);
}
