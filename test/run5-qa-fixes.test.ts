import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCodexAdapter } from "../src/adapters/codex.js";
import { EXIT } from "../src/exit-codes.js";
import { loadHits } from "../src/hits.js";
import { runInit } from "../src/init.js";
import { notifyHit } from "../src/notify.js";
import { runScan } from "../src/scan.js";
import { formatTokenLabel } from "../src/token-label.js";
import { startWatch } from "../src/watch.js";
import { makeTempHome, makeTempProject, useHome } from "./helpers.js";

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

beforeEach(() => {
  notifyMock.mockClear();
});

afterEach(() => {
  notifyMock.mockClear();
});

describe("watch: missing adapter root (depth-0 ancestor)", () => {
  it(
    "does not recursively watch $HOME; promotes when sessions appears",
    { timeout: 20_000 },
    async () => {
      const home = await makeTempHome();
      const restore = useHome(home);
      let handle: Awaited<ReturnType<typeof startWatch>> | undefined;
      try {
        const project = await makeTempProject(home);
        const report = await runInit({ projectRoot: project });
        const tokenId = report.project.created[0]?.tokenId;
        if (!tokenId) throw new Error("missing token");

        // Decoy deep tree under HOME — must not become a watched subtree.
        const unrelated = path.join(home, "unrelated", "deep", "tree");
        await mkdir(unrelated, { recursive: true });
        await writeFile(path.join(unrelated, "noise.txt"), "noise\n", "utf8");

        // No ~/.codex at all.
        const hits: string[] = [];
        handle = await startWatch({
          adapters: [createCodexAdapter(home)],
          initialScan: false,
          onHit: (h) => {
            hits.push(h.sessionId);
          },
        });
        await handle.ready;

        const watchedKeys = Object.keys(handle.getWatched());
        // chokidar depth 0 still lists immediate child dirs as empty keys, but
        // must not recurse into HOME (no unrelated/deep/...).
        expect(
          watchedKeys.some(
            (k) =>
              k.includes(`${path.sep}unrelated${path.sep}`) ||
              k.endsWith(`${path.sep}unrelated${path.sep}deep`) ||
              k.includes(`${path.sep}unrelated${path.sep}deep`),
          ),
        ).toBe(false);
        const depthUnderHome = (p: string): number => {
          if (p === home) return 0;
          if (!p.startsWith(home + path.sep)) return -1;
          return p.slice(home.length + 1).split(path.sep).length;
        };
        for (const k of watchedKeys) {
          const d = depthUnderHome(k);
          if (d > 1) {
            // Only the manifest state dir (also depth 0) may go one level in.
            expect(k.startsWith(path.join(home, ".agent-tripwire"))).toBe(
              true,
            );
          }
        }

        const sessDir = path.join(
          home,
          ".codex",
          "sessions",
          "2026",
          "10",
          "30",
        );
        await mkdir(sessDir, { recursive: true });

        // Wait until the real sessions root (or a closer ancestor) is attached.
        const promoteDeadline = Date.now() + 8_000;
        while (Date.now() < promoteDeadline) {
          const keys = Object.keys(handle.getWatched());
          if (
            keys.some(
              (k) =>
                k.includes(`${path.sep}.codex${path.sep}sessions`) ||
                k.endsWith(`${path.sep}.codex${path.sep}sessions`) ||
                k.endsWith(`${path.sep}.codex`),
            )
          ) {
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }

        const file = path.join(
          sessDir,
          "rollout-2026-10-30T12-00-00-promo1.jsonl",
        );
        await writeFile(file, `${toolResultCodex(tokenId)}\n`, "utf8");

        const hitDeadline = Date.now() + 10_000;
        while (hits.length === 0 && Date.now() < hitDeadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(hits.length).toBeGreaterThanOrEqual(1);

        // Still must not have walked the unrelated tree past depth 0.
        expect(
          Object.keys(handle.getWatched()).some((k) =>
            k.includes(`${path.sep}unrelated${path.sep}`),
          ),
        ).toBe(false);
      } finally {
        await handle?.close();
        restore();
      }
    },
  );
});

describe("watch: chokidar error handler", () => {
  it(
    "logs watcher errors and keeps detecting later hits",
    { timeout: 20_000 },
    async () => {
      const home = await makeTempHome();
      const restore = useHome(home);
      let handle: Awaited<ReturnType<typeof startWatch>> | undefined;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
        const file = path.join(
          sessDir,
          "rollout-2026-10-30T12-00-00-err1.jsonl",
        );
        await writeFile(file, "", "utf8");

        const hits: string[] = [];
        handle = await startWatch({
          adapters: [createCodexAdapter(home)],
          initialScan: false,
          onHit: (h) => {
            hits.push(h.alertLine);
          },
        });
        await handle.ready;
        expect(handle.watchers.length).toBeGreaterThan(0);

        const boom = Object.assign(new Error("no space left on device"), {
          code: "ENOSPC",
        });
        handle.watchers[0]?.emit("error", boom);

        expect(warn).toHaveBeenCalled();
        const warnText = warn.mock.calls.map((c) => String(c[0])).join(" ");
        expect(warnText).toMatch(/watcher error/);
        expect(warnText).toMatch(/ENOSPC/);

        await appendFile(file, `${toolResultCodex(tokenId)}\n`, "utf8");
        const deadline = Date.now() + 10_000;
        while (hits.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(hits[0]).toContain(formatTokenLabel(tokenId));
        expect(hits[0]).not.toContain(tokenId);
      } finally {
        warn.mockRestore();
        await handle?.close();
        restore();
      }
    },
  );
});

describe("scan: exit 1 while logs stay dirty", () => {
  it("second scan exits 1, does not grow hits.jsonl, and skips notify", async () => {
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
      await writeFile(
        path.join(sessDir, "rollout-2026-10-30T12-00-00-scan2.jsonl"),
        `${toolResultCodex(tokenId)}\n`,
        "utf8",
      );

      const first = await runScan({ onHit: (h) => notifyHit(h) });
      expect(first.exitCode).toBe(EXIT.FAIL);
      expect(first.newHits.length).toBeGreaterThanOrEqual(1);
      expect(notifyMock).toHaveBeenCalled();
      const lines = (await loadHits()).length;

      notifyMock.mockClear();
      const second = await runScan({ onHit: (h) => notifyHit(h) });
      expect(second.exitCode).toBe(EXIT.FAIL);
      expect(second.hits.length).toBeGreaterThanOrEqual(1);
      expect(second.newHits).toHaveLength(0);
      expect(notifyMock).not.toHaveBeenCalled();
      expect((await loadHits()).length).toBe(lines);
    } finally {
      restore();
    }
  });
});
