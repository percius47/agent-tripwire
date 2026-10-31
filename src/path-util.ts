import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Expand Windows 8.3 short names (e.g. `RUNNER~1` → `runneradmin`) without
 * following symlinks. Leaf / intermediate symlinks stay as path segments so
 * plant-safety checks do not confuse `.env.backup` → `.env` with the real
 * credential file.
 */
export function canonicalizePathSync(p: string): string {
  const resolved = path.resolve(p);
  const suffix: string[] = [];
  let cur = resolved;
  for (;;) {
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) {
        suffix.unshift(path.basename(cur));
        const parent = path.dirname(cur);
        if (parent === cur) {
          return suffix.length === 0 ? resolved : path.join(resolved, ...suffix);
        }
        cur = parent;
        continue;
      }
      // Existing non-symlink: native realpath expands Windows 8.3 short names
      // (JS realpathSync alone often does not).
      const real = realpathSync.native(cur);
      return suffix.length === 0 ? real : path.join(real, ...suffix);
    } catch {
      suffix.unshift(path.basename(cur));
      const parent = path.dirname(cur);
      if (parent === cur) {
        return path.join(cur, ...suffix);
      }
      cur = parent;
    }
  }
}

/**
 * Path key for equality / prefix checks.
 * Windows: canonicalize (8.3, no symlink follow) + case-fold so git long
 * paths and Node short temp paths compare equal.
 */
export function pathKey(p: string): string {
  const resolved = canonicalizePathSync(p);
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
