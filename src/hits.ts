import { appendFile, chmod, mkdir, open } from "node:fs/promises";
import { PRIVATE_FILE_MODE } from "./fs-mode.js";
import { getHitsPath, getStateDir } from "./paths.js";

export type HitKind = "read" | "seen";

export interface HitRecord {
  /** ISO timestamp. */
  at: string;
  /** Primary decoy token id (full — never print to stdout). */
  tokenId: string;
  kind: HitKind;
  /** Adapter id (claude-code, config:…). */
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
