import { describe, expect, it } from "vitest";
import { access, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInit } from "../src/init.js";
import { runRemove } from "../src/remove.js";
import { loadManifest } from "../src/manifest.js";
import {
  EXCLUDE_BEGIN,
  parseExcludeBlock,
  readExclude,
} from "../src/git-exclude.js";
import { getStateDir } from "../src/paths.js";
import {
  gitPorcelain,
  initGitRepo,
  makeTempHome,
  makeTempProject,
  useHome,
  writeFixture,
  readExact,
} from "./helpers.js";

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function treeSnapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === ".git") continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        const body = await readFile(full);
        out.set(rel, createHash("sha256").update(body).digest("hex"));
      }
    }
  }

  await walk(root);
  return out;
}

describe("remove", () => {
  it("deletes hash-matched decoys only and restores the pre-init tree", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project, { commit: false });

      const envPath = path.join(project, ".env");
      const giPath = path.join(project, ".gitignore");
      await writeFixture(envPath, "REAL=1\n");
      await writeFixture(giPath, "node_modules/\n");

      // Commit fixtures so porcelain after init only reflects decoy handling.
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      await writeFile(path.join(project, "README"), "demo\n", "utf8");
      await execFileAsync("git", ["add", "README", ".env", ".gitignore"], {
        cwd: project,
      });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: project });

      const before = await treeSnapshot(project);

      await runInit({ projectRoot: project });
      expect(await gitPorcelain(project)).toBe("");

      const report = await runRemove({ projectRoot: project });
      expect(report.actions.filter((a) => a.action === "deleted")).toHaveLength(3);
      expect(report.warnings).toHaveLength(0);

      const after = await treeSnapshot(project);
      expect([...after.entries()].sort()).toEqual([...before.entries()].sort());

      // Exclude block removed
      const exclude = await readExclude(project);
      expect(exclude).not.toContain(EXCLUDE_BEGIN);

      expect(Buffer.compare(await readExact(envPath), Buffer.from("REAL=1\n"))).toBe(0);
      expect(
        Buffer.compare(await readExact(giPath), Buffer.from("node_modules/\n")),
      ).toBe(0);
    } finally {
      restore();
    }
  });

  it("keeps a modified decoy with a warning and leaves its exclude line", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project, { commit: true });
      await runInit({ projectRoot: project });

      const modified = path.join(project, ".env.backup");
      await writeFile(modified, "TAMPERED\n", "utf8");

      const report = await runRemove({ projectRoot: project });

      const kept = report.actions.filter((a) => a.action === "kept-modified");
      const deleted = report.actions.filter((a) => a.action === "deleted");
      expect(kept).toHaveLength(1);
      expect(kept[0]?.path).toBe(modified);
      expect(deleted).toHaveLength(2);
      expect(report.warnings.some((w) => w.includes(modified))).toBe(true);

      expect(await readFile(modified, "utf8")).toBe("TAMPERED\n");

      const exclude = await readExclude(project);
      const block = parseExcludeBlock(exclude);
      expect(block?.paths).toEqual([".env.backup"]);

      const manifest = await loadManifest();
      expect(manifest.decoys).toHaveLength(1);
      expect(manifest.decoys[0]?.path).toBe(modified);
    } finally {
      restore();
    }
  });

  it("is idempotent: second remove is a no-op", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project, { commit: true });
      await runInit({ projectRoot: project });
      await runRemove({ projectRoot: project });

      const second = await runRemove({ projectRoot: project });
      expect(second.actions).toHaveLength(0);
      expect(second.warnings).toHaveLength(0);
      expect(second.excludePathsRemoved).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("supports remove --home for home decoys", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await runInit({ projectRoot: project, home: true });

      const bakAws = path.join(home, ".aws", "credentials.bak");
      const bakNpm = path.join(home, ".npmrc.bak");
      await access(bakAws);
      await access(bakNpm);

      const withoutHome = await runRemove({ projectRoot: project });
      expect(
        withoutHome.actions.filter((a) => a.path === bakAws || a.path === bakNpm),
      ).toHaveLength(0);
      await access(bakAws);

      const withHome = await runRemove({ projectRoot: project, home: true });
      expect(withHome.actions.some((a) => a.path === bakAws && a.action === "deleted")).toBe(
        true,
      );
      expect(withHome.actions.some((a) => a.path === bakNpm && a.action === "deleted")).toBe(
        true,
      );
      await expect(access(bakAws)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(bakNpm)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restore();
    }
  });

  it("dry-run does not delete files", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await runInit({ projectRoot: project });
      const report = await runRemove({ projectRoot: project, dryRun: true });
      expect(report.actions.every((a) => a.action === "would-delete")).toBe(true);
      await access(path.join(project, ".env.backup"));
      const manifest = await loadManifest();
      expect(manifest.decoys).toHaveLength(3);
    } finally {
      restore();
    }
  });

  it("clears state dir when no decoys remain", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await runInit({ projectRoot: project });
      await runRemove({ projectRoot: project });
      await expect(access(getStateDir())).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restore();
    }
  });

  it("keeps real .env and .gitignore byte-identical across init+remove", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project, { commit: true });

      const envPath = path.join(project, ".env");
      const giPath = path.join(project, ".gitignore");
      const envBefore = await writeFixture(envPath, "SECRET=fixture\n");
      const giBefore = await writeFixture(giPath, "*.log\n");

      await runInit({ projectRoot: project });
      await runRemove({ projectRoot: project });

      expect(sha(await readExact(envPath))).toBe(sha(envBefore));
      expect(sha(await readExact(giPath))).toBe(sha(giBefore));
      expect(Buffer.compare(await readExact(envPath), envBefore)).toBe(0);
      expect(Buffer.compare(await readExact(giPath), giBefore)).toBe(0);
    } finally {
      restore();
    }
  });
});
