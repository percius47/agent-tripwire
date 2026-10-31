import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadAdapters, type LogAdapter } from "./adapters/index.js";
import {
  createSeenMap,
  loadMatcherFromManifest,
  processFile,
  resolveAdapterFiles,
  type EngineHit,
} from "./engine.js";
import { deriveWatchRoot, minimatchSimple } from "./glob-util.js";
import { loadHits, seedSeenFromHits } from "./hits.js";
import { loadOffsets, saveOffsets, type OffsetsState } from "./offsets.js";
import { getManifestPath, getStateDir } from "./paths.js";
import { isPathInside, pathKey, pathsEqual } from "./path-util.js";
import type { TokenMatcher } from "./match.js";

export interface WatchHandle {
  /** Stop watching and flush offsets. */
  close(): Promise<void>;
  /** Promise that resolves when the watcher is ready (initial scan done). */
  ready: Promise<void>;
  /** Merged chokidar getWatched() across all watchers (for tests / status). */
  getWatched(): Record<string, string[]>;
  /** Underlying chokidar watchers (tests may emit 'error'). */
  watchers: FSWatcher[];
}

export interface WatchOptions {
  /** Called for each new hit (stdout printing / notify is the CLI's job). */
  onHit?: (hit: EngineHit) => void;
  /** Override adapters (tests). */
  adapters?: LogAdapter[];
  /** When true, process existing file contents once at start (default true). */
  initialScan?: boolean;
  /**
   * Seed dedupe from hits.jsonl so restart / overlapping scan does not
   * re-alert (default true).
   */
  seedFromHits?: boolean;
}

type ChokidarOpts = NonNullable<Parameters<typeof chokidarWatch>[1]>;

function adapterForFile(
  filePath: string,
  adapters: LogAdapter[],
  globCache: Map<string, string[]>,
): LogAdapter | null {
  const abs = path.resolve(filePath);
  for (const adapter of adapters) {
    let globs = globCache.get(adapter.id);
    if (!globs) continue;
    for (const pattern of globs) {
      if (minimatchSimple(abs, pattern)) {
        return adapter;
      }
    }
  }
  return null;
}

interface RootSpec {
  root: string;
  depth?: number;
}

function collectWatchRoots(
  adapters: LogAdapter[],
  globCache: Map<string, string[]>,
): RootSpec[] {
  const byRoot = new Map<string, number | undefined>();
  for (const a of adapters) {
    const globs = globCache.get(a.id) ?? [];
    for (const g of globs) {
      const derived = deriveWatchRoot(g);
      const root = path.resolve(derived.root);
      const prev = byRoot.get(root);
      if (prev === undefined && !byRoot.has(root)) {
        byRoot.set(root, derived.depth);
      } else if (derived.depth === undefined || prev === undefined) {
        // Unlimited wins.
        byRoot.set(root, undefined);
      } else {
        byRoot.set(root, Math.max(prev, derived.depth));
      }
    }
  }
  return [...byRoot.entries()].map(([root, depth]) =>
    depth === undefined ? { root } : { root, depth },
  );
}

/** Nearest existing directory at or above `p` (inclusive). */
async function nearestExistingDir(p: string): Promise<string | null> {
  let cur = path.resolve(p);
  for (;;) {
    try {
      const st = await stat(cur);
      if (st.isDirectory()) return cur;
    } catch {
      // walk up
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Foreground watcher: chokidar over adapter base directories (v4 has no glob
 * support), filter with minimatchSimple, byte-offset tail, token match,
 * dedupe, hits log. Rebuilds the matcher when manifest.json changes.
 *
 * Missing adapter roots (e.g. ~/.codex/sessions) watch the nearest existing
 * ancestor at depth 0 only — never recursively $HOME. When the next path
 * segment appears, the real root is attached with its normal depth.
 */
export async function startWatch(
  options: WatchOptions = {},
): Promise<WatchHandle> {
  const adapters = options.adapters ?? (await loadAdapters());
  let { matcher, decoys } = await loadMatcherFromManifest();
  const offsets: OffsetsState = await loadOffsets();
  const seedFromHits = options.seedFromHits !== false;
  const seen = seedFromHits
    ? seedSeenFromHits(await loadHits())
    : createSeenMap();
  const globCache = new Map<string, string[]>();
  const initialScan = options.initialScan !== false;

  for (const a of adapters) {
    const g = await a.globs();
    globCache.set(
      a.id,
      g.map((x) => path.resolve(x)),
    );
  }

  const roots = collectWatchRoots(adapters, globCache);
  const manifestPath = path.resolve(getManifestPath());
  const manifestDir = path.dirname(manifestPath);

  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let matcherRef: TokenMatcher = matcher;
  let decoysRef = decoys;

  const enqueue = (filePath: string) => {
    chain = chain
      .then(async () => {
        if (closed) return;
        const abs = path.resolve(filePath);
        if (pathsEqual(abs, manifestPath)) {
          const loaded = await loadMatcherFromManifest();
          matcherRef = loaded.matcher;
          decoysRef = loaded.decoys;
          return;
        }
        const adapter = adapterForFile(filePath, adapters, globCache);
        if (!adapter) return;
        const hits = await processFile({
          filePath,
          adapter,
          matcher: matcherRef,
          decoys: decoysRef,
          offsets,
          seen,
          persistOffsets: true,
        });
        for (const h of hits) {
          options.onHit?.(h);
        }
      })
      .catch((err: unknown) => {
        console.error(
          "tripwire watch error:",
          err instanceof Error ? err.message : err,
        );
      });
    return chain;
  };

  // Ensure state dir exists so we can watch manifest.json for matcher rebuilds.
  await mkdir(getStateDir(), { recursive: true });

  const watchers: FSWatcher[] = [];
  /** Paths already watched at their intended (non-pending) depth. */
  const activeRoots = new Set<string>();
  /** Paths watched at depth 0 while waiting for a missing adapter root. */
  const ancestorWatchers = new Map<string, FSWatcher>();
  /**
   * Pending adapter roots keyed by the depth-0 ancestor currently watched.
   * Keys are pathKey() so Windows drive-letter case from chokidar still hits.
   */
  const pendingByAncestor = new Map<
    string,
    { ancestorPath: string; specs: RootSpec[] }
  >();

  const hasActiveRoot = (root: string): boolean =>
    [...activeRoots].some((r) => pathsEqual(r, root));

  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  let initialPhase = true;
  let pendingReady = 0;
  let readySettled = false;

  const finishInitialReady = () => {
    if (readySettled) return;
    readySettled = true;
    initialPhase = false;
    void (async () => {
      if (initialScan) {
        for (const adapter of adapters) {
          const files = await resolveAdapterFiles(adapter);
          for (const f of files) {
            await enqueue(f);
          }
        }
      }
      resolveReady();
    })();
  };

  const onOneReady = () => {
    if (!initialPhase || readySettled) return;
    pendingReady -= 1;
    if (pendingReady <= 0) finishInitialReady();
  };

  const chokidarBase = (): ChokidarOpts => ({
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    ignorePermissionErrors: true,
  });

  const attach = (watcher: FSWatcher) => {
    watcher.on("add", (p) => {
      void enqueue(p);
      void onPathEvent(p);
    });
    watcher.on("addDir", (p) => {
      void onPathEvent(p);
    });
    watcher.on("change", (p) => {
      void enqueue(p);
    });
    watcher.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const code =
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        typeof (err as { code?: unknown }).code === "string"
          ? (err as { code: string }).code
          : undefined;
      console.warn(
        `tripwire: watcher error${code ? ` (${code})` : ""}: ${msg}`,
      );
      // Keep running — ENOSPC / EMFILE / EPERM must not crash the process.
    });
  };

  /**
   * Create a watcher. During the initial sync batch, `countReady` registers
   * the ready listener immediately (no await between create and on('ready')).
   * Post-ready promotions pass countReady=false.
   */
  const addWatcher = (
    watchPath: string,
    opts: ChokidarOpts,
    countReady: boolean,
  ): FSWatcher => {
    const w = chokidarWatch(watchPath, opts);
    attach(w);
    watchers.push(w);
    if (countReady) {
      pendingReady += 1;
      w.on("ready", onOneReady);
    }
    return w;
  };

  async function scanRootFiles(spec: RootSpec): Promise<void> {
    for (const adapter of adapters) {
      const files = await resolveAdapterFiles(adapter);
      for (const f of files) {
        const abs = path.resolve(f);
        if (isPathInside(path.resolve(spec.root), abs)) {
          await enqueue(f);
        }
      }
    }
  }

  function clearPending(spec: RootSpec): void {
    const root = path.resolve(spec.root);
    for (const [ancKey, entry] of pendingByAncestor) {
      const next = entry.specs.filter(
        (s) => !pathsEqual(path.resolve(s.root), root),
      );
      if (next.length === 0) pendingByAncestor.delete(ancKey);
      else pendingByAncestor.set(ancKey, { ...entry, specs: next });
    }
  }

  async function attachRealRoot(
    spec: RootSpec,
    countReady: boolean,
  ): Promise<void> {
    const root = path.resolve(spec.root);
    if (closed || hasActiveRoot(root)) return;
    try {
      const st = await stat(root);
      if (!st.isDirectory()) return;
    } catch {
      return;
    }

    const opts = chokidarBase();
    if (spec.depth !== undefined) {
      opts.depth = spec.depth;
    }
    addWatcher(root, opts, countReady);
    activeRoots.add(root);
    clearPending(spec);

    // After promotion (post-ready), scan existing matching files once.
    if (!countReady) {
      await scanRootFiles(spec);
    }
  }

  function attachAncestorDepth0(
    ancestor: string,
    spec: RootSpec,
    countReady: boolean,
  ): void {
    const anc = path.resolve(ancestor);
    const ancKey = pathKey(anc);
    const existing = pendingByAncestor.get(ancKey);
    const list = existing?.specs ?? [];
    if (!list.some((s) => pathsEqual(path.resolve(s.root), path.resolve(spec.root)))) {
      list.push(spec);
      pendingByAncestor.set(ancKey, { ancestorPath: anc, specs: list });
    }
    if (ancestorWatchers.has(ancKey)) return;

    const w = addWatcher(anc, { ...chokidarBase(), depth: 0 }, countReady);
    ancestorWatchers.set(ancKey, w);
  }

  /**
   * A path appeared under a depth-0 ancestor. If it is the next segment toward
   * a pending root, either promote the real root or advance the ancestor.
   */
  async function onPathEvent(eventPath: string): Promise<void> {
    if (closed) return;
    const abs = path.resolve(eventPath);
    for (const [ancestorKey, entry] of [...pendingByAncestor.entries()]) {
      const { ancestorPath, specs } = entry;
      if (!isPathInside(ancestorPath, abs)) {
        continue;
      }
      for (const spec of [...specs]) {
        const desired = path.resolve(spec.root);
        if (
          !pathsEqual(abs, desired) &&
          !isPathInside(abs, desired) &&
          !isPathInside(desired, abs)
        ) {
          continue;
        }

        try {
          const st = await stat(desired);
          if (st.isDirectory()) {
            await attachRealRoot(spec, false);
            continue;
          }
        } catch {
          // desired still missing
        }

        // Next segment toward desired appeared — watch it at depth 0.
        if (!pathsEqual(abs, ancestorPath) && isPathInside(abs, desired)) {
          const remaining =
            pendingByAncestor.get(ancestorKey)?.specs.filter(
              (s) => !pathsEqual(path.resolve(s.root), desired),
            ) ?? [];
          if (remaining.length === 0) pendingByAncestor.delete(ancestorKey);
          else {
            pendingByAncestor.set(ancestorKey, {
              ancestorPath,
              specs: remaining,
            });
          }
          attachAncestorDepth0(abs, spec, false);
        }
      }
    }
  }

  // Plan with awaits, then create every initial watcher in one sync stretch so
  // ready listeners are registered before chokidar can emit ready.
  const planned: Array<
    | { kind: "real"; spec: RootSpec }
    | { kind: "ancestor"; ancestor: string; spec: RootSpec }
  > = [];

  for (const spec of roots) {
    const desired = path.resolve(spec.root);
    let exists = false;
    try {
      const st = await stat(desired);
      exists = st.isDirectory();
    } catch {
      exists = false;
    }
    if (exists) {
      planned.push({ kind: "real", spec });
    } else {
      const ancestor = await nearestExistingDir(path.dirname(desired));
      if (ancestor) {
        planned.push({ kind: "ancestor", ancestor, spec });
      }
    }
  }

  for (const item of planned) {
    if (item.kind === "real") {
      const root = path.resolve(item.spec.root);
      if (hasActiveRoot(root)) continue;
      const opts = chokidarBase();
      if (item.spec.depth !== undefined) {
        opts.depth = item.spec.depth;
      }
      addWatcher(root, opts, true);
      activeRoots.add(root);
    } else {
      attachAncestorDepth0(item.ancestor, item.spec, true);
    }
  }

  // Manifest watcher (depth 0 — only the state dir files).
  addWatcher(manifestDir, { ...chokidarBase(), depth: 0 }, true);

  if (pendingReady === 0) {
    finishInitialReady();
  }

  return {
    ready,
    watchers,
    getWatched() {
      const out: Record<string, string[]> = {};
      for (const w of watchers) {
        const gw = w.getWatched();
        for (const [dir, children] of Object.entries(gw)) {
          const prev = out[dir] ?? [];
          out[dir] = [...new Set([...prev, ...children])];
        }
      }
      return out;
    },
    async close() {
      closed = true;
      await chain;
      await Promise.all(watchers.map((w) => w.close()));
      await saveOffsets(offsets);
    },
  };
}

/** Test helper: process one file through the watch pipeline without chokidar. */
export async function processWatchFileForTests(opts: {
  filePath: string;
  adapter: LogAdapter;
  matcher: TokenMatcher;
  decoys?: import("./manifest.js").DecoyRecord[];
  offsets: OffsetsState;
  seen: Map<string, Set<string>>;
}): Promise<EngineHit[]> {
  return processFile({ ...opts, persistOffsets: true });
}

export { minimatchSimple, deriveWatchRoot };
