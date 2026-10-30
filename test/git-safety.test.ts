import { describe, expect, it } from "vitest";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInit } from "../src/init.js";
import {
  EXCLUDE_BEGIN,
  EXCLUDE_END,
  defaultGitRunner,
  parseExcludeBlock,
  readExclude,
  type GitRunner,
} from "../src/git-exclude.js";
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

describe("git safety on init", () => {
  it("writes .git/info/exclude and passes git check-ignore; porcelain stays empty", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project, { commit: true });

      const report = await runInit({ projectRoot: project });

      expect(report.refused).toBeUndefined();
      expect(report.gitRoot).toBe(await defaultGitRunner.revParseToplevel(project));
      expect(report.excludeApplied).toBe(true);
      expect(report.project.created).toHaveLength(3);
      expect(report.rolledBack).toHaveLength(0);

      const exclude = await readExclude(report.gitRoot!);
      expect(exclude).toContain(EXCLUDE_BEGIN);
      expect(exclude).toContain(EXCLUDE_END);
      const block = parseExcludeBlock(exclude);
      expect(block?.paths.sort()).toEqual(
        [".env.backup", ".env.local.old", "config/secrets.legacy.json"].sort(),
      );

      for (const c of report.project.created) {
        const rel = path.relative(report.gitRoot!, c.path).split(path.sep).join("/");
        expect(await defaultGitRunner.checkIgnore(report.gitRoot!, rel)).toBe(true);
      }

      expect(await gitPorcelain(project)).toBe("");
    } finally {
      restore();
    }
  });

  it("never edits .gitignore; real .env and .gitignore stay byte-identical", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project, { commit: true });

      const gitignorePath = path.join(project, ".gitignore");
      const envPath = path.join(project, ".env");
      const giBefore = await writeFixture(gitignorePath, "node_modules/\n");
      const envBefore = await writeFixture(envPath, "REAL=keep-me\n");

      await runInit({ projectRoot: project });

      expect(Buffer.compare(await readExact(gitignorePath), giBefore)).toBe(0);
      expect(Buffer.compare(await readExact(envPath), envBefore)).toBe(0);
      expect(sha(await readExact(gitignorePath))).toBe(sha(giBefore));
      expect(sha(await readExact(envPath))).toBe(sha(envBefore));
    } finally {
      restore();
    }
  });

  it("plants without exclude and notes when not a git repo", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const report = await runInit({ projectRoot: project });

      expect(report.gitRoot).toBeNull();
      expect(report.excludeApplied).toBe(false);
      expect(report.project.created).toHaveLength(3);
      expect(report.notes.some((n) => /not a git repository/i.test(n))).toBe(true);

      await expect(
        access(path.join(project, ".git", "info", "exclude")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restore();
    }
  });

  it("refuses when a decoy path is already tracked", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project, { commit: true });
      const decoy = path.join(project, ".env.backup");
      await writeFile(decoy, "tracked-decoy\n", "utf8");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      await execFileAsync("git", ["add", "-f", ".env.backup"], { cwd: project });
      await execFileAsync("git", ["commit", "-m", "track decoy"], { cwd: project });

      const report = await runInit({ projectRoot: project });

      expect(report.refused).toMatch(/already tracked/);
      expect(report.project.created).toHaveLength(0);
      // Should not have planted the other decoys either
      await expect(access(path.join(project, ".env.local.old"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      restore();
    }
  });

  it("rolls back planted decoys and restores exclude when check-ignore fails", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project, { commit: true });

      // Negate .env.backup so info/exclude cannot ignore it.
      const giPath = path.join(project, ".gitignore");
      const giContents = "*\n!.gitignore\n!.env.backup\n";
      await writeFile(giPath, giContents, "utf8");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      await execFileAsync("git", ["add", ".gitignore"], { cwd: project });
      await execFileAsync("git", ["commit", "-m", "gitignore"], { cwd: project });

      const excludeBefore = await readExclude(project);

      const report = await runInit({ projectRoot: project });

      expect(report.excludeApplied).toBe(false);
      expect(report.rolledBack.length).toBeGreaterThan(0);
      expect(report.project.created).toHaveLength(0);

      // All project decoys removed
      for (const name of [".env.backup", ".env.local.old", "config/secrets.legacy.json"]) {
        await expect(access(path.join(project, name))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }

      // Exclude restored (no tripwire block left from the failed attempt)
      const excludeAfter = await readExclude(project);
      expect(excludeAfter).toBe(excludeBefore);
      expect(excludeAfter).not.toContain(EXCLUDE_BEGIN);

      // .gitignore untouched
      expect(await readFile(giPath, "utf8")).toBe(giContents);
    } finally {
      restore();
    }
  });

  it("rolls back when injected GitRunner fails check-ignore", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project, { commit: true });

      const failingGit: GitRunner = {
        ...defaultGitRunner,
        checkIgnore: async () => false,
      };

      const report = await runInit({ projectRoot: project, git: failingGit });

      expect(report.rolledBack.length).toBe(3);
      expect(report.project.created).toHaveLength(0);
      expect(report.excludeApplied).toBe(false);
      await expect(access(path.join(project, ".env.backup"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      restore();
    }
  });
});
