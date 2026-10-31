import path from "node:path";
import { cursorProjectSlugFromLogPath } from "../path-match.js";
import { getHomeDir } from "../paths.js";
import type { LogAdapter, ParsedLine, PathSignal } from "./types.js";

/**
 * Cursor IDE agent-transcript adapter.
 *
 * Path and record shape confirmed on a real Windows 11 machine (read-only
 * field-name check). Transcripts live at
 * ~/.cursor/projects/<project-slug>/agent-transcripts/<session-uuid>/<session-uuid>.jsonl
 * (slug e.g. c-Users-Name-Documents-GitHub-LAMP). Sibling INDEX.md /
 * segment_*.md files are ignored (glob is *.jsonl only).
 *
 * Each line: {"role":"user"|"assistant","message":{"content":[blocks]}}.
 * Blocks observed: text, tool_use. There are NO tool_result blocks — file
 * contents are never logged — so detection is path-based (read-attempt /
 * write-attempt / shell-mention) plus a raw-line token scan if the agent
 * echoed a decoy token in text.
 *
 * No timestamp or sessionId fields were observed on records; sessionId is
 * derived from the <session-uuid> folder/file name. Hit timestamps use
 * detection time in the engine.
 *
 * Tool names / input keys seen: Read {path}, Grep {path}, StrReplace {path},
 * Write {path}, Shell {command}, Glob {glob_pattern, target_directory}, …
 */
export const CURSOR_GLOB_REL = path.join(
  ".cursor",
  "projects",
  "*",
  "agent-transcripts",
  "*",
  "*.jsonl",
);

export function cursorGlob(home: string = getHomeDir()): string {
  return path.join(home, CURSOR_GLOB_REL);
}

function sessionIdFromFile(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  if (base.length > 0) return base;
  const parent = path.basename(path.dirname(filePath));
  return parent.length > 0 ? parent : "unknown";
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

const READ_TOOLS = new Set(["Read", "Grep"]);
const WRITE_TOOLS = new Set(["StrReplace", "Write"]);

function extractPathSignals(obj: Record<string, unknown>): PathSignal[] {
  const signals: PathSignal[] = [];
  if (obj.role !== "assistant") return signals;

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

    const pushSignal = (sig: PathSignal): void => {
      signals.push(sig);
    };

    if (name === "Shell") {
      if (typeof input.command === "string") {
        const sig: PathSignal = {
          kind: "shell-mention",
          command: input.command,
          toolName: name,
        };
        if (id) sig.toolUseId = id;
        pushSignal(sig);
      }
      continue;
    }

    if (name === "Glob") {
      // Optional/simple: only when target_directory + pattern literally joins
      // to a path we can treat as a decoy candidate (engine matches).
      const pattern =
        typeof input.glob_pattern === "string" ? input.glob_pattern : "";
      const target =
        typeof input.target_directory === "string"
          ? input.target_directory
          : "";
      let toolPath: string | undefined;
      if (target.length > 0 && pattern.length > 0) {
        toolPath = path.win32.isAbsolute(target)
          ? path.win32.join(target, pattern)
          : path.posix.isAbsolute(target)
            ? path.posix.join(target, pattern)
            : path.join(target, pattern);
      } else if (
        pattern.length > 0 &&
        (path.isAbsolute(pattern) || /^[A-Za-z]:[\\/]/.test(pattern))
      ) {
        toolPath = pattern;
      }
      if (toolPath) {
        const sig: PathSignal = {
          kind: "read-attempt",
          toolPath,
          toolName: name,
        };
        if (id) sig.toolUseId = id;
        pushSignal(sig);
      }
      continue;
    }

    if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
      if (typeof input.path === "string") {
        const sig: PathSignal = {
          kind: WRITE_TOOLS.has(name) ? "write-attempt" : "read-attempt",
          toolPath: input.path,
          toolName: name,
        };
        if (id) sig.toolUseId = id;
        pushSignal(sig);
      }
    }
  }

  return signals;
}

export function parseCursorLine(
  line: string,
  filePath: string,
): ParsedLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const sessionId = sessionIdFromFile(filePath);
  const projectHint = cursorProjectSlugFromLogPath(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const fallback: ParsedLine = {
      tool: "cursor",
      sessionId,
      timestamp: "",
      text: trimmed,
      isToolResult: false,
    };
    if (projectHint) fallback.projectHint = projectHint;
    return fallback;
  }

  if (parsed === null || typeof parsed !== "object") {
    const fallback: ParsedLine = {
      tool: "cursor",
      sessionId,
      timestamp: "",
      text: trimmed,
      isToolResult: false,
    };
    if (projectHint) fallback.projectHint = projectHint;
    return fallback;
  }

  const obj = parsed as Record<string, unknown>;
  const pathSignals = extractPathSignals(obj);
  const parts: string[] = [];
  collectStrings(obj, parts);

  const result: ParsedLine = {
    tool: "cursor",
    sessionId,
    timestamp: "",
    text: parts.length > 0 ? parts.join("\n") : trimmed,
    // Cursor never logs tool_result / file contents.
    isToolResult: false,
  };
  if (projectHint) result.projectHint = projectHint;
  if (pathSignals.length > 0) result.pathSignals = pathSignals;
  return result;
}

export function createCursorAdapter(home: string = getHomeDir()): LogAdapter {
  return {
    id: "cursor",
    name: "Cursor IDE",
    globs() {
      return [cursorGlob(home)];
    },
    parse(line, filePath) {
      return parseCursorLine(line, filePath);
    },
  };
}
