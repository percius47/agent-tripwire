import { appendFile, chmod, mkdir, open, readFile } from "node:fs/promises";
import { PRIVATE_FILE_MODE } from "./fs-mode.js";
import { getHitsPath, getStateDir } from "./paths.js";

export type HitKind =
  | "read"
  | "seen"
  | "read-attempt"
  | "write-attempt"
  | "shell-mention";

/** How the decoy was detected (token in content vs path/shell mention). */
export type HitSignal = "token" | "path";

export interface HitRecord {
  /** ISO timestamp. */
  at: string;
  /** Primary decoy token id (full — never print to stdout). */
  tokenId: string;
  kind: HitKind;
  /** Adapter id (claude-code, cursor, config:…). */
  adapter: string;
  /** Tool label for alerts. */
  tool: string;
  sessionId: string;
  /** Log file where the token was found. */
  sourceFile: string;
  /** Decoy file that owns the token. */
  decoyPath: string;
  /** Redacted snippet ≤ 200 chars (token replaced with label). */
  snippet: string;
  /** Detection signals present on this hit (token and/or path). */
  signals?: HitSignal[];
  /** tool_use id when known (dedupe path + token for one tool call). */
  toolUseId?: string;
}

/** Dedupe bag key: adapter + sourceFile + sessionId (not session alone). */
export function hitDedupeKey(
  adapter: string,
  sourceFile: string,
  sessionId: string,
): string {
  return `${adapter}\0${sourceFile}\0${sessionId}`;
}

/**
 * Relative strength (token proof > path attempts > shell-mention). Kept for
 * callers/tests; live dedupe is per distinct kind, not strongest-only.
 */
export function hitStrength(kind: HitKind): number {
  switch (kind) {
    case "read":
    case "seen":
      return 3;
    case "read-attempt":
    case "write-attempt":
      return 2;
    case "shell-mention":
      return 1;
    default:
      return 0;
  }
}

/** adapter+file+session → tokenId → kinds already recorded for that decoy. */
export type SeenBag = Map<string, Map<string, Set<HitKind>>>;

/** Load all hit records from hits.jsonl (missing file → []). */
export async function loadHits(): Promise<HitRecord[]> {
  try {
    const raw = await readFile(getHitsPath(), "utf8");
    const out: HitRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === "object") {
          const h = parsed as HitRecord;
          if (
            typeof h.tokenId === "string" &&
            typeof h.sourceFile === "string" &&
            typeof h.sessionId === "string" &&
            typeof h.adapter === "string"
          ) {
            out.push(h);
          }
        }
      } catch {
        // skip corrupt lines
      }
    }
    return out;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Seed in-memory dedupe from persisted hits (each kind per tokenId per
 * adapter/file/session). A prior path-only row must not block a later token
 * `read`/`seen` or a distinct path kind such as `shell-mention`.
 */
export function seedSeenFromHits(hits: HitRecord[]): SeenBag {
  const seen: SeenBag = new Map();
  for (const h of hits) {
    const key = hitDedupeKey(h.adapter, h.sourceFile, h.sessionId);
    let bag = seen.get(key);
    if (!bag) {
      bag = new Map();
      seen.set(key, bag);
    }
    let kinds = bag.get(h.tokenId);
    if (!kinds) {
      kinds = new Set();
      bag.set(h.tokenId, kinds);
    }
    kinds.add(h.kind);
  }
  return seen;
}

function redactSnippet(text: string, tokenValue: string, label: string): string {
  const replaced = text.split(tokenValue).join(label);
  const flat = replaced.replace(/\s+/g, " ").trim();
  if (flat.length <= 200) return flat;
  return `${flat.slice(0, 197)}...`;
}

export function buildHitSnippet(
  text: string,
  tokenValue: string,
  label: string,
): string {
  const idx = text.indexOf(tokenValue);
  if (idx === -1) return redactSnippet(text.slice(0, 200), tokenValue, label);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + tokenValue.length + 40);
  return redactSnippet(text.slice(start, end), tokenValue, label);
}

/** Append one hit line to hits.jsonl (0600). Creates the file if needed. */
export async function appendHit(hit: HitRecord): Promise<void> {
  await mkdir(getStateDir(), { recursive: true });
  const hitsPath = getHitsPath();
  // Ensure file exists with 0600 before append (appendFile mode is create-only).
  try {
    const handle = await open(hitsPath, "a", PRIVATE_FILE_MODE);
    await handle.close();
    await chmod(hitsPath, PRIVATE_FILE_MODE);
  } catch {
    // open/chmod race is fine; append still proceeds
  }
  await appendFile(hitsPath, `${JSON.stringify(hit)}\n`, "utf8");
  await chmod(hitsPath, PRIVATE_FILE_MODE);
}
