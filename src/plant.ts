import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { DecoyPlan } from "./decoys.js";
import type { DecoyRecord, Manifest } from "./manifest.js";
import { upsertDecoy } from "./manifest.js";

export interface PlantResult {
  created: DecoyRecord[];
  skipped: { path: string; label: string; reason: string }[];
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Create a decoy file with flag 'wx' (fail if exists). Never overwrites.
 * Returns null when skipped because the file already exists.
 */
export async function plantOne(
  plan: DecoyPlan,
  projectRoot?: string,
): Promise<{ record: DecoyRecord } | { skipped: true; reason: string }> {
  const { content, tokenId } = plan.render();
  const dir = path.dirname(plan.path);
  await mkdir(dir, { recursive: true });

  let handle;
  try {
    handle = await open(plan.path, "wx");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return { skipped: true, reason: "already exists" };
    }
    throw err;
  }

  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }

  const record: DecoyRecord = {
    path: plan.path,
    sha256: sha256(content),
    tokenId,
    createdAt: new Date().toISOString(),
    scope: plan.scope,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
  };

  return { record };
}

export async function plantPlans(
  plans: DecoyPlan[],
  manifest: Manifest,
  projectRoot?: string,
): Promise<{ manifest: Manifest; result: PlantResult }> {
  const created: DecoyRecord[] = [];
  const skipped: PlantResult["skipped"] = [];
  let next = manifest;

  for (const plan of plans) {
    const outcome = await plantOne(plan, projectRoot);
    if ("skipped" in outcome) {
      skipped.push({ path: plan.path, label: plan.label, reason: outcome.reason });
      continue;
    }
    created.push(outcome.record);
    next = upsertDecoy(next, outcome.record);
  }

  return { manifest: next, result: { created, skipped } };
}
