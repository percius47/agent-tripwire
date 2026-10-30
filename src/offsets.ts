import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { PRIVATE_FILE_MODE } from "./fs-mode.js";
import { getOffsetsPath, getStateDir } from "./paths.js";

export interface FileOffset {
  /** Next byte to read. */
  offset: number;
  /** Incomplete trailing line carried to the next read. */
  partial: string;
}

export type OffsetsState = Record<string, FileOffset>;

export async function loadOffsets(): Promise<OffsetsState> {
  try {
    const raw = await readFile(getOffsetsPath(), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: OffsetsState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || typeof v !== "object") continue;
      const o = v as Record<string, unknown>;
      const offset = typeof o.offset === "number" && o.offset >= 0 ? o.offset : 0;
      const partial = typeof o.partial === "string" ? o.partial : "";
      out[k] = { offset, partial };
    }
    return out;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw err;
  }
}

export async function saveOffsets(state: OffsetsState): Promise<void> {
  await mkdir(getStateDir(), { recursive: true });
  const path = getOffsetsPath();
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  await chmod(path, PRIVATE_FILE_MODE);
}
