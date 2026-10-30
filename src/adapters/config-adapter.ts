import path from "node:path";
import type { ConfigAdapterEntry } from "../config.js";
import { getHomeDir } from "../paths.js";
import type { LogAdapter, ParsedLine } from "./types.js";

function expandGlob(glob: string, home: string): string {
  if (glob.startsWith("~/") || glob === "~") {
    return path.join(home, glob.slice(2));
  }
  if (path.isAbsolute(glob)) return glob;
  return path.join(home, glob);
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

function parseJsonlLine(line: string, filePath: string, tool: string): ParsedLine {
  const sessionId = sessionIdFromFile(filePath);
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const parts: string[] = [];
      collectStrings(obj, parts);
      const isToolResult =
        JSON.stringify(obj).includes("tool_result") ||
        "toolUseResult" in obj;
      return {
        tool,
        sessionId:
          typeof obj.sessionId === "string" ? obj.sessionId : sessionId,
        timestamp: typeof obj.timestamp === "string" ? obj.timestamp : "",
        text: parts.length > 0 ? parts.join("\n") : line,
        isToolResult,
      };
    }
  } catch {
    // fall through to raw text
  }
  return {
    tool,
    sessionId,
    timestamp: "",
    text: line,
    isToolResult: false,
  };
}

export function createConfigAdapter(
  entry: ConfigAdapterEntry,
  index: number,
  home: string = getHomeDir(),
): LogAdapter {
  const id = `config:${entry.name ?? index}`;
  const tool = entry.name ?? `config-${index}`;
  const format = entry.format ?? "text";
  const absoluteGlob = expandGlob(entry.glob, home);

  return {
    id,
    name: entry.name ?? `config:${entry.glob}`,
    globs() {
      return [absoluteGlob];
    },
    parse(line, filePath) {
      if (format === "jsonl") {
        return parseJsonlLine(line, filePath, tool);
      }
      return {
        tool,
        sessionId: sessionIdFromFile(filePath),
        timestamp: "",
        text: line,
        isToolResult: false,
      };
    },
  };
}
