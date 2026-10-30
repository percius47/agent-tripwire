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
import type { TokenMatcher } from "./match.js";

export interface WatchHandle {
  /** Stop watching and flush offsets. */
  close(): Promise<void>;
  /** Promise that resolves when the watcher is ready (initial scan done). */
  ready: Promise<void>;
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

/**
 * Foreground watcher: chokidar over adapter base directories (v4 has no glob
 * support), filter with minimatchSimple, byte-offset tail, token match,
 * dedupe, hits log. Rebuilds the matcher when manifest.json changes.
 */
export async function startWatch(
  options: WatchOptions = {},
): Promise<WatchHandle> {
  const adapters = options.adapters ?? (await loadAdapters());
  let { matcher } = await loadMatcherFromManifest();
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

  const enqueue = (filePath: string) => {
    chain = chain
      .then(async () => {
        if (closed) return;
        const abs = path.resolve(filePath);
        if (abs === manifestPath) {
          const loaded = await loadMatcherFromManifest();
          matcherRef = loaded.matcher;
          return;
        }
        const adapter = adapterForFile(filePath, adapters, globCache);
        if (!adapter) return;
        const hits = await processFile({
          filePath,
          adapter,
          matcher: matcherRef,
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

  const attach = (watcher: FSWatcher) => {
    watcher.on("add", (p) => {
      void enqueue(p);
    });
    watcher.on("change", (p) => {
      void enqueue(p);
    });
  };

  /** Resolve a watchable directory (create nothing under agent homes). */
  async function existingDir(p: string): Promise<string | null> {
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

  // chokidar v4: watch concrete directories, not glob strings.
  for (const spec of roots) {
    const root = await existingDir(spec.root);
    if (!root) continue;
    // If we walked up to an ancestor, drop depth limit so nested creates fire.
    const walkedUp = path.resolve(root) !== path.resolve(spec.root);
    const opts: Parameters<typeof chokidarWatch>[1] = {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
      ignorePermissionErrors: true,
    };
    if (!walkedUp && spec.depth !== undefined) {
      opts.depth = spec.depth;
    }
    const w = chokidarWatch(root, opts);
    attach(w);
    watchers.push(w);
  }

  // Manifest watcher (depth 0 — only the state dir files).
  const manifestWatcher = chokidarWatch(manifestDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    ignorePermissionErrors: true,
  });
  attach(manifestWatcher);
  watchers.push(manifestWatcher);

  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  // Ready when every watcher has emitted ready once.
  let pendingReady = watchers.length;
  const onOneReady = () => {
    pendingReady -= 1;
    if (pendingReady > 0) return;
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

  for (const w of watchers) {
    w.on("ready", onOneReady);
  }

  return {
    ready,
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
  offsets: OffsetsState;
  seen: Map<string, Set<string>>;
}): Promise<EngineHit[]> {
  return processFile({ ...opts, persistOffsets: true });
}

export { minimatchSimple, deriveWatchRoot };
