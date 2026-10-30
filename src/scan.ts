import { loadAdapters } from "./adapters/index.js";
import { runScanPass, type EngineHit } from "./engine.js";
import { EXIT } from "./exit-codes.js";
import type { NotifyFn } from "./notify.js";

export interface ScanReport {
  hits: EngineHit[];
  exitCode: number;
}

export interface RunScanOptions {
  /** Called for each new hit (CLI wires notifyHit unless --no-notify). */
  onHit?: NotifyFn | ((hit: EngineHit) => void);
}

/** One-shot pass over all known log sources. Exit code 1 when any hit. */
export async function runScan(
  options: RunScanOptions = {},
): Promise<ScanReport> {
  const adapters = await loadAdapters();
  const { hits } = await runScanPass({
    adapters,
    fromStart: true,
    seedFromHits: true,
  });
  for (const h of hits) {
    try {
      options.onHit?.(h);
    } catch (err) {
      console.warn(
        "tripwire: onHit failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return {
    hits,
    exitCode: hits.length > 0 ? EXIT.FAIL : EXIT.OK,
  };
}

export function formatScanReport(report: ScanReport): string {
  if (report.hits.length === 0) {
    return "scan: no hits";
  }
  const lines = [`scan: ${report.hits.length} hit(s)`];
  for (const h of report.hits) {
    lines.push(`  ${h.alertLine}`);
  }
  return lines.join("\n");
}
