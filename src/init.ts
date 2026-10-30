import path from "node:path";
import { homeDecoyPlans, projectDecoyPlans } from "./decoys.js";
import { loadManifest, saveManifest } from "./manifest.js";
import { plantPlans, type PlantResult } from "./plant.js";

export interface InitOptions {
  projectRoot?: string;
  home?: boolean;
}

export interface InitReport {
  projectRoot: string;
  home: boolean;
  project: PlantResult;
  homeResult?: PlantResult;
}

export async function runInit(options: InitOptions = {}): Promise<InitReport> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const includeHome = options.home === true;

  let manifest = await loadManifest();

  const projectPlans = projectDecoyPlans(projectRoot);
  const plantedProject = await plantPlans(projectPlans, manifest, projectRoot);
  manifest = plantedProject.manifest;

  let homeResult: PlantResult | undefined;
  if (includeHome) {
    const plantedHome = await plantPlans(homeDecoyPlans(), manifest);
    manifest = plantedHome.manifest;
    homeResult = plantedHome.result;
  }

  await saveManifest(manifest);

  return {
    projectRoot,
    home: includeHome,
    project: plantedProject.result,
    ...(homeResult !== undefined ? { homeResult } : {}),
  };
}

export function formatInitReport(report: InitReport): string {
  const lines: string[] = [];
  lines.push(`Planted project decoys in ${report.projectRoot}`);

  for (const c of report.project.created) {
    lines.push(`  created ${c.path} (token ${c.tokenId})`);
  }
  for (const s of report.project.skipped) {
    lines.push(`  skipped ${s.path} (${s.reason})`);
  }

  if (report.home && report.homeResult) {
    lines.push("Planted home decoys:");
    for (const c of report.homeResult.created) {
      lines.push(`  created ${c.path} (token ${c.tokenId})`);
    }
    for (const s of report.homeResult.skipped) {
      lines.push(`  skipped ${s.path} (${s.reason})`);
    }
  }

  return lines.join("\n");
}
