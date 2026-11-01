import { open, stat } from "node:fs/promises";
import type { FileOffset } from "./offsets.js";

export interface TailResult {
  /** Complete lines (no trailing newline) read this pass. */
  lines: string[];
  /** Updated offset + partial for persistence. */
  next: FileOffset;
  /** True when size shrank and we reset to 0. */
  truncated: boolean;
}

/**
 * Read new bytes from `filePath` starting at `state.offset`.
 * Handles truncation/rotation (size < offset → reset to 0) and carries a
 * partial trailing line that has no newline yet.
 */
export async function readNewLines(
  filePath: string,
  state: FileOffset,
): Promise<TailResult> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { lines: [], next: { offset: 0, partial: "" }, truncated: false };
    }
    throw err;
  }

  let offset = state.offset;
  let partial = state.partial;
  let truncated = false;

  if (size < offset) {
    // Truncation or rotation — re-read from the start.
    offset = 0;
    partial = "";
    truncated = true;
  }

  if (size === offset) {
    return { lines: [], next: { offset, partial }, truncated };
  }

  const handle = await open(filePath, "r");
  try {
    const length = size - offset;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    const chunk = buf.subarray(0, bytesRead).toString("utf8");
    const combined = partial + chunk;
    const parts = combined.split("\n");
    // Last element is the incomplete trailing line (empty when chunk ended in \n).
    const nextPartial = parts.pop() ?? "";
    return {
      lines: parts,
      next: { offset: offset + bytesRead, partial: nextPartial },
      truncated,
    };
  } finally {
    await handle.close();
  }
}
