import path from "node:path";
import { getHomeDir } from "../paths.js";
import type { LogAdapter, ParsedLine } from "./types.js";

/**
 * Codex CLI session adapter.
 *
 * UNVERIFIED: The laptop spike (SPIKE-AND-SLICES.md §2) has not been run on
 * Prashant's machine, so the on-disk path and JSONL record shape below are
 * taken from Codex's publicly described rollout layout
 * (~/.codex/sessions/<date>/rollout-*.jsonl) and community/event dumps. Parser
 * is intentionally tolerant: recognize known tool-output shapes when present,
 * otherwise fall back to scanning the raw line text (kind "seen").
 */
export const CODEX_GLOB_REL = path.join(
  ".codex",
  "sessions",
  "**",
  "rollout-*.jsonl",
);

export function codexGlob(home: string = getHomeDir()): string {
  return path.join(home, CODEX_GLOB_REL);
}

export function codexSessionsRoot(home: string = getHomeDir()): string {
  return path.join(home, ".codex", "sessions");
}

function sessionIdFromFile(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  // rollout-YYYY-MM-DDThh-mm-ss-<id>.jsonl → prefer trailing id when present
  const m = /^rollout-.*-([A-Za-z0-9]+)$/.exec(base);
  if (m?.[1]) return m[1];
  return base.length > 0 ? base : "unknown";
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
}

/**
 * UNVERIFIED: best-known Codex tool-output markers in rollout JSONL.
 * function_call_output / tool_result / tool_output payloads mean the model
 * saw tool stdout (a token inside ⇒ kind "read").
 */
function extractToolOutputText(obj: Record<string, unknown>): string | null {
  const parts: string[] = [];

  const consider = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return false;
    const n = node as Record<string, unknown>;
    const t = n.type;
    if (
      t === "function_call_output" ||
      t === "tool_result" ||
      t === "tool_output" ||
      t === "function_call_result"
    ) {
      collectStrings(n, parts);
      return true;
    }
    // Nested payload wrappers common in rollout events
    if ("payload" in n && consider(n.payload)) return true;
    if ("item" in n && consider(n.item)) return true;
    return false;
  };

  consider(obj);

  // Also scan arrays of items if top-level is an event envelope
  if (Array.isArray(obj.items)) {
    for (const item of obj.items) consider(item);
  }
  if (obj.payload !== null && typeof obj.payload === "object") {
    const p = obj.payload as Record<string, unknown>;
    if (typeof p.output === "string" && p.type === "function_call_output") {
      parts.push(p.output);
    }
  }

  if (parts.length === 0) return null;
  return parts.join("\n");
}

function extractAnyText(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  collectStrings(obj, parts);
  return parts.join("\n");
}

export function parseCodexLine(
  line: string,
  filePath: string,
): ParsedLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const sessionId = sessionIdFromFile(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // UNVERIFIED fallback: non-JSON line — still scan raw text as "seen".
    return {
      tool: "codex",
      sessionId,
      timestamp: "",
      text: trimmed,
      isToolResult: false,
    };
  }

  if (parsed === null || typeof parsed !== "object") {
    return {
      tool: "codex",
      sessionId,
      timestamp: "",
      text: trimmed,
      isToolResult: false,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const timestamp =
    typeof obj.timestamp === "string"
      ? obj.timestamp
      : typeof obj.ts === "string"
        ? obj.ts
        : "";
  const sessionFromRecord =
    typeof obj.session_id === "string"
      ? obj.session_id
      : typeof obj.sessionId === "string"
        ? obj.sessionId
        : sessionId;

  const toolOut = extractToolOutputText(obj);
  if (toolOut !== null) {
    return {
      tool: "codex",
      sessionId: sessionFromRecord,
      timestamp,
      text: toolOut,
      isToolResult: true,
    };
  }

  const text = extractAnyText(obj);
  return {
    tool: "codex",
    sessionId: sessionFromRecord,
    timestamp,
    text: text.length > 0 ? text : trimmed,
    isToolResult: false,
  };
}

export function createCodexAdapter(home: string = getHomeDir()): LogAdapter {
  return {
    id: "codex",
    name: "Codex CLI",
    globs() {
      return [codexGlob(home)];
    },
    parse(line, filePath) {
      return parseCodexLine(line, filePath);
    },
  };
}
