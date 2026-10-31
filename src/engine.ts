import path from "node:path";
import type { LogAdapter, PathSignal } from "./adapters/types.js";
import { expandGlob } from "./glob-util.js";
import {
  appendHit,
  buildHitSnippet,
  hitDedupeKey,
  hitStrength,
  loadHits,
  seedSeenFromHits,
  type HitKind,
  type HitRecord,
  type HitSignal,
  type SeenBag,
} from "./hits.js";
import { loadManifest, type DecoyRecord } from "./manifest.js";
import { buildTokenMatcher, type TokenMatcher } from "./match.js";
import {
  loadOffsets,
  saveOffsets,
  type FileOffset,
  type OffsetsState,
} from "./offsets.js";
import {
  findDecoyForToolPath,
  findDecoyMentionedInCommand,
  type TranscriptProjectContext,
} from "./path-match.js";
import { getStateDir } from "./paths.js";
import { isPathInside, pathsEqual } from "./path-util.js";
import { formatTokenLabel } from "./token-label.js";
import { readNewLines } from "./tail.js";

export interface EngineHit extends HitRecord {
  /** Stdout-safe alert line (never includes the full token). */
  alertLine: string;
  /**
   * False when the match was already in `seen` / hits.jsonl (no append).
   * Omitted or true means this hit was newly recorded.
   */
  isNew?: boolean;
}

export interface ProcessFileOptions {
  filePath: string;
  adapter: LogAdapter;
  matcher: TokenMatcher;
  /** Active decoys — used for path/shell matching (default []). */
  decoys?: DecoyRecord[];
  offsets: OffsetsState;
  /**
   * adapter+sourceFile+sessionId → tokenId → strongest kind already alerted.
   * Token proof (`read`/`seen`) may upgrade an earlier path-only attempt.
   */
  seen: SeenBag;
  /** When true, persist offsets after this file. */
  persistOffsets?: boolean;
  /**
   * When true, also match a non-empty trailing partial line (file does not
   * end in a newline). Used by scan; watch waits for a complete line.
   */
  includeTrailingPartial?: boolean;
  /**
   * When true, matches already in `seen` are still returned with `isNew: false`
   * and are not appended to hits.jsonl. Used by scan so exit code 1 reflects
   * “logs still contain a decoy”, while dedupe only covers append + notify.
   */
  includeKnown?: boolean;
}

function formatAlert(hit: HitRecord): string {
  const label = formatTokenLabel(hit.tokenId);
  return `Tripwire: ${hit.tool} ${hit.kind} decoy ${hit.decoyPath} (${label}) in ${hit.sourceFile}`;
}

interface ResolvedPathHit {
  kind: HitKind;
  decoy: DecoyRecord;
  toolUseId?: string;
  snippetSource: string;
}

function resolvePathSignal(
  signal: PathSignal,
  decoys: DecoyRecord[],
  ctx: TranscriptProjectContext,
): ResolvedPathHit | null {
  if (signal.kind === "shell-mention") {
    if (typeof signal.command !== "string") return null;
    const decoy = findDecoyMentionedInCommand(signal.command, decoys, ctx);
    if (!decoy) return null;
    const out: ResolvedPathHit = {
      kind: "shell-mention",
      decoy,
      snippetSource: signal.command,
    };
    if (signal.toolUseId) out.toolUseId = signal.toolUseId;
    return out;
  }
  if (typeof signal.toolPath !== "string") return null;
  const decoy = findDecoyForToolPath(signal.toolPath, decoys, ctx);
  if (!decoy) return null;
  const out: ResolvedPathHit = {
    kind: signal.kind,
    decoy,
    snippetSource: signal.toolPath,
  };
  if (signal.toolUseId) out.toolUseId = signal.toolUseId;
  return out;
}

interface PendingPath {
  kind: HitKind;
  decoy: DecoyRecord;
  toolUseId: string;
  snippetSource: string;
  parsedTool: string;
  session: string;
  timestampHint: string;
}

function isPathOnlyKind(kind: HitKind): boolean {
  return (
    kind === "read-attempt" ||
    kind === "write-attempt" ||
    kind === "shell-mention"
  );
}

/**
 * Process new bytes for one log file. Updates offsets in-place.
 * Returns newly recorded hits (after adapter+sourceFile+session dedupe).
 *
 * Token matches and path signals are merged per decoy on the same line
 * (prefer token kind; record both signals). Path signals that share a
 * tool_use id with a later token match in the same processFile batch are
 * merged into one token hit. Across batches (live watch), a token hit
 * upgrades a weaker path-only hit for the same tokenId.
 */
export async function processFile(
  opts: ProcessFileOptions,
): Promise<EngineHit[]> {
  const { filePath, adapter, matcher, offsets, seen } = opts;
  const decoys = opts.decoys ?? [];
  const abs = path.resolve(filePath);

  // Never scan Tripwire's own state dir (avoids false hits on our files).
  const stateDir = path.resolve(getStateDir());
  if (pathsEqual(abs, stateDir) || isPathInside(stateDir, abs)) {
    return [];
  }

  const prev: FileOffset = offsets[abs] ?? { offset: 0, partial: "" };
  const { lines, next } = await readNewLines(abs, prev);
  offsets[abs] = next;

  const toProcess = [...lines];
  if (opts.includeTrailingPartial && next.partial.length > 0) {
    toProcess.push(next.partial);
  }

  const hits: EngineHit[] = [];
  /** toolUseId → pending path hit awaiting a token on the same id. */
  const pendingByToolUse = new Map<string, PendingPath>();

  const recordHit = async (args: {
    tokenId: string;
    kind: HitKind;
    tool: string;
    session: string;
    decoyPath: string;
    snippet: string;
    signals: HitSignal[];
    toolUseId?: string;
  }): Promise<void> => {
    const key = hitDedupeKey(adapter.id, abs, args.session);
    let bag = seen.get(key);
    if (!bag) {
      bag = new Map();
      seen.set(key, bag);
    }
    const prevKind = bag.get(args.tokenId);
    const signals = [...args.signals];
    // Upgrading a path-only row: keep both signals on the stronger alert.
    if (
      prevKind &&
      isPathOnlyKind(prevKind) &&
      hitStrength(args.kind) > hitStrength(prevKind) &&
      !signals.includes("path")
    ) {
      signals.push("path");
    }

    const base: HitRecord = {
      at: new Date().toISOString(),
      tokenId: args.tokenId,
      kind: args.kind,
      adapter: adapter.id,
      tool: args.tool,
      sessionId: args.session,
      sourceFile: abs,
      decoyPath: args.decoyPath,
      snippet: args.snippet,
      signals,
    };
    if (args.toolUseId) base.toolUseId = args.toolUseId;

    if (prevKind !== undefined) {
      if (hitStrength(args.kind) <= hitStrength(prevKind)) {
        if (opts.includeKnown) {
          hits.push({ ...base, alertLine: formatAlert(base), isNew: false });
        }
        return;
      }
      // Stronger kind: upgrade — append + alert again.
    }

    bag.set(args.tokenId, args.kind);
    await appendHit(base);
    hits.push({ ...base, alertLine: formatAlert(base), isNew: true });
  };

  for (const line of toProcess) {
    const parsed = adapter.parse(line, abs);
    if (!parsed) continue;
    const session = parsed.sessionId || "unknown";
    const tokenMatches = matcher.findAll(parsed.text);
    const projectCtx: TranscriptProjectContext = {
      adapterId: adapter.id,
    };
    if (parsed.projectHint) projectCtx.projectHint = parsed.projectHint;

    const pathResolved: ResolvedPathHit[] = [];
    for (const sig of parsed.pathSignals ?? []) {
      const r = resolvePathSignal(sig, decoys, projectCtx);
      if (r) pathResolved.push(r);
    }

    // tokenId → path hit on this line (for same-line merge)
    const pathByToken = new Map<string, ResolvedPathHit>();
    for (const r of pathResolved) {
      if (!pathByToken.has(r.decoy.tokenId)) {
        pathByToken.set(r.decoy.tokenId, r);
      }
    }

    const tokensHandled = new Set<string>();

    for (const m of tokenMatches) {
      tokensHandled.add(m.tokenId);
      const pathHit = pathByToken.get(m.tokenId);
      // Prefer token: consume pending path with same toolUseId or same decoy.
      let pending: PendingPath | undefined;
      if (parsed.toolUseId) {
        pending = pendingByToolUse.get(parsed.toolUseId);
        if (pending) pendingByToolUse.delete(parsed.toolUseId);
      }
      for (const [id, p] of [...pendingByToolUse]) {
        if (p.decoy.tokenId === m.tokenId) {
          pendingByToolUse.delete(id);
          pending = pending ?? p;
        }
      }

      // Also treat a weaker kind already in the seen bag as a path signal
      // (cross-batch upgrade after watch delivered tool_use separately).
      const key = hitDedupeKey(adapter.id, abs, session);
      const priorKind = seen.get(key)?.get(m.tokenId);

      const signals: HitSignal[] = ["token"];
      if (pathHit || pending || (priorKind && isPathOnlyKind(priorKind))) {
        signals.push("path");
      }

      const kind: HitKind = parsed.isToolResult ? "read" : "seen";
      const label = formatTokenLabel(m.tokenId);
      const hitArgs: {
        tokenId: string;
        kind: HitKind;
        tool: string;
        session: string;
        decoyPath: string;
        snippet: string;
        signals: HitSignal[];
        toolUseId?: string;
      } = {
        tokenId: m.tokenId,
        kind,
        tool: parsed.tool,
        session,
        decoyPath: m.decoyPath,
        snippet: buildHitSnippet(parsed.text, m.value, label),
        signals,
      };
      const useId =
        parsed.toolUseId ?? pathHit?.toolUseId ?? pending?.toolUseId;
      if (useId) hitArgs.toolUseId = useId;
      await recordHit(hitArgs);
    }

    for (const r of pathResolved) {
      if (tokensHandled.has(r.decoy.tokenId)) continue;
      // Defer path hits that carry a toolUseId so a later tool_result token
      // in this batch can merge (prefer token).
      if (r.toolUseId) {
        if (!pendingByToolUse.has(r.toolUseId)) {
          pendingByToolUse.set(r.toolUseId, {
            kind: r.kind,
            decoy: r.decoy,
            toolUseId: r.toolUseId,
            snippetSource: r.snippetSource,
            parsedTool: parsed.tool,
            session,
            timestampHint: parsed.timestamp,
          });
        }
        continue;
      }
      const label = formatTokenLabel(r.decoy.tokenId);
      await recordHit({
        tokenId: r.decoy.tokenId,
        kind: r.kind,
        tool: parsed.tool,
        session,
        decoyPath: r.decoy.path,
        snippet: r.snippetSource.slice(0, 200).split(r.decoy.tokenId).join(label),
        signals: ["path"],
      });
    }
  }

  // Flush path attempts that never got a matching token in this batch.
  for (const pending of pendingByToolUse.values()) {
    const label = formatTokenLabel(pending.decoy.tokenId);
    await recordHit({
      tokenId: pending.decoy.tokenId,
      kind: pending.kind,
      tool: pending.parsedTool,
      session: pending.session,
      decoyPath: pending.decoy.path,
      snippet: pending.snippetSource
        .slice(0, 200)
        .split(pending.decoy.tokenId)
        .join(label),
      signals: ["path"],
      toolUseId: pending.toolUseId,
    });
  }

  if (opts.persistOffsets !== false) {
    await saveOffsets(offsets);
  }
  return hits;
}

/** Expand adapter globs to concrete existing paths (manual walk, Node 20). */
export async function resolveAdapterFiles(
  adapter: LogAdapter,
): Promise<string[]> {
  const globs = await adapter.globs();
  const files = new Set<string>();
  for (const g of globs) {
    for (const p of await expandGlob(g)) {
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
  /**
   * Seed dedupe from existing hits.jsonl so a second scan does not append
   * duplicates or re-notify (default true).
   */
  seedFromHits?: boolean;
  /**
   * When true, still report matches already in hits.jsonl (`isNew: false`)
   * so scan can exit 1 while logs remain dirty (default false).
   */
  includeKnown?: boolean;
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
  const seedFromHits = options.seedFromHits !== false;
  const seen = seedFromHits
    ? seedSeenFromHits(await loadHits())
    : createSeenMap();
  const allHits: EngineHit[] = [];
  const includeKnown = options.includeKnown === true;

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
        decoys,
        offsets,
        seen,
        persistOffsets: !fromStart,
        includeTrailingPartial: fromStart,
        includeKnown,
      });
      allHits.push(...hits);
    }
  }

  return { hits: allHits, hitCount: allHits.length };
}

export function createSeenMap(): SeenBag {
  return new Map();
}

export async function loadMatcherFromManifest(): Promise<{
  decoys: DecoyRecord[];
  matcher: TokenMatcher;
}> {
  const { decoys } = await loadManifest();
  return { decoys, matcher: buildTokenMatcher(decoys) };
}
