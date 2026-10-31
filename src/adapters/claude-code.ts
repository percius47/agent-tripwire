import path from "node:path";
import { claudeProjectSlugFromLogPath } from "../path-match.js";
import { getHomeDir } from "../paths.js";
import type { LogAdapter, ParsedLine, PathSignal } from "./types.js";

/**
 * Claude Code transcript adapter.
 *
 * Record shape confirmed on a real Windows machine on Oct 31 2026 (read-only
 * check of ~/.claude/projects/... JSONL). Types seen: queue-operation, user,
 * attachment, ai-title, assistant, last-prompt. Tool results are type:"user"
 * records with keys parentUuid, isSidechain, promptId, type, message, uuid,
 * timestamp, toolUseResult, sourceToolAssistantUUID, userType, entrypoint,
 * cwd, sessionId, version, gitBranch (sometimes also toolDenialKind);
 * message.content contains tool_result blocks; assistant records include
 * tool_use with name:"Read". Live end-to-end tripwire detection on that
 * machine is still pending. Path layout remains
 * ~/.claude/projects/<mangled-cwd>/<session>.jsonl (mangled cwd may contain
 * spaces, e.g. C--Users-Name With Space-...). Parser is intentionally
 * tolerant and falls back to scanning the raw line text so a shape drift
 * still yields hits (kind "seen").
 *
 * Path-based matching: assistant tool_use Read/Write/Edit/Grep/… with
 * file_path / path / notebook_path, and Bash command mentions, are emitted
 * as pathSignals (read-attempt / write-attempt / shell-mention) in addition
 * to existing token-in-tool_result detection.
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

function extractToolUseIdFromResult(
  obj: Record<string, unknown>,
): string | undefined {
  const message = obj.message;
  if (message !== null && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          return b.tool_use_id;
        }
      }
    }
  }
  return undefined;
}

const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;
const WRITE_NAMES = new Set(["Write", "Edit", "NotebookEdit", "StrReplace"]);

function extractPathSignals(obj: Record<string, unknown>): PathSignal[] {
  const signals: PathSignal[] = [];
  const message = obj.message;
  if (message === null || typeof message !== "object") return signals;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return signals;

  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_use") continue;
    const name = typeof b.name === "string" ? b.name : "";
    const id = typeof b.id === "string" ? b.id : undefined;
    const input =
      b.input !== null && typeof b.input === "object"
        ? (b.input as Record<string, unknown>)
        : {};

    if (name === "Bash" || name === "Shell") {
      if (typeof input.command === "string") {
        const sig: PathSignal = {
          kind: "shell-mention",
          command: input.command,
          toolName: name,
        };
        if (id) sig.toolUseId = id;
        signals.push(sig);
      }
      continue;
    }

    for (const key of PATH_KEYS) {
      const v = input[key];
      if (typeof v === "string" && v.length > 0) {
        const sig: PathSignal = {
          kind: WRITE_NAMES.has(name) ? "write-attempt" : "read-attempt",
          toolPath: v,
          toolName: name,
        };
        if (id) sig.toolUseId = id;
        signals.push(sig);
        break;
      }
    }
  }

  return signals;
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
    // Non-JSON fallback: still scan raw text as "seen".
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

  const pathSignals = extractPathSignals(obj);
  const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
  const projectHint = cwd ?? claudeProjectSlugFromLogPath(filePath);

  const toolResultText = extractToolResultText(obj);
  if (toolResultText !== null) {
    const result: ParsedLine = {
      tool: "claude-code",
      sessionId: sessionFromRecord,
      timestamp,
      text: toolResultText,
      isToolResult: true,
    };
    const toolUseId = extractToolUseIdFromResult(obj);
    if (toolUseId) result.toolUseId = toolUseId;
    if (projectHint) result.projectHint = projectHint;
    if (pathSignals.length > 0) result.pathSignals = pathSignals;
    return result;
  }

  // Assistant / user prose etc. — match against aggregated string fields.
  const text = extractAnyText(obj);
  const result: ParsedLine = {
    tool: "claude-code",
    sessionId: sessionFromRecord,
    timestamp,
    text: text.length > 0 ? text : trimmed,
    isToolResult: false,
  };
  if (projectHint) result.projectHint = projectHint;
  if (pathSignals.length > 0) result.pathSignals = pathSignals;
  return result;
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
