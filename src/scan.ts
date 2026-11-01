import { loadAdapters } from "./adapters/index.js";
import { runScanPass, type EngineHit } from "./engine.js";

export interface ScanReport {
  hits: EngineHit[];
  exitCode: number;
}

/** One-shot pass over all known log sources. Exit code 1 when any hit. */
export async function runScan(): Promise<ScanReport> {
  const adapters = await loadAdapters();
  const { hits } = await runScanPass({ adapters, fromStart: true });
  return {
    hits,
    exitCode: hits.length > 0 ? 1 : 0,
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
