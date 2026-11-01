import { loadAdapters } from "./adapters/index.js";
import { runScanPass, type EngineHit } from "./engine.js";
import { EXIT } from "./exit-codes.js";
import type { NotifyFn } from "./notify.js";

export interface ScanReport {
  hits: EngineHit[];
  /** Hits that were newly appended (for notify). */
  newHits: EngineHit[];
  exitCode: number;
}

export interface RunScanOptions {
  /** Called for each new hit (CLI wires notifyHit unless --no-notify). */
  onHit?: NotifyFn | ((hit: EngineHit) => void);
  /**
   * When true, exit 1 only for hits not already in hits.jsonl (legacy).
   * Default false: exit 1 whenever scanned logs still contain a decoy token.
   */
  newOnly?: boolean;
}

/**
 * One-shot pass over all known log sources.
 * Exit code 1 when any decoy is present in the logs (unless --new-only).
 * Dedupe only affects hits.jsonl append and notifications.
 */
export async function runScan(
  options: RunScanOptions = {},
): Promise<ScanReport> {
  const newOnly = options.newOnly === true;
  const adapters = await loadAdapters();
  const { hits } = await runScanPass({
    adapters,
    fromStart: true,
    seedFromHits: true,
    includeKnown: !newOnly,
  });
  const newHits = hits.filter((h) => h.isNew !== false);
  for (const h of newHits) {
    try {
      options.onHit?.(h);
    } catch (err) {
      console.warn(
        "tripwire: onHit failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const reported = newOnly ? newHits : hits;
  return {
    hits: reported,
    newHits,
    exitCode: reported.length > 0 ? EXIT.FAIL : EXIT.OK,
  };
}

export function formatScanReport(report: ScanReport): string {
  if (report.hits.length === 0) {
    return "scan: no hits";
  }
  const lines = [`scan: ${report.hits.length} hit(s)`];
  for (const h of report.hits) {
    const suffix = h.isNew === false ? " (known)" : "";
    lines.push(`  ${h.alertLine}${suffix}`);
  }
  return lines.join("\n");
}
