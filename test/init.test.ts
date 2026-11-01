import { describe, expect, it } from "vitest";
import { readFile, writeFile, mkdir, symlink, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInit, formatInitReport } from "../src/init.js";
import { loadManifest } from "../src/manifest.js";
import { BANNED_PREFIXES, startsWithBannedPrefix } from "../src/token.js";
import { formatTokenLabel } from "../src/token-label.js";
import { PRIVATE_FILE_MODE } from "../src/fs-mode.js";
import { getManifestPath } from "../src/paths.js";
import {
  makeTempHome,
  makeTempProject,
  useHome,
  writeFixture,
  readExact,
} from "./helpers.js";

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
        const mode = (await lstat(c.path)).mode & 0o777;
        expect(mode).toBe(PRIVATE_FILE_MODE);
      }

      // .env.local.old uses app_ro, not tripwire
      const localOld = await readFile(
        path.join(project, ".env.local.old"),
        "utf8",
      );
      expect(localOld).toContain("postgres://app_ro:");
      expect(localOld).not.toContain("postgres://tripwire:");

      const manifest = await loadManifest();
      expect(manifest.decoys).toHaveLength(3);
      expect(manifest.createdDirs).toContain(path.join(project, "config"));
      const manMode = (await lstat(getManifestPath())).mode & 0o777;
      expect(manMode).toBe(PRIVATE_FILE_MODE);
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
      const realAws =
        "[default]\naws_access_key_id = FIXTUREKEYNOTREAL0000\naws_secret_access_key = fixturesecretnotreal0000000000000000\n";
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
      expect(manifest.createdDirs).toContain(path.join(home, ".aws"));
    } finally {
      restore();
    }
  });

  it("skips existing ~/.aws/credentials.bak and ~/.npmrc.bak byte-identically and omits them from manifest", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await mkdir(path.join(home, ".aws"), { recursive: true });
      const bakAws = path.join(home, ".aws", "credentials.bak");
      const bakNpm = path.join(home, ".npmrc.bak");
      const awsMarker = "[preexisting]\naws_access_key_id = KEEPME\n";
      const npmMarker = "; preexisting bak\n//registry.npmjs.org/:_authToken=KEEP\n";
      const awsBefore = await writeFixture(bakAws, awsMarker);
      const npmBefore = await writeFixture(bakNpm, npmMarker);

      const report = await runInit({ projectRoot: project, home: true });

      expect(report.homeResult?.skipped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: bakAws, reason: "already exists" }),
          expect.objectContaining({ path: bakNpm, reason: "already exists" }),
        ]),
      );
      expect(report.homeResult?.created).toHaveLength(0);
      expect(Buffer.compare(await readExact(bakAws), awsBefore)).toBe(0);
      expect(Buffer.compare(await readExact(bakNpm), npmBefore)).toBe(0);

      const manifest = await loadManifest();
      expect(manifest.decoys.map((d) => d.path)).not.toContain(bakAws);
      expect(manifest.decoys.map((d) => d.path)).not.toContain(bakNpm);
    } finally {
      restore();
    }
  });

  it("re-running init and init --home skips everything and keeps the same manifest records", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await runInit({ projectRoot: project, home: true });
      const before = await loadManifest();
      const beforeJson = JSON.stringify(before);

      const again = await runInit({ projectRoot: project, home: true });
      expect(again.project.created).toHaveLength(0);
      expect(again.project.skipped.length).toBeGreaterThanOrEqual(3);
      expect(again.homeResult?.created).toHaveLength(0);
      expect(again.homeResult?.skipped).toHaveLength(2);

      const after = await loadManifest();
      expect(JSON.stringify(after.decoys)).toBe(JSON.stringify(before.decoys));
      expect(after.decoys.map((d) => d.tokenId)).toEqual(
        before.decoys.map((d) => d.tokenId),
      );
      expect(after.decoys.map((d) => d.sha256)).toEqual(
        before.decoys.map((d) => d.sha256),
      );
      expect(beforeJson).toBe(JSON.stringify(before));
    } finally {
      restore();
    }
  });

  it("formatInitReport never prints full tokens", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const report = await runInit({ projectRoot: project });
      const text = formatInitReport(report);
      for (const c of report.project.created) {
        expect(text).not.toContain(c.tokenId);
        expect(text).toContain(formatTokenLabel(c.tokenId));
        expect(text).toContain(c.path);
      }
    } finally {
      restore();
    }
  });
});

describe("symlink safety", () => {
  it("skips .env.backup symlink to real .env and leaves target byte-identical", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const envPath = path.join(project, ".env");
      const envBefore = await writeFixture(envPath, "SECRET=real\n");
      await symlink(envPath, path.join(project, ".env.backup"));

      const report = await runInit({ projectRoot: project });
      expect(report.project.skipped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: path.join(project, ".env.backup"),
            reason: "already exists",
          }),
        ]),
      );
      expect(Buffer.compare(await readExact(envPath), envBefore)).toBe(0);
    } finally {
      restore();
    }
  });

  it("skips a dangling .env.backup symlink", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const dangling = path.join(project, ".env.backup");
      await symlink(path.join(project, "does-not-exist.env"), dangling);

      const report = await runInit({ projectRoot: project });
      expect(report.project.skipped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: dangling,
            reason: "already exists",
          }),
        ]),
      );
      const st = await lstat(dangling);
      expect(st.isSymbolicLink()).toBe(true);
    } finally {
      restore();
    }
  });

  it("refuses a config/ dir that is a symlink pointing outside the project", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const outside = path.join(home, "outside-config");
      await mkdir(outside, { recursive: true });
      await symlink(outside, path.join(project, "config"));

      await expect(runInit({ projectRoot: project })).rejects.toThrow(
        /symlink pointing outside/i,
      );
    } finally {
      restore();
    }
  });
});
