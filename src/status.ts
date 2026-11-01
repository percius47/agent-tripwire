import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { loadAdapters, type LogAdapter } from "./adapters/index.js";
import { resolveAdapterFiles } from "./engine.js";
import { isGitRepo, isIgnored, toRepoRelative } from "./git-exclude.js";
import { loadHits, type HitRecord } from "./hits.js";
import { loadManifest, type DecoyRecord } from "./manifest.js";
import { sha256 } from "./plant.js";
import { formatTokenLabel } from "./token-label.js";

export interface StatusOptions {
  /** How many recent hits to show (default 10). */
  lastHits?: number;
}

export interface DecoyStatus {
  path: string;
  label: string;
  scope: "project" | "home";
  exists: boolean;
  hashMatch: boolean | null;
  gitIgnored: boolean | null;
}

export interface AdapterStatus {
  id: string;
  name: string;
  globs: string[];
  /** Whether each glob's watch root / any matching files exist. */
  pathExists: boolean;
  matchedFiles: number;
}

export interface StatusReport {
  decoys: DecoyStatus[];
  adapters: AdapterStatus[];
  hits: HitRecord[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function decoyStatus(d: DecoyRecord): Promise<DecoyStatus> {
  const label = formatTokenLabel(d.tokenId);
  let exists = false;
  let hashMatch: boolean | null = null;
  try {
    const body = await readFile(d.path);
    exists = true;
    hashMatch = sha256(body) === d.sha256;
  } catch {
    exists = false;
    hashMatch = null;
  }

  let gitIgnored: boolean | null = null;
  if (d.scope === "project" && d.projectRoot && isGitRepo(d.projectRoot)) {
    try {
      const rel = toRepoRelative(d.projectRoot, d.path);
      gitIgnored = isIgnored(d.projectRoot, rel);
    } catch {
      gitIgnored = null;
    }
  }

  return {
    path: d.path,
    label,
    scope: d.scope,
    exists,
    hashMatch,
    gitIgnored,
  };
}

async function adapterStatus(adapter: LogAdapter): Promise<AdapterStatus> {
  const globs = await adapter.globs();
  const files = await resolveAdapterFiles(adapter);
  let anyRoot = false;
  for (const g of globs) {
    // Existence of the glob's first concrete directory, or any matched file.
    const firstStar = g.search(/[*?]/);
    const rootGuess =
      firstStar === -1 ? g : g.slice(0, Math.max(0, g.lastIndexOf(path.sep, firstStar)));
    if (rootGuess && (await pathExists(rootGuess))) {
      anyRoot = true;
      break;
    }
  }
  return {
    id: adapter.id,
    name: adapter.name,
    globs,
    pathExists: anyRoot || files.length > 0,
    matchedFiles: files.length,
  };
}

/** Redact a hit for status stdout (never include full token). */
function formatHitLine(h: HitRecord): string {
  const label = formatTokenLabel(h.tokenId);
  return `${h.at} ${h.tool} ${h.kind} ${h.decoyPath} (${label}) session=${h.sessionId} file=${h.sourceFile}`;
}

export async function runStatus(
  options: StatusOptions = {},
): Promise<StatusReport> {
  const lastN = options.lastHits ?? 10;
  const manifest = await loadManifest();
  const decoys = await Promise.all(manifest.decoys.map(decoyStatus));
  const adapters = await Promise.all(
    (await loadAdapters()).map((a) => adapterStatus(a)),
  );
  const allHits = await loadHits();
  const hits = allHits.slice(-lastN);
  return { decoys, adapters, hits };
}

export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [];

  lines.push(`decoys: ${report.decoys.length}`);
  for (const d of report.decoys) {
    const exist = d.exists ? "exists" : "missing";
    const hash =
      d.hashMatch === null
        ? "hash=n/a"
        : d.hashMatch
          ? "hash=ok"
          : "hash=mismatch";
    const git =
      d.gitIgnored === null
        ? "git=n/a"
        : d.gitIgnored
          ? "git=ignored"
          : "git=NOT-ignored";
    lines.push(`  ${d.path} (${d.label}) [${d.scope}] ${exist} ${hash} ${git}`);
  }

  lines.push(`adapters: ${report.adapters.length}`);
  for (const a of report.adapters) {
    const exist = a.pathExists ? "path=present" : "path=absent";
    lines.push(
      `  ${a.id} (${a.name}) ${exist} files=${a.matchedFiles} globs=${a.globs.join(", ")}`,
    );
  }

  lines.push(`last hits: ${report.hits.length}`);
  for (const h of report.hits) {
    lines.push(`  ${formatHitLine(h)}`);
  }

  return lines.join("\n");
}

/** Ensure status text never embeds a full token id from the manifest. */
export function statusContainsFullToken(
  text: string,
  decoys: DecoyRecord[],
): boolean {
  for (const d of decoys) {
    if (text.includes(d.tokenId)) return true;
  }
  return false;
}
