import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import path from "node:path";
import { loadAdapters, type LogAdapter } from "./adapters/index.js";
import {
  createSeenMap,
  loadMatcherFromManifest,
  processFile,
  resolveAdapterFiles,
  type EngineHit,
} from "./engine.js";
import { loadOffsets, saveOffsets, type OffsetsState } from "./offsets.js";
import type { TokenMatcher } from "./match.js";

export interface WatchHandle {
  /** Stop watching and flush offsets. */
  close(): Promise<void>;
  /** Promise that resolves when the watcher is ready (initial scan done). */
  ready: Promise<void>;
}

export interface WatchOptions {
  /** Called for each new hit (stdout printing is the CLI's job). */
  onHit?: (hit: EngineHit) => void;
  /** Override adapters (tests). */
  adapters?: LogAdapter[];
  /** When true, process existing file contents once at start (default true). */
  initialScan?: boolean;
}

function adapterForFile(
  filePath: string,
  adapters: LogAdapter[],
  globCache: Map<string, string[]>,
): LogAdapter | null {
  const abs = path.resolve(filePath);
  for (const adapter of adapters) {
    let globs = globCache.get(adapter.id);
    if (!globs) {
      // sync path: globs() is sync for our adapters
      const g = adapter.globs();
      if (Array.isArray(g)) {
        globs = g.map((x) => path.resolve(x));
        globCache.set(adapter.id, globs);
      } else {
        continue;
      }
    }
    for (const pattern of globs) {
      if (minimatchSimple(abs, pattern)) {
        return adapter;
      }
    }
  }
  return null;
}

/** Tiny glob matcher for absolute paths (`*` / `**` segments only). */
function minimatchSimple(filePath: string, pattern: string): boolean {
  const normFile = filePath.split(path.sep).join("/");
  const normPat = pattern.split(path.sep).join("/");
  const esc = (s: string) =>
    s.replace(/[.+^${}()|[\]\\]/g, (ch) => `\\${ch}`);
  const reBody = esc(normPat)
    .replace(/\\\*\\\*/g, "\0")
    .replace(/\\\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${reBody}$`).test(normFile);
}

/**
 * Foreground watcher: chokidar over adapter globs, byte-offset tail,
 * token match, dedupe, hits log. Desktop notifications are Run 4.
 */
export async function startWatch(
  options: WatchOptions = {},
): Promise<WatchHandle> {
  const adapters = options.adapters ?? (await loadAdapters());
  const { matcher } = await loadMatcherFromManifest();
  const offsets: OffsetsState = await loadOffsets();
  const seen = createSeenMap();
  const globCache = new Map<string, string[]>();
  const initialScan = options.initialScan !== false;

  const watchPaths: string[] = [];
  for (const a of adapters) {
    const g = await a.globs();
    watchPaths.push(...g);
    globCache.set(
      a.id,
      g.map((x) => path.resolve(x)),
    );
  }

  let closed = false;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (filePath: string) => {
    chain = chain
      .then(async () => {
        if (closed) return;
        const adapter = adapterForFile(filePath, adapters, globCache);
        if (!adapter) return;
        const hits = await processFile({
          filePath,
          adapter,
          matcher,
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

  const watcher: FSWatcher = chokidarWatch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    // Our globs may not exist yet (Claude projects dir absent until first use).
    ignorePermissionErrors: true,
  });

  watcher.on("add", (p) => {
    void enqueue(p);
  });
  watcher.on("change", (p) => {
    void enqueue(p);
  });

  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  watcher.on("ready", () => {
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
  });

  return {
    ready,
    async close() {
      closed = true;
      await chain;
      await watcher.close();
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
