/**
 * One parsed log line (or raw chunk) from an adapter.
 * `text` is what token matching runs against.
 * `isToolResult` distinguishes attribution: hit kind "read" vs "seen".
 * `pathSignals` feed path-based decoy matching (Cursor; also Claude tool_use).
 */

/** Path / shell attempt kinds (no file contents observed). */
export type PathSignalKind =
  | "read-attempt"
  | "write-attempt"
  | "shell-mention";

export interface PathSignal {
  kind: PathSignalKind;
  /** Absolute or relative path from the tool input (path kinds). */
  toolPath?: string;
  /** Shell / Bash command text (shell-mention). */
  command?: string;
  /** tool_use id when present (Claude / Cursor). */
  toolUseId?: string;
  /** Tool name (Read, Grep, Shell, …). */
  toolName?: string;
}

export interface ParsedLine {
  tool: string;
  sessionId: string;
  timestamp: string;
  text: string;
  /** True when the token appears inside a tool result payload. */
  isToolResult: boolean;
  /** Path/shell signals extracted from tool_use blocks (matched in the engine). */
  pathSignals?: PathSignal[];
  /**
   * When this line is a tool_result, the corresponding tool_use id (for
   * deduping a path attempt with a later token read).
   */
  toolUseId?: string;
  /**
   * Transcript project identity for path/shell scoping.
   * Cursor: project slug from the log path.
   * Claude Code: record `cwd` when present, else mangled projects/ slug.
   */
  projectHint?: string;
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
