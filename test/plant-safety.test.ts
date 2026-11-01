import { describe, expect, it } from "vitest";
import path from "node:path";
import { access, open } from "node:fs/promises";
import {
  assertSafePlantTarget,
  commitWxWrite,
  isForbiddenEnvName,
  plantPlans,
} from "../src/plant.js";
import { emptyManifest, loadManifest } from "../src/manifest.js";
import { projectDecoyPlans } from "../src/decoys.js";
import { makeTempHome, makeTempProject, useHome } from "./helpers.js";

describe("plant safety", () => {
  it("isForbiddenEnvName allows .backup/.old and rejects bare .env*", () => {
    expect(isForbiddenEnvName("/x/.env")).toBe(true);
    expect(isForbiddenEnvName("/x/.env.local")).toBe(true);
    expect(isForbiddenEnvName("/x/.env.production")).toBe(true);
    expect(isForbiddenEnvName("/x/.env.backup")).toBe(false);
    expect(isForbiddenEnvName("/x/.env.local.old")).toBe(false);
  });

  it("assertSafePlantTarget refuses FORBIDDEN_WRITE_PATHS and bare .env", () => {
    const home = "/tmp/h";
    const project = "/tmp/p";
    process.env.AGENT_TRIPWIRE_HOME = home;
    try {
      expect(() =>
        assertSafePlantTarget(path.join(project, ".env"), project),
      ).toThrow(/forbidden|\.env\*/i);
      expect(() =>
        assertSafePlantTarget(path.join(home, ".aws", "credentials")),
      ).toThrow(/forbidden/i);
      expect(() =>
        assertSafePlantTarget(path.join(home, ".npmrc")),
      ).toThrow(/forbidden/i);
      expect(() =>
        assertSafePlantTarget(path.join(project, ".env.backup"), project),
      ).not.toThrow();
    } finally {
      delete process.env.AGENT_TRIPWIRE_HOME;
    }
  });

  it("saves the manifest after each planted file", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const plans = projectDecoyPlans(project);
      await plantPlans(plans.slice(0, 1), emptyManifest(), project);
      const mid = await loadManifest();
      expect(mid.decoys).toHaveLength(1);
      expect(mid.decoys[0]?.path).toBe(plans[0]!.path);

      await plantPlans(plans.slice(1), mid, project);
      const end = await loadManifest();
      expect(end.decoys).toHaveLength(3);
    } finally {
      restore();
    }
  });

  it("deletes the file if writeFile fails after wx open", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const target = path.join(project, ".env.backup");
      const handle = await open(target, "wx");
      const failing = {
        writeFile: async () => {
          throw new Error("simulated write failure");
        },
        close: async () => {
          await handle.close();
        },
      };
      await expect(commitWxWrite(failing, target, "payload\n")).rejects.toThrow(
        /simulated write failure/,
      );
      await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restore();
    }
  });
});
