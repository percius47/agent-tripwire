import { describe, expect, it } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInit } from "../src/init.js";
import { loadManifest } from "../src/manifest.js";
import { BANNED_PREFIXES, startsWithBannedPrefix } from "../src/token.js";
import { makeTempHome, makeTempProject, useHome, writeFixture, readExact } from "./helpers.js";

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("init planting", () => {
  it("creates project decoys with unique tokens and a manifest", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const report = await runInit({ projectRoot: project });

      expect(report.project.created).toHaveLength(3);
      expect(report.project.skipped).toHaveLength(0);

      const tokens = report.project.created.map((c) => c.tokenId);
      expect(new Set(tokens).size).toBe(3);
      for (const t of tokens) {
        expect(t).toMatch(/^tw[A-Z2-7]{26}$/);
        expect(startsWithBannedPrefix(t)).toBe(false);
        for (const p of BANNED_PREFIXES) {
          expect(t.startsWith(p)).toBe(false);
        }
      }

      for (const c of report.project.created) {
        const body = await readFile(c.path, "utf8");
        expect(body).toContain(c.tokenId);
        expect(c.sha256).toBe(
          createHash("sha256").update(body, "utf8").digest("hex"),
        );
        expect(c.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(c.scope).toBe("project");
        expect(c.projectRoot).toBe(project);
      }

      const manifest = await loadManifest();
      expect(manifest.decoys).toHaveLength(3);
      expect(manifest.decoys.map((d) => d.path).sort()).toEqual(
        report.project.created.map((c) => c.path).sort(),
      );
    } finally {
      restore();
    }
  });

  it("skips and reports existing decoy files without overwriting", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const existing = path.join(project, ".env.backup");
      const marker = "PREEXISTING_MARKER_do_not_overwrite\n";
      await writeFile(existing, marker, "utf8");

      const report = await runInit({ projectRoot: project });

      expect(report.project.skipped).toEqual([
        expect.objectContaining({
          path: existing,
          reason: "already exists",
        }),
      ]);
      expect(report.project.created).toHaveLength(2);

      const after = await readFile(existing, "utf8");
      expect(after).toBe(marker);
    } finally {
      restore();
    }
  });

  it("keeps real .env, ~/.aws/credentials and ~/.npmrc byte-identical", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);

      const realEnv = "REAL_ENV_VALUE=fixture-not-a-secret\n";
      const realAws = "[default]\naws_access_key_id = FIXTUREKEYNOTREAL0000\naws_secret_access_key = fixturesecretnotreal0000000000000000\n";
      const realNpmrc = "registry=https://registry.npmjs.org/\n";

      const envPath = path.join(project, ".env");
      const awsPath = path.join(home, ".aws", "credentials");
      const npmrcPath = path.join(home, ".npmrc");

      const envBefore = await writeFixture(envPath, realEnv);
      const awsBefore = await writeFixture(awsPath, realAws);
      const npmrcBefore = await writeFixture(npmrcPath, realNpmrc);

      await runInit({ projectRoot: project, home: true });

      expect(sha(await readExact(envPath))).toBe(sha(envBefore));
      expect(sha(await readExact(awsPath))).toBe(sha(awsBefore));
      expect(sha(await readExact(npmrcPath))).toBe(sha(npmrcBefore));

      expect(Buffer.compare(await readExact(envPath), envBefore)).toBe(0);
      expect(Buffer.compare(await readExact(awsPath), awsBefore)).toBe(0);
      expect(Buffer.compare(await readExact(npmrcPath), npmrcBefore)).toBe(0);
    } finally {
      restore();
    }
  });

  it("init --home plants credentials.bak and .npmrc.bak only", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await mkdir(path.join(home, ".aws"), { recursive: true });

      const report = await runInit({ projectRoot: project, home: true });

      expect(report.homeResult?.created).toHaveLength(2);
      expect(report.homeResult?.skipped).toHaveLength(0);

      const bakAws = path.join(home, ".aws", "credentials.bak");
      const bakNpm = path.join(home, ".npmrc.bak");
      const awsBody = await readFile(bakAws, "utf8");
      const npmBody = await readFile(bakNpm, "utf8");

      const homeTokens = report.homeResult!.created.map((c) => c.tokenId);
      expect(new Set(homeTokens).size).toBe(2);
      expect(awsBody).toContain(homeTokens.find((t) => awsBody.includes(t)));
      expect(npmBody).toContain("//registry.npmjs.org/:_authToken=");

      const allTokens = [
        ...report.project.created.map((c) => c.tokenId),
        ...homeTokens,
      ];
      expect(new Set(allTokens).size).toBe(allTokens.length);

      const manifest = await loadManifest();
      expect(manifest.decoys).toHaveLength(5);
    } finally {
      restore();
    }
  });
});
