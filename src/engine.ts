import { glob } from "node:fs/promises";
import path from "node:path";
import type { LogAdapter } from "./adapters/types.js";
import { buildHitSnippet, appendHit, type HitKind, type HitRecord } from "./hits.js";
import { loadManifest, type DecoyRecord } from "./manifest.js";
import { buildTokenMatcher, type TokenMatcher } from "./match.js";
import {
  loadOffsets,
  saveOffsets,
  type FileOffset,
  type OffsetsState,
} from "./offsets.js";
import { getStateDir } from "./paths.js";
import { formatTokenLabel } from "./token-label.js";
import { readNewLines } from "./tail.js";

export interface EngineHit extends HitRecord {
  /** Stdout-safe alert line (never includes the full token). */
  alertLine: string;
}

export interface ProcessFileOptions {
  filePath: string;
  adapter: LogAdapter;
  matcher: TokenMatcher;
  offsets: OffsetsState;
  /** sessionKey → set of tokenIds already alerted. */
  seen: Map<string, Set<string>>;
  /** When true, persist offsets after this file. */
  persistOffsets?: boolean;
}

function dedupeKey(sessionId: string): string {
  return sessionId;
}

function formatAlert(hit: HitRecord): string {
  const label = formatTokenLabel(hit.tokenId);
  const kind = hit.kind === "read" ? "read" : "seen";
  return `Tripwire: ${hit.tool} ${kind} decoy ${hit.decoyPath} (${label}) in ${hit.sourceFile}`;
}

/**
 * Process new bytes for one log file. Updates offsets in-place.
 * Returns newly recorded hits (after per-token-per-session dedupe).
 */
export async function processFile(
  opts: ProcessFileOptions,
): Promise<EngineHit[]> {
  const { filePath, adapter, matcher, offsets, seen } = opts;
  const abs = path.resolve(filePath);

  // Never scan Tripwire's own state dir (avoids false hits on our files).
  const stateDir = path.resolve(getStateDir());
  if (abs === stateDir || abs.startsWith(stateDir + path.sep)) {
    return [];
  }

  const prev: FileOffset = offsets[abs] ?? { offset: 0, partial: "" };
  const { lines, next } = await readNewLines(abs, prev);
  offsets[abs] = next;

  const hits: EngineHit[] = [];

  for (const line of lines) {
    const parsed = adapter.parse(line, abs);
    if (!parsed) continue;
    const matches = matcher.findAll(parsed.text);
    for (const m of matches) {
      const session = parsed.sessionId || "unknown";
      let bag = seen.get(dedupeKey(session));
      if (!bag) {
        bag = new Set();
        seen.set(dedupeKey(session), bag);
      }
      if (bag.has(m.tokenId)) continue;
      bag.add(m.tokenId);

      const kind: HitKind = parsed.isToolResult ? "read" : "seen";
      const label = formatTokenLabel(m.tokenId);
      const hit: HitRecord = {
        at: new Date().toISOString(),
        tokenId: m.tokenId,
        kind,
        adapter: adapter.id,
        tool: parsed.tool,
        sessionId: session,
        sourceFile: abs,
        decoyPath: m.decoyPath,
        snippet: buildHitSnippet(parsed.text, m.value, label),
      };
      await appendHit(hit);
      hits.push({ ...hit, alertLine: formatAlert(hit) });
    }
  }

  if (opts.persistOffsets !== false) {
    await saveOffsets(offsets);
  }
  return hits;
}

/** Expand adapter globs to concrete existing (and pattern-matched) paths. */
export async function resolveAdapterFiles(
  adapter: LogAdapter,
): Promise<string[]> {
  const globs = await adapter.globs();
  const files = new Set<string>();
  for (const g of globs) {
    // node:fs/promises glob (Node >= 22) yields matching paths.
    for await (const p of glob(g)) {
      files.add(path.resolve(p));
    }
  }
  return [...files].sort();
}

export interface ScanOptions {
  adapters: LogAdapter[];
  decoys?: DecoyRecord[];
  /** Reset offsets to 0 for a full one-shot pass (default true for scan). */
  fromStart?: boolean;
}

/**
 * One-shot pass over all adapter sources. Does not start chokidar.
 * When fromStart is true, reads each file from offset 0 (scan semantics)
 * without clobbering persisted watch offsets unless persistWatchOffsets.
 */
export async function runScanPass(
  options: ScanOptions,
): Promise<{ hits: EngineHit[]; hitCount: number }> {
  const decoys = options.decoys ?? (await loadManifest()).decoys;
  const matcher = buildTokenMatcher(decoys);
  const fromStart = options.fromStart !== false;

  // Scan uses ephemeral offsets so it does not disturb the watcher's cursor,
  // unless the caller is the watch bootstrap (fromStart false).
  const offsets: OffsetsState = fromStart ? {} : await loadOffsets();
  const seen = new Map<string, Set<string>>();
  // Seed dedupe from nothing for scan; each scan is independent for exit code,
  // but still dedupe within the pass.
  const allHits: EngineHit[] = [];

  for (const adapter of options.adapters) {
    const files = await resolveAdapterFiles(adapter);
    for (const filePath of files) {
      if (fromStart) {
        offsets[path.resolve(filePath)] = { offset: 0, partial: "" };
      }
      const hits = await processFile({
        filePath,
        adapter,
        matcher,
        offsets,
        seen,
        persistOffsets: !fromStart,
      });
      allHits.push(...hits);
    }
  }

  return { hits: allHits, hitCount: allHits.length };
}

export function createSeenMap(): Map<string, Set<string>> {
  return new Map();
}

export async function loadMatcherFromManifest(): Promise<{
  decoys: DecoyRecord[];
  matcher: TokenMatcher;
}> {
  const { decoys } = await loadManifest();
  return { decoys, matcher: buildTokenMatcher(decoys) };
}
