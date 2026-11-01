import { describe, expect, it } from "vitest";
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { createClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { createConfigAdapter } from "../src/adapters/config-adapter.js";
import { loadAdapters } from "../src/adapters/index.js";
import {
  createSeenMap,
  processFile,
  runScanPass,
} from "../src/engine.js";
import { runInit } from "../src/init.js";
import { loadHits } from "../src/hits.js";
import { loadManifest } from "../src/manifest.js";
import { buildTokenMatcher } from "../src/match.js";
import { loadOffsets, saveOffsets } from "../src/offsets.js";
import {
  getConfigPath,
  getHitsPath,
  getStateDir,
} from "../src/paths.js";
import { runScan } from "../src/scan.js";
import { readNewLines } from "../src/tail.js";
import { formatTokenLabel } from "../src/token-label.js";
import { PRIVATE_FILE_MODE } from "../src/fs-mode.js";
import { startWatch } from "../src/watch.js";
import {
  makeTempHome,
  makeTempProject,
  useHome,
} from "./helpers.js";

/** UNVERIFIED Claude Code JSONL shapes used as synthetic fixtures. */
function toolResultLine(token: string, sessionId: string): string {
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

function assistantSeenLine(token: string, sessionId: string): string {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    timestamp: "2026-10-30T12:01:00.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `I noticed a key that looks like ${token} in the docs.`,
        },
      ],
    },
  });
}

async function plantAndToken(home: string, project: string): Promise<{
  tokenId: string;
  decoyPath: string;
}> {
  const report = await runInit({ projectRoot: project });
  const decoy = report.project.created[0];
  if (!decoy) throw new Error("expected a planted decoy");
  return { tokenId: decoy.tokenId, decoyPath: decoy.path };
}

async function writeClaudeLog(
  home: string,
  session: string,
  lines: string[],
): Promise<string> {
  const dir = path.join(home, ".claude", "projects", "-tmp-demo");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  await writeFile(file, lines.map((l) => `${l}\n`).join(""), "utf8");
  return file;
}

describe("tail offsets", () => {
  it("handles a partial trailing line across reads", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const file = path.join(home, "partial.log");
      await writeFile(file, "hello wor", "utf8");
      const r1 = await readNewLines(file, { offset: 0, partial: "" });
      expect(r1.lines).toEqual([]);
      expect(r1.next.partial).toBe("hello wor");

      await appendFile(file, "ld\nnext", "utf8");
      const r2 = await readNewLines(file, r1.next);
      expect(r2.lines).toEqual(["hello world"]);
      expect(r2.next.partial).toBe("next");
    } finally {
      restore();
    }
  });

  it("resets offset on truncation", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const file = path.join(home, "rot.log");
      await writeFile(file, "line1\nline2\n", "utf8");
      const r1 = await readNewLines(file, { offset: 0, partial: "" });
      expect(r1.lines).toEqual(["line1", "line2"]);

      await writeFile(file, "fresh\n", "utf8");
      const r2 = await readNewLines(file, r1.next);
      expect(r2.truncated).toBe(true);
      expect(r2.lines).toEqual(["fresh"]);
      expect(r2.next.offset).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });
});

describe("watcher engine", () => {
  it("distinguishes read (tool_result) vs seen (assistant text)", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const { tokenId } = await plantAndToken(home, project);
      const adapter = createClaudeCodeAdapter(home);
      const matcher = buildTokenMatcher((await loadManifest()).decoys);
      const offsets = await loadOffsets();
      const seen = createSeenMap();

      const readFilePath = await writeClaudeLog(home, "sess-read", [
        toolResultLine(tokenId, "sess-read"),
      ]);
      const readHits = await processFile({
        filePath: readFilePath,
        adapter,
        matcher,
        offsets,
        seen: createSeenMap(),
      });
      expect(readHits).toHaveLength(1);
      expect(readHits[0]?.kind).toBe("read");
      expect(readHits[0]?.alertLine).toContain(formatTokenLabel(tokenId));
      expect(readHits[0]?.alertLine).not.toContain(tokenId);

      const seenFile = await writeClaudeLog(home, "sess-seen", [
        assistantSeenLine(tokenId, "sess-seen"),
      ]);
      const seenHits = await processFile({
        filePath: seenFile,
        adapter,
        matcher,
        offsets,
        seen,
      });
      expect(seenHits).toHaveLength(1);
      expect(seenHits[0]?.kind).toBe("seen");
    } finally {
      restore();
    }
  });

  it("dedupes per token per session", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const { tokenId } = await plantAndToken(home, project);
      const adapter = createClaudeCodeAdapter(home);
      const matcher = buildTokenMatcher((await loadManifest()).decoys);
      const offsets = await loadOffsets();
      const seen = createSeenMap();

      const file = await writeClaudeLog(home, "sess-dup", [
        toolResultLine(tokenId, "sess-dup"),
      ]);
      const first = await processFile({
        filePath: file,
        adapter,
        matcher,
        offsets,
        seen,
      });
      expect(first).toHaveLength(1);

      await appendFile(file, `${toolResultLine(tokenId, "sess-dup")}\n`, "utf8");
      const second = await processFile({
        filePath: file,
        adapter,
        matcher,
        offsets,
        seen,
      });
      expect(second).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("offsets survive restart so only new content is scanned", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const { tokenId } = await plantAndToken(home, project);
      const adapter = createClaudeCodeAdapter(home);
      const matcher = buildTokenMatcher((await loadManifest()).decoys);

      const file = await writeClaudeLog(home, "sess-off", [
        toolResultLine(tokenId, "sess-off"),
      ]);

      const offsets1 = await loadOffsets();
      const seen1 = createSeenMap();
      const first = await processFile({
        filePath: file,
        adapter,
        matcher,
        offsets: offsets1,
        seen: seen1,
      });
      expect(first).toHaveLength(1);
      await saveOffsets(offsets1);

      // "Restart": reload offsets, fresh dedupe map — should not re-hit old line.
      const offsets2 = await loadOffsets();
      const seen2 = createSeenMap();
      const again = await processFile({
        filePath: file,
        adapter,
        matcher,
        offsets: offsets2,
        seen: seen2,
      });
      expect(again).toHaveLength(0);

      await appendFile(
        file,
        `${toolResultLine(tokenId, "sess-off-2")}\n`,
        "utf8",
      );
      const third = await processFile({
        filePath: file,
        adapter,
        matcher,
        offsets: offsets2,
        seen: seen2,
      });
      expect(third).toHaveLength(1);
      expect(third[0]?.sessionId).toBe("sess-off-2");
    } finally {
      restore();
    }
  });

  it("truncation resets the offset and can fire again", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const { tokenId } = await plantAndToken(home, project);
      const adapter = createClaudeCodeAdapter(home);
      const matcher = buildTokenMatcher((await loadManifest()).decoys);
      const offsets = await loadOffsets();
      const seen = createSeenMap();

      const file = await writeClaudeLog(home, "sess-trunc", [
        toolResultLine(tokenId, "sess-trunc"),
      ]);
      expect(
        (
          await processFile({
            filePath: file,
            adapter,
            matcher,
            offsets,
            seen,
          })
        ).length,
      ).toBe(1);

      // Truncation is detected by size shrinking — empty the file first.
      await writeFile(file, "", "utf8");
      const mid = await processFile({
        filePath: file,
        adapter,
        matcher,
        offsets,
        seen,
      });
      expect(mid).toHaveLength(0);
      expect(offsets[path.resolve(file)]?.offset).toBe(0);

      await writeFile(
        file,
        `${toolResultLine(tokenId, "sess-trunc-b")}\n`,
        "utf8",
      );
      const after = await processFile({
        filePath: file,
        adapter,
        matcher,
        offsets,
        seen,
      });
      expect(after).toHaveLength(1);
      expect(after[0]?.sessionId).toBe("sess-trunc-b");
    } finally {
      restore();
    }
  });

  it("scan exits 1 on hits and 0 when clean", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await plantAndToken(home, project);

      const clean = await runScan();
      expect(clean.exitCode).toBe(0);
      expect(clean.hits).toHaveLength(0);

      const manifest = await loadManifest();
      const tokenId = manifest.decoys[0]?.tokenId;
      if (!tokenId) throw new Error("missing token");
      await writeClaudeLog(home, "sess-scan", [
        toolResultLine(tokenId, "sess-scan"),
      ]);

      const dirty = await runScan();
      expect(dirty.exitCode).toBe(1);
      expect(dirty.hits.length).toBeGreaterThanOrEqual(1);
      for (const h of dirty.hits) {
        expect(h.alertLine).not.toContain(tokenId);
        expect(h.alertLine).toContain(formatTokenLabel(tokenId));
      }
    } finally {
      restore();
    }
  });

  it("config adapter glob is scanned", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const { tokenId } = await plantAndToken(home, project);

      await mkdir(getStateDir(), { recursive: true });
      await writeFile(
        getConfigPath(),
        JSON.stringify({
          adapters: [
            {
              name: "custom-log",
              glob: "custom-logs/*.log",
              format: "text",
            },
          ],
        }),
        "utf8",
      );

      const logDir = path.join(home, "custom-logs");
      await mkdir(logDir, { recursive: true });
      const logFile = path.join(logDir, "app.log");
      await writeFile(logFile, `leaked ${tokenId}\n`, "utf8");

      const adapters = await loadAdapters(home);
      expect(adapters.some((a) => a.id === "config:custom-log")).toBe(true);

      const { hits } = await runScanPass({ adapters, fromStart: true });
      expect(hits.some((h) => h.tool === "custom-log")).toBe(true);
      expect(hits.some((h) => h.sourceFile === logFile)).toBe(true);
    } finally {
      restore();
    }
  });

  it("does not false-hit on tripwire init redacted output", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const report = await runInit({ projectRoot: project });
      const tokenId = report.project.created[0]?.tokenId;
      if (!tokenId) throw new Error("missing token");
      const label = formatTokenLabel(tokenId);

      // Simulate init stdout (redacted labels only) landing in a watched log.
      await writeClaudeLog(home, "sess-init-out", [
        JSON.stringify({
          type: "assistant",
          sessionId: "sess-init-out",
          message: {
            content: [
              {
                type: "text",
                text: `Planted project decoys\n  created .env.backup (${label})`,
              },
            ],
          },
        }),
      ]);

      const result = await runScan();
      expect(result.hits).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    } finally {
      restore();
    }
  });

  it("writes hits.jsonl with mode 0600 and never stores nothing on empty scan", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const { tokenId } = await plantAndToken(home, project);
      await writeClaudeLog(home, "sess-mode", [
        toolResultLine(tokenId, "sess-mode"),
      ]);
      await runScan();
      const hitsPath = getHitsPath();
      const mode = (await stat(hitsPath)).mode & 0o777;
      expect(mode).toBe(PRIVATE_FILE_MODE);
      const body = await readFile(hitsPath, "utf8");
      expect(body).toContain(tokenId); // full id only in the private hits log
      expect(body).toContain('"kind":"read"');
    } finally {
      restore();
    }
  });

  it("matches generated secret-likes from matchValues", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await runInit({ projectRoot: project });
      const decoy = (await loadManifest()).decoys[0];
      if (!decoy?.matchValues || decoy.matchValues.length < 2) {
        throw new Error("expected matchValues with secret");
      }
      const secret = decoy.matchValues.find((v) => v !== decoy.tokenId);
      if (!secret) throw new Error("expected secret-like");

      const adapter = createConfigAdapter(
        { name: "sec", glob: "sec.log", format: "text" },
        0,
        home,
      );
      await writeFile(path.join(home, "sec.log"), `secret=${secret}\n`, "utf8");
      const { hits } = await runScanPass({
        adapters: [adapter],
        fromStart: true,
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.tokenId).toBe(decoy.tokenId);
    } finally {
      restore();
    }
  });

  it("scan matches a token on a trailing partial line without newline", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const { tokenId } = await plantAndToken(home, project);
      const dir = path.join(home, ".claude", "projects", "-tmp-demo");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, "sess-partial-eof.jsonl");
      // No trailing newline — scan must still see this line.
      await writeFile(file, toolResultLine(tokenId, "sess-partial-eof"), "utf8");

      const dirty = await runScan();
      expect(dirty.exitCode).toBe(1);
      expect(dirty.hits.length).toBeGreaterThanOrEqual(1);
      expect(dirty.hits[0]?.kind).toBe("read");
    } finally {
      restore();
    }
  });

  it("dedupes on adapter+sourceFile+sessionId so same basename in different dirs yields 2 hits", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const { tokenId } = await plantAndToken(home, project);
      const adapter = createClaudeCodeAdapter(home);
      const matcher = buildTokenMatcher((await loadManifest()).decoys);
      const offsets = await loadOffsets();
      const seen = createSeenMap();

      const dirA = path.join(home, ".claude", "projects", "-proj-a");
      const dirB = path.join(home, ".claude", "projects", "-proj-b");
      await mkdir(dirA, { recursive: true });
      await mkdir(dirB, { recursive: true });
      const fileA = path.join(dirA, "same-name.jsonl");
      const fileB = path.join(dirB, "same-name.jsonl");
      await writeFile(
        fileA,
        `${toolResultLine(tokenId, "same-name")}\n`,
        "utf8",
      );
      await writeFile(
        fileB,
        `${toolResultLine(tokenId, "same-name")}\n`,
        "utf8",
      );

      const hitsA = await processFile({
        filePath: fileA,
        adapter,
        matcher,
        offsets,
        seen,
      });
      const hitsB = await processFile({
        filePath: fileB,
        adapter,
        matcher,
        offsets,
        seen,
      });
      expect(hitsA).toHaveLength(1);
      expect(hitsB).toHaveLength(1);
      expect(hitsA[0]?.sourceFile).not.toBe(hitsB[0]?.sourceFile);
    } finally {
      restore();
    }
  });

  it("running scan twice does not append duplicate hits", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const { tokenId } = await plantAndToken(home, project);
      await writeClaudeLog(home, "sess-twice", [
        toolResultLine(tokenId, "sess-twice"),
      ]);

      const first = await runScan();
      expect(first.exitCode).toBe(1);
      expect(first.hits.length).toBeGreaterThanOrEqual(1);
      const linesAfterFirst = (await loadHits()).length;

      const second = await runScan();
      expect(second.hits).toHaveLength(0);
      expect(second.exitCode).toBe(0);
      expect((await loadHits()).length).toBe(linesAfterFirst);
    } finally {
      restore();
    }
  });

  it(
    "startWatch fires onHit when a tool_result line is appended",
    { timeout: 15_000 },
    async () => {
      const home = await makeTempHome();
      const restore = useHome(home);
      let handle: Awaited<ReturnType<typeof startWatch>> | undefined;
      try {
        const project = await makeTempProject(home);
        const { tokenId } = await plantAndToken(home, project);
        const dir = path.join(home, ".claude", "projects", "-tmp-demo");
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, "sess-live.jsonl");
        await writeFile(file, "", "utf8");

        const hits: string[] = [];
        handle = await startWatch({
          adapters: [createClaudeCodeAdapter(home)],
          initialScan: false,
          onHit: (h) => {
            hits.push(h.tokenId);
          },
        });
        await handle.ready;

        await appendFile(
          file,
          `${toolResultLine(tokenId, "sess-live")}\n`,
          "utf8",
        );

        const deadline = Date.now() + 8_000;
        while (hits.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(hits).toEqual([tokenId]);
      } finally {
        await handle?.close();
        restore();
      }
    },
  );

  it(
    "rebuilds matcher when manifest.json changes during watch",
    { timeout: 20_000 },
    async () => {
      const home = await makeTempHome();
      const restore = useHome(home);
      let handle: Awaited<ReturnType<typeof startWatch>> | undefined;
      try {
        const project = await makeTempProject(home);
        // Pre-create Claude projects dir so chokidar has a root to watch.
        const dir = path.join(home, ".claude", "projects", "-tmp-demo");
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, "sess-late.jsonl");
        await writeFile(file, "", "utf8");

        const hits: string[] = [];
        handle = await startWatch({
          adapters: [createClaudeCodeAdapter(home)],
          initialScan: false,
          onHit: (h) => {
            hits.push(h.tokenId);
          },
        });
        await handle.ready;

        // Plant decoys while watch is already running.
        const { tokenId } = await plantAndToken(home, project);

        // Give the manifest watcher a moment to reload the matcher.
        await new Promise((r) => setTimeout(r, 400));

        await appendFile(
          file,
          `${toolResultLine(tokenId, "sess-late")}\n`,
          "utf8",
        );

        const deadline = Date.now() + 10_000;
        while (hits.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(hits).toEqual([tokenId]);
      } finally {
        await handle?.close();
        restore();
      }
    },
  );
});

describe("claude parser tolerance (UNVERIFIED shapes)", () => {
  it("falls back to raw text when line is not JSON", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const { tokenId } = await plantAndToken(home, project);
      const adapter = createClaudeCodeAdapter(home);
      const parsed = adapter.parse(
        `plain log line containing ${tokenId}`,
        path.join(home, "x.jsonl"),
      );
      expect(parsed?.isToolResult).toBe(false);
      expect(parsed?.text).toContain(tokenId);
    } finally {
      restore();
    }
  });
});
