import path from "node:path";
import { getHomeDir } from "../paths.js";
import type { LogAdapter, ParsedLine } from "./types.js";

/**
 * Claude Code transcript adapter.
 *
 * UNVERIFIED: The laptop spike (SPIKE-AND-SLICES.md §1) has not been run on
 * Prashant's machine. Path and JSONL shape below are taken from Claude Code's
 * publicly described layout (~/.claude/projects/<mangled-cwd>/<session>.jsonl)
 * and community format notes (tool results appear as type:"user" records with
 * message.content tool_result blocks; toolUseResult may be object or string).
 * Parser is intentionally tolerant and falls back to scanning the raw line
 * text so a shape drift still yields hits (kind "seen").
 */
export const CLAUDE_CODE_GLOB_REL = path.join(
  ".claude",
  "projects",
  "*",
  "*.jsonl",
);

export function claudeCodeGlob(home: string = getHomeDir()): string {
  return path.join(home, CLAUDE_CODE_GLOB_REL);
}

function sessionIdFromFile(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
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

function contentHasToolResult(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_result",
  );
}

function extractToolResultText(obj: Record<string, unknown>): string | null {
  const parts: string[] = [];

  // Common: message.content[] with tool_result blocks
  const message = obj.message;
  if (message !== null && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    if (contentHasToolResult(content)) {
      collectStrings(content, parts);
    }
  }

  // Alternate / companion field seen in some dumps
  if ("toolUseResult" in obj) {
    collectStrings(obj.toolUseResult, parts);
  }

  // Top-level content array of tool_result (defensive)
  if (contentHasToolResult(obj.content)) {
    collectStrings(obj.content, parts);
  }

  if (parts.length === 0) return null;
  return parts.join("\n");
}

function extractAnyText(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  collectStrings(obj, parts);
  return parts.join("\n");
}

export function parseClaudeCodeLine(
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
      tool: "claude-code",
      sessionId,
      timestamp: "",
      text: trimmed,
      isToolResult: false,
    };
  }

  if (parsed === null || typeof parsed !== "object") {
    return {
      tool: "claude-code",
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
    typeof obj.sessionId === "string"
      ? obj.sessionId
      : typeof obj.sessionID === "string"
        ? obj.sessionID
        : sessionId;

  const toolResultText = extractToolResultText(obj);
  if (toolResultText !== null) {
    return {
      tool: "claude-code",
      sessionId: sessionFromRecord,
      timestamp,
      text: toolResultText,
      isToolResult: true,
    };
  }

  // Assistant / user prose etc. — match against aggregated string fields.
  const text = extractAnyText(obj);
  return {
    tool: "claude-code",
    sessionId: sessionFromRecord,
    timestamp,
    text: text.length > 0 ? text : trimmed,
    isToolResult: false,
  };
}

export function createClaudeCodeAdapter(
  home: string = getHomeDir(),
): LogAdapter {
  return {
    id: "claude-code",
    name: "Claude Code",
    globs() {
      return [claudeCodeGlob(home)];
    },
    parse(line, filePath) {
      return parseClaudeCodeLine(line, filePath);
    },
  };
}
