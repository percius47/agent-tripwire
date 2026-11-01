import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAdapter, parseCodexLine } from "../src/adapters/codex.js";
import { createClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { EXIT } from "../src/exit-codes.js";
import { runInit } from "../src/init.js";
import { loadManifest } from "../src/manifest.js";
import { notifyHit, sampleAlertLine } from "../src/notify.js";
import { getHitsPath, getManifestPath } from "../src/paths.js";
import { runRemove } from "../src/remove.js";
import { runScan } from "../src/scan.js";
import {
  formatStatusReport,
  runStatus,
  statusContainsFullToken,
} from "../src/status.js";
import { runTestAlert } from "../src/test-alert.js";
import { formatTokenLabel } from "../src/token-label.js";
import { startWatch } from "../src/watch.js";
import {
  initGitRepo,
  makeTempHome,
  makeTempProject,
  readExact,
  useHome,
  writeFixture,
} from "./helpers.js";

const notifyMock = vi.hoisted(() =>
  vi.fn(
    (
      _opts: unknown,
      cb?: (err: Error | null, response: string, metadata?: unknown) => void,
    ) => {
      cb?.(null, "ok");
    },
  ),
);

vi.mock("node-notifier", () => ({
  default: {
    notify: notifyMock,
  },
}));

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliJs = path.join(root, "dist", "cli.js");

function toolResultClaude(token: string, sessionId: string): string {
  return JSON.stringify({
    type: "user",
    sessionId,
    timestamp: "2026-10-30T12:00:00.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_test",
          content: `AWS_ACCESS_KEY_ID=${token}\n`,
        },
      ],
    },
  });
}

/** UNVERIFIED Codex rollout shape used as a synthetic fixture. */
function toolResultCodex(token: string): string {
  return JSON.stringify({
    timestamp: "2026-10-30T12:00:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call_test",
      output: `AWS_ACCESS_KEY_ID=${token}\n`,
    },
  });
}

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
  if (r.error) throw new Error(r.error.message);
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

async function snapshotTree(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  async function walk(cur: string): Promise<void> {
    const entries = await readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".git") continue;
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        out.set(path.relative(dir, abs), await readFile(abs));
      }
    }
  }
  await walk(dir);
  return out;
}

beforeEach(() => {
  notifyMock.mockClear();
});

afterEach(() => {
  notifyMock.mockClear();
});

describe("Codex adapter (UNVERIFIED)", () => {
  it("marks function_call_output as read and finds the token", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const report = await runInit({ projectRoot: project });
      const tokenId = report.project.created[0]?.tokenId;
      if (!tokenId) throw new Error("missing token");

      const sessDir = path.join(
        home,
        ".codex",
        "sessions",
        "2026",
        "10",
        "30",
      );
      await mkdir(sessDir, { recursive: true });
      const file = path.join(sessDir, "rollout-2026-10-30T12-00-00-abcdef.jsonl");
      await writeFile(file, `${toolResultCodex(tokenId)}\n`, "utf8");

      const result = await runScan();
      expect(result.exitCode).toBe(EXIT.FAIL);
      const hit = result.hits.find((h) => h.adapter === "codex");
      expect(hit).toBeTruthy();
      expect(hit?.kind).toBe("read");
      expect(hit?.tool).toBe("codex");
      expect(hit?.alertLine).not.toContain(tokenId);
      expect(hit?.alertLine).toContain(formatTokenLabel(tokenId));
    } finally {
      restore();
    }
  });

  it("falls back to raw-text scanning for non-JSON (UNVERIFIED)", () => {
    const parsed = parseCodexLine(
      "plain rollout junk twAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "/tmp/rollout-x.jsonl",
    );
    expect(parsed?.isToolResult).toBe(false);
    expect(parsed?.text).toContain("twAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });
});

describe("notifications", () => {
  it("notifies once per new hit and never includes the full token", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const report = await runInit({ projectRoot: project });
      const tokenId = report.project.created[0]?.tokenId;
      if (!tokenId) throw new Error("missing token");

      const dir = path.join(home, ".claude", "projects", "-tmp");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "sess-n.jsonl"),
        `${toolResultClaude(tokenId, "sess-n")}\n`,
        "utf8",
      );

      const scan = await runScan({
        onHit: (h) => notifyHit(h),
      });
      expect(scan.hits.length).toBeGreaterThanOrEqual(1);
      expect(notifyMock).toHaveBeenCalledTimes(scan.hits.length);
      for (const call of notifyMock.mock.calls) {
        const opts = call[0] as { message?: string; title?: string };
        expect(opts.message).toBeTruthy();
        expect(opts.message).not.toContain(tokenId);
        expect(opts.message).toContain(formatTokenLabel(tokenId));
      }

      // Second scan: no new hits → no new notifications.
      notifyMock.mockClear();
      const again = await runScan({
        onHit: (h) => notifyHit(h),
      });
      expect(again.hits).toHaveLength(0);
      expect(notifyMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("notify failure does not crash watch onHit path", () => {
    notifyMock.mockImplementationOnce(() => {
      throw new Error("desktop bus down");
    });
    expect(() =>
      notifyHit({
        at: new Date().toISOString(),
        tokenId: "twAAAAAAAAAAAAAAAAAAAAAAAAAA",
        kind: "read",
        adapter: "claude-code",
        tool: "claude-code",
        sessionId: "s",
        sourceFile: "/tmp/x",
        decoyPath: "/tmp/d",
        snippet: "x",
        alertLine: "Tripwire: test (tw…AAAA)",
      }),
    ).not.toThrow();
  });
});

describe("status and test-alert", () => {
  it("status lists decoys, adapters, hits without full tokens", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      const report = await runInit({ projectRoot: project, home: true });
      const tokenId = report.project.created[0]?.tokenId;
      if (!tokenId) throw new Error("missing token");

      const dir = path.join(home, ".claude", "projects", "-tmp");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "sess-st.jsonl"),
        `${toolResultClaude(tokenId, "sess-st")}\n`,
        "utf8",
      );
      await runScan();

      const status = await runStatus({ lastHits: 5 });
      expect(status.decoys.length).toBeGreaterThanOrEqual(3);
      expect(status.adapters.some((a) => a.id === "claude-code")).toBe(true);
      expect(status.adapters.some((a) => a.id === "codex")).toBe(true);
      expect(status.hits.length).toBeGreaterThanOrEqual(1);

      const text = formatStatusReport(status);
      expect(statusContainsFullToken(text, (await loadManifest()).decoys)).toBe(
        false,
      );
      expect(text).toContain(formatTokenLabel(tokenId));
      expect(text).toMatch(/git=ignored/);
    } finally {
      restore();
    }
  });

  it("test-alert fires sample notify + stdout without touching manifest/hits", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const beforeManifest = await readFile(getManifestPath(), "utf8").catch(
        () => null,
      );
      const beforeHits = await readFile(getHitsPath(), "utf8").catch(
        () => null,
      );

      const report = runTestAlert({ notify: true });
      expect(report.exitCode).toBe(EXIT.OK);
      expect(report.alertLine).toBe(sampleAlertLine());
      expect(report.alertLine).not.toMatch(/tw[A-Z2-7]{26}/);
      expect(notifyMock).toHaveBeenCalledTimes(1);

      const afterManifest = await readFile(getManifestPath(), "utf8").catch(
        () => null,
      );
      const afterHits = await readFile(getHitsPath(), "utf8").catch(
        () => null,
      );
      expect(afterManifest).toEqual(beforeManifest);
      expect(afterHits).toEqual(beforeHits);
      // State dir may be created by other tests; test-alert itself must not
      // create hits/manifest. Confirm hits file still absent if it was.
      if (beforeHits === null) {
        expect(afterHits).toBeNull();
      }
    } finally {
      restore();
    }
  });
});

describe("exit codes", () => {
  it("documents and returns expected codes from library APIs", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const initOk = await runInit({ projectRoot: project });
      expect(initOk.rolledBack).toHaveLength(0);
      expect(initOk.refusedTracked).toHaveLength(0);

      const clean = await runScan();
      expect(clean.exitCode).toBe(EXIT.OK);

      const tokenId = initOk.project.created[0]?.tokenId;
      if (!tokenId) throw new Error("missing token");
      const dir = path.join(home, ".claude", "projects", "-tmp");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "sess-ex.jsonl"),
        `${toolResultClaude(tokenId, "sess-ex")}\n`,
        "utf8",
      );
      const dirty = await runScan();
      expect(dirty.exitCode).toBe(EXIT.FAIL);

      const rem = await runRemove({ projectRoot: project });
      expect(rem.deleted.length).toBeGreaterThan(0);

      const alert = runTestAlert({ notify: true });
      expect(alert.exitCode).toBe(EXIT.OK);

      const status = await runStatus();
      expect(status).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("CLI scan/status/test-alert exit codes", async () => {
    const build = spawnSync("npm", ["run", "build"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(build.status).toBe(0);

    const home = await makeTempHome();
    const project = await makeTempProject(home);
    const env = {
      ...process.env,
      AGENT_TRIPWIRE_HOME: home,
      HOME: home,
    };

    const init = spawnSync("node", [cliJs, "init"], {
      cwd: project,
      encoding: "utf8",
      env,
    });
    expect(init.status).toBe(EXIT.OK);

    const status = spawnSync("node", [cliJs, "status"], {
      cwd: project,
      encoding: "utf8",
      env,
    });
    expect(status.status).toBe(EXIT.OK);
    expect(status.stdout).not.toMatch(/tw[A-Z2-7]{26}/);

    const alert = spawnSync("node", [cliJs, "test-alert", "--no-notify"], {
      cwd: project,
      encoding: "utf8",
      env,
    });
    expect(alert.status).toBe(EXIT.OK);
    expect(alert.stdout).toContain("test-alert");

    const cleanScan = spawnSync("node", [cliJs, "scan", "--no-notify"], {
      cwd: project,
      encoding: "utf8",
      env,
    });
    expect(cleanScan.status).toBe(EXIT.OK);

    // Plant a hit via library under same HOME, then CLI scan → 1
    const restore = useHome(home);
    try {
      const tokenId = (await loadManifest()).decoys[0]?.tokenId;
      if (!tokenId) throw new Error("missing token");
      const dir = path.join(home, ".claude", "projects", "-tmp");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "sess-cli.jsonl"),
        `${toolResultClaude(tokenId, "sess-cli")}\n`,
        "utf8",
      );
    } finally {
      restore();
    }

    const dirtyScan = spawnSync("node", [cliJs, "scan", "--no-notify"], {
      cwd: project,
      encoding: "utf8",
      env,
    });
    expect(dirtyScan.status).toBe(EXIT.FAIL);

    const rem = spawnSync("node", [cliJs, "remove"], {
      cwd: project,
      encoding: "utf8",
      env,
    });
    expect(rem.status).toBe(EXIT.OK);
  });
});

describe("end-to-end core flow", () => {
  it(
    "init --home, Claude+Codex read hits, scan/watch, remove restores tree",
    { timeout: 30_000 },
    async () => {
      const home = await makeTempHome();
      const restore = useHome(home);
      let handle: Awaited<ReturnType<typeof startWatch>> | undefined;
      try {
        const project = await makeTempProject(home);
        await initGitRepo(project);

        // Real-looking fixtures that must stay byte-identical.
        const envPath = path.join(project, ".env");
        const awsCred = path.join(home, ".aws", "credentials");
        const npmrc = path.join(home, ".npmrc");
        const envBytes = await writeFixture(
          envPath,
          "REAL=keep-me\n",
        );
        const awsBytes = await writeFixture(
          awsCred,
          "[default]\naws_access_key_id = REALNOTDECOY\n",
        );
        const npmBytes = await writeFixture(
          npmrc,
          "registry=https://registry.npmjs.org/\n",
        );

        const treeBefore = await snapshotTree(project);
        const porcelainBefore = git(project, ["status", "--porcelain"]);

        const initReport = await runInit({
          projectRoot: project,
          home: true,
        });
        expect(initReport.project.created.length).toBeGreaterThanOrEqual(3);
        expect(initReport.homeResult?.created.length).toBeGreaterThanOrEqual(2);
        const tokenId = initReport.project.created[0]?.tokenId;
        if (!tokenId) throw new Error("missing token");

        // Simulated Claude Code JSONL with decoy in tool_result.
        const claudeDir = path.join(home, ".claude", "projects", "-demo");
        await mkdir(claudeDir, { recursive: true });
        const claudeFile = path.join(claudeDir, "sess-e2e.jsonl");
        await writeFile(
          claudeFile,
          `${toolResultClaude(tokenId, "sess-e2e")}\n`,
          "utf8",
        );

        // Simulated Codex session with decoy in function_call_output.
        const codexDir = path.join(
          home,
          ".codex",
          "sessions",
          "2026",
          "10",
          "30",
        );
        await mkdir(codexDir, { recursive: true });
        const codexFile = path.join(
          codexDir,
          "rollout-2026-10-30T12-00-00-e2e1.jsonl",
        );
        await writeFile(codexFile, `${toolResultCodex(tokenId)}\n`, "utf8");

        const scan = await runScan({
          onHit: (h) => notifyHit(h),
        });
        expect(scan.exitCode).toBe(EXIT.FAIL);
        expect(scan.hits.some((h) => h.kind === "read")).toBe(true);
        expect(scan.hits.some((h) => h.adapter === "claude-code")).toBe(true);
        expect(scan.hits.some((h) => h.adapter === "codex")).toBe(true);
        expect(notifyMock.mock.calls.length).toBeGreaterThanOrEqual(1);

        // Watch picks up an appended line.
        const watchHits: string[] = [];
        handle = await startWatch({
          adapters: [
            createClaudeCodeAdapter(home),
            createCodexAdapter(home),
          ],
          initialScan: false,
          onHit: (h) => {
            watchHits.push(h.sessionId);
          },
        });
        await handle.ready;
        await appendFile(
          claudeFile,
          `${toolResultClaude(tokenId, "sess-e2e-append")}\n`,
          "utf8",
        );
        const deadline = Date.now() + 8_000;
        while (
          !watchHits.includes("sess-e2e-append") &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(watchHits).toContain("sess-e2e-append");
        await handle.close();
        handle = undefined;

        await runRemove({ projectRoot: project, home: true });

        expect(git(project, ["status", "--porcelain"])).toBe(porcelainBefore);
        const treeAfter = await snapshotTree(project);
        expect([...treeAfter.keys()].sort()).toEqual(
          [...treeBefore.keys()].sort(),
        );
        for (const [rel, buf] of treeBefore) {
          expect(treeAfter.get(rel)?.equals(buf)).toBe(true);
        }
        expect(await readExact(envPath)).toEqual(envBytes);
        expect(await readExact(awsCred)).toEqual(awsBytes);
        expect(await readExact(npmrc)).toEqual(npmBytes);

        // hits may remain under state dir; decoys must be gone.
        for (const c of initReport.project.created) {
          await expect(readFile(c.path)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } finally {
        await handle?.close();
        restore();
      }
    },
  );
});

describe("glob walk (Node 20, no fs.glob)", () => {
  it("expandGlob finds nested rollout files", async () => {
    const home = await makeTempHome();
    const { expandGlob } = await import("../src/glob-util.js");
    const { codexGlob } = await import("../src/adapters/codex.js");
    const dir = path.join(home, ".codex", "sessions", "2026", "01", "02");
    await mkdir(dir, { recursive: true });
    const f = path.join(dir, "rollout-x.jsonl");
    await writeFile(f, "{}\n", "utf8");
    const found = await expandGlob(codexGlob(home));
    expect(found.map((p) => path.resolve(p))).toContain(path.resolve(f));
  });
});
