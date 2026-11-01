import { describe, expect, it, afterEach } from "vitest";
import {
  readFile,
  writeFile,
  access,
  mkdir,
  unlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { runInit } from "../src/init.js";
import { runRemove } from "../src/remove.js";
import { loadManifest } from "../src/manifest.js";
import { getStateDir } from "../src/paths.js";
import {
  EXCLUDE_BEGIN,
  EXCLUDE_END,
  excludeFilePath,
  isIgnored,
  setCheckIgnoreForTests,
} from "../src/git-exclude.js";
import {
  makeTempHome,
  makeTempProject,
  useHome,
  initGitRepo,
  writeFixture,
  readExact,
} from "./helpers.js";

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ASKPASS: "",
      GIT_EDITOR: "true",
      GC_AUTO: "0",
      GIT_AUTHOR_NAME: "tripwire-test",
      GIT_AUTHOR_EMAIL: "tripwire@test",
      GIT_COMMITTER_NAME: "tripwire-test",
      GIT_COMMITTER_EMAIL: "tripwire@test",
    },
  });
  if (r.error) {
    throw new Error(`git ${args.join(" ")} error: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  return r.stdout;
}

afterEach(() => {
  setCheckIgnoreForTests(null);
});

describe("git safety", () => {
  it("writes .git/info/exclude and check-ignore passes; porcelain empty", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      const gitignoreBefore = "# keep\n";
      await writeFile(path.join(project, ".gitignore"), gitignoreBefore, "utf8");
      git(project, ["add", ".gitignore"]);
      git(project, ["commit", "--no-gpg-sign", "-m", "gitignore"]);

      const report = await runInit({ projectRoot: project });
      expect(report.gitRepo).toBe(true);
      expect(report.project.created).toHaveLength(3);
      expect(report.rolledBack).toHaveLength(0);

      const exclude = await readFile(excludeFilePath(project), "utf8");
      expect(exclude).toContain(EXCLUDE_BEGIN);
      expect(exclude).toContain(EXCLUDE_END);
      expect(exclude).toContain(".env.backup");
      expect(exclude).toContain(".env.local.old");
      expect(exclude).toContain("config/secrets.legacy.json");

      for (const c of report.project.created) {
        const rel = path.relative(project, c.path).split(path.sep).join("/");
        expect(isIgnored(project, rel)).toBe(true);
      }

      expect(git(project, ["status", "--porcelain"]).trim()).toBe("");
      expect(await readFile(path.join(project, ".gitignore"), "utf8")).toBe(
        gitignoreBefore,
      );
    } finally {
      restore();
    }
  });

  it("rolls back decoys that fail check-ignore and reverts exclude lines", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);

      // Force every check-ignore to fail → full rollback of planted decoys.
      setCheckIgnoreForTests(() => false);

      const report = await runInit({ projectRoot: project });
      expect(report.rolledBack.length).toBe(3);
      expect(report.project.created).toHaveLength(0);

      for (const r of report.rolledBack) {
        await expect(access(r.path)).rejects.toMatchObject({ code: "ENOENT" });
      }

      const exclude = await readFile(excludeFilePath(project), "utf8");
      expect(exclude).not.toContain(EXCLUDE_BEGIN);
      expect(exclude).not.toContain(".env.backup");

      const manifest = await loadManifest();
      expect(manifest.decoys).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("plants without exclude when not a git repo and says so", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const report = await runInit({ projectRoot: project });
      expect(report.gitRepo).toBe(false);
      expect(report.notes.some((n) => /not a git repository/i.test(n))).toBe(
        true,
      );
    } finally {
      restore();
    }
  });

  it("resolves project root to git toplevel from a subdirectory", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      const sub = path.join(project, "packages", "app");
      await mkdir(sub, { recursive: true });

      const report = await runInit({ projectRoot: sub });
      expect(report.projectRoot).toBe(project);
      expect(report.notes.some((n) => /git toplevel/i.test(n))).toBe(true);
      await access(path.join(project, ".env.backup"));
    } finally {
      restore();
    }
  });

  it("refuses a tracked decoy path", { timeout: 20_000 }, async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      await writeFile(path.join(project, ".env.backup"), "tracked\n", "utf8");
      git(project, ["add", "-f", ".env.backup"]);
      git(project, ["commit", "--no-gpg-sign", "-m", "track decoy"]);

      const report = await runInit({ projectRoot: project });
      expect(report.refusedTracked.length).toBe(1);
      expect(report.project.skipped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: "already tracked by git" }),
        ]),
      );
      expect(await readFile(path.join(project, ".env.backup"), "utf8")).toBe(
        "tracked\n",
      );
    } finally {
      restore();
    }
  });

  it("re-init after deleting one decoy keeps all three ignored", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      await runInit({ projectRoot: project });

      const decoy = path.join(project, ".env.backup");
      await unlink(decoy);

      await runInit({ projectRoot: project });

      const paths = [
        ".env.backup",
        ".env.local.old",
        "config/secrets.legacy.json",
      ];
      for (const rel of paths) {
        expect(isIgnored(project, rel), rel).toBe(true);
      }

      const exclude = await readFile(excludeFilePath(project), "utf8");
      expect(exclude).toContain(".env.backup");
      expect(exclude).toContain(".env.local.old");
      expect(exclude).toContain("config/secrets.legacy.json");

      expect(git(project, ["status", "--porcelain"]).trim()).toBe("");
    } finally {
      restore();
    }
  });
});

describe("remove", () => {
  it("deletes hash-matched decoys only; strips exclude; keeps .env/.gitignore identical", { timeout: 20_000 }, async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      const envPath = path.join(project, ".env");
      const gitignorePath = path.join(project, ".gitignore");
      const envBefore = await writeFixture(envPath, "REAL=1\n");
      const giBefore = await writeFixture(gitignorePath, "node_modules/\n");
      git(project, ["add", ".gitignore"]);
      git(project, ["commit", "--no-gpg-sign", "-m", "gi"]);

      await runInit({ projectRoot: project });
      const remove1 = await runRemove({ projectRoot: project });
      expect(remove1.deleted.length).toBe(3);
      expect(remove1.keptModified).toHaveLength(0);
      expect(remove1.excludeStripped).toBe(true);
      expect(remove1.removedDirs).toContain(path.join(project, "config"));

      await expect(
        access(path.join(project, ".env.backup")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      expect(Buffer.compare(await readExact(envPath), envBefore)).toBe(0);
      expect(Buffer.compare(await readExact(gitignorePath), giBefore)).toBe(0);

      const exclude = await readFile(excludeFilePath(project), "utf8");
      expect(exclude).not.toContain(EXCLUDE_BEGIN);
    } finally {
      restore();
    }
  });

  it("keeps a modified decoy with a warning", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      await runInit({ projectRoot: project });

      const decoy = path.join(project, ".env.backup");
      await writeFile(decoy, "MODIFIED_BY_USER\n", "utf8");

      const report = await runRemove({ projectRoot: project });
      expect(report.keptModified).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: decoy })]),
      );
      expect(await readFile(decoy, "utf8")).toBe("MODIFIED_BY_USER\n");
      expect(report.deleted.length).toBe(2);

      const manifest = await loadManifest();
      expect(manifest.decoys.some((d) => d.path === decoy)).toBe(true);
    } finally {
      restore();
    }
  });

  it("is idempotent: second remove is a no-op", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      await runInit({ projectRoot: project });
      await runRemove({ projectRoot: project });
      const second = await runRemove({ projectRoot: project });
      expect(second.deleted).toHaveLength(0);
      expect(second.keptModified).toHaveLength(0);
      expect(second.notes.some((n) => /nothing to remove/i.test(n))).toBe(true);
    } finally {
      restore();
    }
  });

  it("remove --home deletes home decoys", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await runInit({ projectRoot: project, home: true });
      const report = await runRemove({ projectRoot: project, home: true });
      expect(
        report.deleted.some((p) => p.replace(/\\/g, "/").endsWith(".aws/credentials.bak")),
      ).toBe(true);
      expect(report.deleted.some((p) => p.endsWith(".npmrc.bak"))).toBe(true);
      await expect(
        access(path.join(home, ".aws", "credentials.bak")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restore();
    }
  });

  it("extra file in state dir survives remove (no recursive rm)", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await runInit({ projectRoot: project });

      const stateDir = getStateDir();
      const extra = path.join(stateDir, "user-notes.txt");
      const hits = path.join(stateDir, "hits.jsonl");
      await writeFile(extra, "keep me\n", "utf8");
      await writeFile(hits, "{\"tokenId\":\"twTEST\"}\n", "utf8");

      await runRemove({ projectRoot: project });

      expect(await readFile(extra, "utf8")).toBe("keep me\n");
      expect(await readFile(hits, "utf8")).toBe('{"tokenId":"twTEST"}\n');
      await expect(access(path.join(stateDir, "manifest.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      // State dir itself must still exist because extra + hits remain.
      await access(stateDir);
    } finally {
      restore();
    }
  });
});
