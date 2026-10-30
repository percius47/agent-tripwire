/**
 * One parsed log line (or raw chunk) from an adapter.
 * `text` is what token matching runs against.
 * `isToolResult` distinguishes attribution: hit kind "read" vs "seen".
 */
export interface ParsedLine {
  tool: string;
  sessionId: string;
  timestamp: string;
  text: string;
  /** True when the token appears inside a tool result payload. */
  isToolResult: boolean;
}

export interface LogAdapter {
  /** Short stable id (e.g. "claude-code", "config:my-logs"). */
  id: string;
  /** Human label for alerts. */
  name: string;
  /** Absolute globs chokidar / scan should watch. */
  globs(): string[] | Promise<string[]>;
  /** Parse one complete line (no trailing newline). */
  parse(line: string, filePath: string): ParsedLine | null;
}
