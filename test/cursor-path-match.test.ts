import { describe, expect, it } from "vitest";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createClaudeCodeAdapter,
  parseClaudeCodeLine,
} from "../src/adapters/claude-code.js";
import {
  createCursorAdapter,
  parseCursorLine,
  cursorGlob,
} from "../src/adapters/cursor.js";
import { loadAdapters } from "../src/adapters/index.js";
import {
  createSeenMap,
  processFile,
  runScanPass,
} from "../src/engine.js";
import { runInit } from "../src/init.js";
import { loadManifest, type DecoyRecord } from "../src/manifest.js";
import { buildTokenMatcher } from "../src/match.js";
import { loadOffsets } from "../src/offsets.js";
import {
  appendHit,
  loadHits,
  seedSeenFromHits,
} from "../src/hits.js";
import {
  commandMentionsDecoy,
  decoyBelongsToTranscriptProject,
  findDecoyForToolPath,
  findDecoyMentionedInCommand,
  normalizeProjectIdentity,
  pathRefersToDecoy,
  toCursorProjectSlug,
} from "../src/path-match.js";
import { formatRemoveReport, runRemove } from "../src/remove.js";
import { formatTokenLabel } from "../src/token-label.js";
import {
  initGitRepo,
  makeTempHome,
  makeTempProject,
  useHome,
} from "./helpers.js";

function cursorSessionFile(
  home: string,
  slug: string,
  sessionId: string,
): string {
  return path.join(
    home,
    ".cursor",
    "projects",
    slug,
    "agent-transcripts",
    sessionId,
    `${sessionId}.jsonl`,
  );
}

function cursorAssistantToolUse(
  name: string,
  input: Record<string, unknown>,
  id = "tool_1",
): string {
  return JSON.stringify({
    role: "assistant",
    message: {
      content: [{ type: "tool_use", name, input, id }],
    },
  });
}

describe("path matcher", () => {
  it("matches canonical absolute paths and project-relative suffixes", () => {
    // Use a native absolute root so canonicalize/resolve behave on win32.
    const projectRoot = path.resolve(path.join("tripwire-path-match-proj"));
    const decoyPath = path.join(projectRoot, ".env.backup");
    const decoy: DecoyRecord = {
      path: decoyPath,
      sha256: "abc",
      tokenId: "tw_test_token_xxxx",
      createdAt: new Date().toISOString(),
      scope: "project",
      projectRoot,
    };

    expect(pathRefersToDecoy(decoyPath, decoy)).toBe(true);
    expect(
      pathRefersToDecoy(path.join(projectRoot, "config", "other.json"), decoy),
    ).toBe(false);
    expect(pathRefersToDecoy(".env.backup", decoy)).toBe(true);
    expect(pathRefersToDecoy("config/.env.backup", decoy)).toBe(true);

    // Same-root absolute with native separators (incl. backslash on win32).
    const viaSep = [projectRoot, ".env.backup"].join(path.sep);
    expect(pathRefersToDecoy(viaSep, decoy)).toBe(true);

    // Foreign Windows absolute vs POSIX-shaped decoy root: only meaningful on
    // non-win32 (on win32 both sides are Windows absolutes and must share a root).
    if (process.platform !== "win32") {
      expect(
        pathRefersToDecoy(
          "C:\\Users\\Name\\Documents\\GitHub\\LAMP\\.env.backup",
          decoy,
        ),
      ).toBe(true);
      expect(
        findDecoyForToolPath(
          "C:\\Users\\Name\\Documents\\GitHub\\LAMP\\README.md",
          [decoy],
        ),
      ).toBeNull();
    } else {
      // Unrelated absolute path with the same basename must not match.
      expect(
        pathRefersToDecoy(
          "C:\\Users\\Name\\Documents\\GitHub\\LAMP\\.env.backup",
          decoy,
        ),
      ).toBe(false);
    }
  });

  it("shell command mentions basename / relative path with boundaries", () => {
    const decoy: DecoyRecord = {
      path: path.join("/proj", "config", "secrets.legacy.json"),
      sha256: "abc",
      tokenId: "tw_test_token_yyyy",
      createdAt: new Date().toISOString(),
      scope: "project",
      projectRoot: "/proj",
    };
    expect(
      commandMentionsDecoy("cat config/secrets.legacy.json", decoy),
    ).toBe(true);
    expect(commandMentionsDecoy("echo hello", decoy)).toBe(false);
    expect(commandMentionsDecoy("cat .env.backup.example", {
      ...decoy,
      path: path.join("/proj", ".env.backup"),
    })).toBe(false);
    expect(commandMentionsDecoy("echo foo.env.backup", {
      ...decoy,
      path: path.join("/proj", ".env.backup"),
    })).toBe(false);
  });

  it("win32 path compare is case-insensitive", () => {
    if (process.platform !== "win32") return;
    const projectRoot = process.cwd();
    const decoyPath = path.join(projectRoot, ".env.backup");
    const decoy: DecoyRecord = {
      path: decoyPath,
      sha256: "abc",
      tokenId: "tw_case_token_zzzz",
      createdAt: new Date().toISOString(),
      scope: "project",
      projectRoot,
    };
    const flipped = decoyPath
      .split("")
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
      .join("");
    expect(pathRefersToDecoy(flipped, decoy)).toBe(true);
  });
});

describe("Cursor adapter", () => {
  it("exposes the agent-transcripts glob and is loaded by default", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      expect(cursorGlob(home).replace(/\\/g, "/")).toContain(
        ".cursor/projects/",
      );
      expect(cursorGlob(home).replace(/\\/g, "/")).toContain(
        "agent-transcripts",
      );
      const adapters = await loadAdapters(home);
      expect(adapters.some((a) => a.id === "cursor")).toBe(true);
    } finally {
      restore();
    }
  });

  it("derives sessionId from the session folder/file name", () => {
    const file = cursorSessionFile(
      "/tmp/home",
      "c-Users-Name-Documents-GitHub-LAMP",
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    const parsed = parseCursorLine(
      cursorAssistantToolUse("Read", { path: "/tmp/x" }),
      file,
    );
    expect(parsed?.sessionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(parsed?.tool).toBe("cursor");
    expect(parsed?.isToolResult).toBe(false);
    expect(parsed?.pathSignals?.[0]?.kind).toBe("read-attempt");
  });

  it("flags decoy Read (POSIX), ignores non-decoy Read, shell-mention, CRLF", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      const report = await runInit({ projectRoot: project });
      const decoy = report.project.created.find((d) =>
        d.path.endsWith(".env.backup"),
      );
      if (!decoy) throw new Error("expected .env.backup decoy");
      const decoys = (await loadManifest()).decoys;
      const matcher = buildTokenMatcher(decoys);
      const adapter = createCursorAdapter(home);
      const sessionId = "11111111-2222-4333-8444-555555555555";
      const slug = toCursorProjectSlug(project);
      const file = cursorSessionFile(home, slug, sessionId);
      await mkdir(path.dirname(file), { recursive: true });

      // Also drop non-jsonl siblings that must be ignored by the glob.
      await writeFile(path.join(path.dirname(file), "INDEX.md"), "# idx\n");
      await writeFile(
        path.join(path.dirname(file), "segment_000.md"),
        "seg\n",
      );

      const lines = [
        cursorAssistantToolUse("Read", {
          path: path.join(project, "README"),
        }),
        cursorAssistantToolUse(
          "Read",
          { path: decoy.path },
          "tool_decoy_read",
        ),
      ];
      // CRLF JSONL (Windows-shaped transcripts).
      await writeFile(file, `${lines.join("\r\n")}\r\n`, "utf8");

      const hits = await processFile({
        filePath: file,
        adapter,
        matcher,
        decoys,
        offsets: await loadOffsets(),
        seen: createSeenMap(),
      });

      expect(hits.some((h) => h.kind === "read-attempt")).toBe(true);
      expect(hits.every((h) => h.tool === "cursor")).toBe(true);
      expect(hits.every((h) => h.sessionId === sessionId)).toBe(true);
      for (const h of hits) {
        expect(h.alertLine).toContain("cursor");
        expect(h.alertLine).toContain("decoy");
        expect(h.alertLine).toContain(formatTokenLabel(h.tokenId));
        expect(h.alertLine).not.toContain(h.tokenId);
        expect(h.signals).toContain("path");
      }
      // Non-decoy Read must not produce a hit by itself.
      expect(
        hits.filter((h) => h.kind === "read-attempt"),
      ).toHaveLength(1);

      // Shell-mention in a separate session (same decoy tokenId would
      // otherwise dedupe against the read-attempt above).
      const shellSession = "22222222-3333-4444-8555-666666666666";
      const shellFile = cursorSessionFile(home, slug, shellSession);
      await mkdir(path.dirname(shellFile), { recursive: true });
      await writeFile(
        shellFile,
        `${cursorAssistantToolUse(
          "Shell",
          { command: "cat .env.backup", description: "peek" },
          "tool_shell",
        )}\n`,
        "utf8",
      );
      const shellHits = await processFile({
        filePath: shellFile,
        adapter,
        matcher,
        decoys,
        offsets: await loadOffsets(),
        seen: createSeenMap(),
      });
      expect(shellHits.some((h) => h.kind === "shell-mention")).toBe(true);

      // Glob expansion finds *.jsonl and ignores INDEX.md / segment md.
      const { hits: scanHits } = await runScanPass({
        adapters: [adapter],
        decoys,
        fromStart: true,
        seedFromHits: false,
      });
      expect(scanHits.length).toBeGreaterThanOrEqual(2);
    } finally {
      restore();
    }
  });

  it("matches a Windows backslash Read path against a decoy", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      await runInit({ projectRoot: project });
      const decoys = (await loadManifest()).decoys;
      const envDecoy = decoys.find((d) => d.path.endsWith(".env.backup"));
      if (!envDecoy) throw new Error("missing decoy");

      // On win32 use the real decoy path (already backslash-separated). On
      // POSIX, feed a foreign Windows absolute that shares the relative suffix
      // (cross-platform fixture shape from the real Cursor log check).
      const toolPath =
        process.platform === "win32"
          ? envDecoy.path
          : "C:\\Users\\Name\\Documents\\GitHub\\LAMP\\.env.backup";

      const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const file = cursorSessionFile(
        home,
        "c-Users-Name-Documents-GitHub-LAMP",
        sessionId,
      );
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        `${cursorAssistantToolUse("Read", { path: toolPath })}\n`,
        "utf8",
      );

      const hits = await processFile({
        filePath: file,
        adapter: createCursorAdapter(home),
        matcher: buildTokenMatcher(decoys),
        decoys,
        offsets: await loadOffsets(),
        seen: createSeenMap(),
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.kind).toBe("read-attempt");
      expect(hits[0]?.decoyPath).toBe(envDecoy.path);
      expect(hits[0]?.alertLine).toMatch(/cursor read-attempt decoy/);
    } finally {
      restore();
    }
  });

  it("Write alone is write-attempt; Write+token echo merges preferring token", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      const report = await runInit({ projectRoot: project });
      const decoy = report.project.created.find((d) =>
        d.path.endsWith(".env.backup"),
      );
      if (!decoy) throw new Error("missing decoy");
      const decoys = (await loadManifest()).decoys;
      const adapter = createCursorAdapter(home);
      const matcher = buildTokenMatcher(decoys);

      const writeOnlySession = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
      const writeOnlyFile = cursorSessionFile(
        home,
        "proj-slug",
        writeOnlySession,
      );
      await mkdir(path.dirname(writeOnlyFile), { recursive: true });
      await writeFile(
        writeOnlyFile,
        `${cursorAssistantToolUse("Write", {
          path: decoy.path,
          contents: "x",
        })}\n`,
        "utf8",
      );
      const writeHits = await processFile({
        filePath: writeOnlyFile,
        adapter,
        matcher,
        decoys,
        offsets: await loadOffsets(),
        seen: createSeenMap(),
      });
      expect(writeHits).toHaveLength(1);
      expect(writeHits[0]?.kind).toBe("write-attempt");

      const mergeSession = "cccccccc-dddd-4eee-8fff-000000000000";
      const mergeFile = cursorSessionFile(home, "proj-slug", mergeSession);
      await mkdir(path.dirname(mergeFile), { recursive: true });
      await writeFile(
        mergeFile,
        [
          cursorAssistantToolUse("Write", {
            path: decoy.path,
            contents: "x",
          }),
          JSON.stringify({
            role: "assistant",
            message: {
              content: [
                {
                  type: "text",
                  text: `I saw token ${decoy.tokenId} in chat`,
                },
              ],
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const hits = await processFile({
        filePath: mergeFile,
        adapter,
        matcher,
        decoys,
        offsets: await loadOffsets(),
        seen: createSeenMap(),
      });
      // Prefer token proof; path signal still recorded.
      expect(hits).toHaveLength(1);
      expect(hits[0]?.kind).toBe("seen");
      expect(hits[0]?.signals?.sort()).toEqual(["path", "token"]);
      expect(hits[0]?.alertLine).not.toContain(decoy.tokenId);
    } finally {
      restore();
    }
  });
});

describe("Claude path matching + dedupe", () => {
  it("merges path tool_use + token tool_result into one preferred token hit", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      const report = await runInit({ projectRoot: project });
      const decoy = report.project.created.find((d) =>
        d.path.endsWith(".env.backup"),
      );
      if (!decoy) throw new Error("missing decoy");
      const decoys = (await loadManifest()).decoys;
      const toolUseId = "toolu_dedupe_1";

      const dir = path.join(home, ".claude", "projects", "-demo");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, "sess-dedupe.jsonl");
      await writeFile(
        file,
        [
          JSON.stringify({
            type: "assistant",
            sessionId: "sess-dedupe",
            timestamp: "2026-10-31T12:00:00.000Z",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: toolUseId,
                  name: "Read",
                  input: { file_path: decoy.path },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            sessionId: "sess-dedupe",
            timestamp: "2026-10-31T12:00:01.000Z",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: `AWS_ACCESS_KEY_ID=${decoy.tokenId}\n`,
                },
              ],
            },
            toolUseResult: {
              content: `AWS_ACCESS_KEY_ID=${decoy.tokenId}\n`,
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const hits = await processFile({
        filePath: file,
        adapter: createClaudeCodeAdapter(home),
        matcher: buildTokenMatcher(decoys),
        decoys,
        offsets: await loadOffsets(),
        seen: createSeenMap(),
      });

      expect(hits).toHaveLength(1);
      expect(hits[0]?.kind).toBe("read");
      expect(hits[0]?.signals?.sort()).toEqual(["path", "token"]);
      expect(hits[0]?.toolUseId).toBe(toolUseId);
      expect(hits[0]?.alertLine).toContain("read decoy");
      expect(hits[0]?.alertLine).not.toContain(decoy.tokenId);
    } finally {
      restore();
    }
  });

  it("path-only Claude Read is read-attempt when no tool_result token", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      const report = await runInit({ projectRoot: project });
      const decoy = report.project.created.find((d) =>
        d.path.endsWith(".env.backup"),
      );
      if (!decoy) throw new Error("missing decoy");
      const decoys = (await loadManifest()).decoys;

      const parsed = parseClaudeCodeLine(
        JSON.stringify({
          type: "assistant",
          sessionId: "sess-path-only",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_path",
                name: "Read",
                input: { file_path: decoy.path },
              },
            ],
          },
        }),
        path.join(home, ".claude", "projects", "x", "sess.jsonl"),
      );
      expect(parsed?.pathSignals?.[0]?.kind).toBe("read-attempt");
      expect(parsed?.isToolResult).toBe(false);

      const dir = path.join(home, ".claude", "projects", "-path-only");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, "sess-path-only.jsonl");
      await writeFile(file, `${JSON.stringify({
        type: "assistant",
        sessionId: "sess-path-only",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_path",
              name: "Read",
              input: { file_path: decoy.path },
            },
          ],
        },
      })}\n`, "utf8");

      const hits = await processFile({
        filePath: file,
        adapter: createClaudeCodeAdapter(home),
        matcher: buildTokenMatcher(decoys),
        decoys,
        offsets: await loadOffsets(),
        seen: createSeenMap(),
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.kind).toBe("read-attempt");
      expect(hits[0]?.signals).toEqual(["path"]);
    } finally {
      restore();
    }
  });
});

describe("cross-batch token upgrade (live watch)", () => {
  it("tool_use then tool_result in separate processFile calls upgrades to read", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      const report = await runInit({ projectRoot: project });
      const decoy = report.project.created.find((d) =>
        d.path.endsWith(".env.backup"),
      );
      if (!decoy) throw new Error("missing decoy");
      const decoys = (await loadManifest()).decoys;
      const adapter = createClaudeCodeAdapter(home);
      const matcher = buildTokenMatcher(decoys);
      const toolUseId = "toolu_live_upgrade";

      const dir = path.join(home, ".claude", "projects", "-live-upgrade");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, "sess-live.jsonl");
      await writeFile(file, "", "utf8");

      const offsets = await loadOffsets();
      const seen = createSeenMap();

      await appendFile(
        file,
        `${JSON.stringify({
          type: "assistant",
          sessionId: "sess-live",
          cwd: project,
          message: {
            content: [
              {
                type: "tool_use",
                id: toolUseId,
                name: "Read",
                input: { file_path: decoy.path },
              },
            ],
          },
        })}\n`,
        "utf8",
      );

      const first = await processFile({
        filePath: file,
        adapter,
        matcher,
        decoys,
        offsets,
        seen,
      });
      expect(first).toHaveLength(1);
      expect(first[0]?.kind).toBe("read-attempt");
      expect(first[0]?.isNew).toBe(true);

      await appendFile(
        file,
        `${JSON.stringify({
          type: "user",
          sessionId: "sess-live",
          cwd: project,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                content: `AWS_ACCESS_KEY_ID=${decoy.tokenId}\n`,
              },
            ],
          },
          toolUseResult: {
            content: `AWS_ACCESS_KEY_ID=${decoy.tokenId}\n`,
          },
        })}\n`,
        "utf8",
      );

      const second = await processFile({
        filePath: file,
        adapter,
        matcher,
        decoys,
        offsets,
        seen,
      });
      expect(second).toHaveLength(1);
      expect(second[0]?.kind).toBe("read");
      expect(second[0]?.isNew).toBe(true);
      expect(second[0]?.signals?.sort()).toEqual(["path", "token"]);
      expect(second[0]?.alertLine).toContain("read decoy");
      expect(second[0]?.alertLine).not.toContain(decoy.tokenId);

      const persisted = await loadHits();
      const kinds = persisted
        .filter((h) => h.tokenId === decoy.tokenId)
        .map((h) => h.kind);
      expect(kinds).toContain("read-attempt");
      expect(kinds).toContain("read");
    } finally {
      restore();
    }
  });

  it("seeded path-only hits still allow a later token read upgrade", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      const report = await runInit({ projectRoot: project });
      const decoy = report.project.created.find((d) =>
        d.path.endsWith(".env.backup"),
      );
      if (!decoy) throw new Error("missing decoy");
      const decoys = (await loadManifest()).decoys;

      const sourceFile = path.join(
        home,
        ".claude",
        "projects",
        "-restart",
        "sess.jsonl",
      );
      await appendHit({
        at: new Date().toISOString(),
        tokenId: decoy.tokenId,
        kind: "read-attempt",
        adapter: "claude-code",
        tool: "claude-code",
        sessionId: "sess-restart",
        sourceFile: path.resolve(sourceFile),
        decoyPath: decoy.path,
        snippet: decoy.path,
        signals: ["path"],
      });

      await mkdir(path.dirname(sourceFile), { recursive: true });
      await writeFile(
        sourceFile,
        `${JSON.stringify({
          type: "user",
          sessionId: "sess-restart",
          cwd: project,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_restart",
                content: `KEY=${decoy.tokenId}\n`,
              },
            ],
          },
          toolUseResult: { content: `KEY=${decoy.tokenId}\n` },
        })}\n`,
        "utf8",
      );

      const seen = seedSeenFromHits(await loadHits());
      const hits = await processFile({
        filePath: sourceFile,
        adapter: createClaudeCodeAdapter(home),
        matcher: buildTokenMatcher(decoys),
        decoys,
        offsets: await loadOffsets(),
        seen,
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.kind).toBe("read");
      expect(hits[0]?.signals?.sort()).toEqual(["path", "token"]);
    } finally {
      restore();
    }
  });
});

describe("Windows home-with-space project identity", () => {
  // Real slugs from a Windows 11 machine whose home is
  // C:\Users\Ashwini Chauhan (verified on-host).
  const winHomeRoot = String.raw`C:\Users\Ashwini Chauhan\tripwire-sandbox`;
  const cursorSandboxSlug = "c-Users-Ashwini-Chauhan-tripwire-sandbox";
  const cursorLampSlug = "c-Users-Ashwini-Chauhan-Documents-GitHub-LAMP";
  const claudeSandboxSlug = "C--Users-Ashwini-Chauhan-tripwire-sandbox";

  const sandboxDecoy: DecoyRecord = {
    path: String.raw`C:\Users\Ashwini Chauhan\tripwire-sandbox\.env.backup`,
    sha256: "abc",
    tokenId: "tw_win_space_token_xxxx",
    createdAt: new Date().toISOString(),
    scope: "project",
    projectRoot: winHomeRoot,
  };

  it("normalizes Cursor and Claude slugs onto the same projectRoot key", () => {
    const key = normalizeProjectIdentity(winHomeRoot);
    expect(normalizeProjectIdentity(cursorSandboxSlug)).toBe(key);
    expect(normalizeProjectIdentity(claudeSandboxSlug)).toBe(key);
    expect(normalizeProjectIdentity(cursorLampSlug)).not.toBe(key);
  });

  it("Cursor shell-mention hits for the sandbox slug, not the LAMP slug", () => {
    const cmd = "type .env.backup";
    expect(
      findDecoyMentionedInCommand(cmd, [sandboxDecoy], {
        adapterId: "cursor",
        projectHint: cursorSandboxSlug,
      }),
    ).toBe(sandboxDecoy);
    expect(
      findDecoyMentionedInCommand(cmd, [sandboxDecoy], {
        adapterId: "cursor",
        projectHint: cursorLampSlug,
      }),
    ).toBeNull();
  });

  it("Claude fallback slug C--Users-… matches the spaced projectRoot", () => {
    expect(
      decoyBelongsToTranscriptProject(sandboxDecoy, {
        adapterId: "claude-code",
        projectHint: claudeSandboxSlug,
      }),
    ).toBe(true);
  });

  it("does not treat a projectRoot prefix as a match (app vs app2)", () => {
    const app: DecoyRecord = {
      ...sandboxDecoy,
      path: String.raw`C:\Users\X\app\.env.backup`,
      projectRoot: String.raw`C:\Users\X\app`,
      tokenId: "tw_app_token_xxxx",
    };
    expect(
      decoyBelongsToTranscriptProject(app, {
        adapterId: "cursor",
        projectHint: "c-Users-X-app2",
      }),
    ).toBe(false);
    expect(
      decoyBelongsToTranscriptProject(app, {
        adapterId: "cursor",
        projectHint: "c-Users-X-app",
      }),
    ).toBe(true);
    expect(normalizeProjectIdentity(String.raw`C:\Users\X\app`)).not.toBe(
      normalizeProjectIdentity(String.raw`C:\Users\X\app2`),
    );
  });
});

describe("shell-mention scoping and boundaries", () => {
  async function plantCursorShellFixture(): Promise<{
    home: string;
    restore: () => void;
    project: string;
    decoys: DecoyRecord[];
    slug: string;
    adapter: ReturnType<typeof createCursorAdapter>;
    matcher: ReturnType<typeof buildTokenMatcher>;
  }> {
    const home = await makeTempHome();
    const restore = useHome(home);
    const project = await makeTempProject(home);
    await initGitRepo(project);
    await runInit({ projectRoot: project });
    const decoys = (await loadManifest()).decoys;
    return {
      home,
      restore,
      project,
      decoys,
      slug: toCursorProjectSlug(project),
      adapter: createCursorAdapter(home),
      matcher: buildTokenMatcher(decoys),
    };
  }

  async function shellHits(
    opts: {
      home: string;
      slug: string;
      session: string;
      command: string;
      decoys: DecoyRecord[];
      adapter: ReturnType<typeof createCursorAdapter>;
      matcher: ReturnType<typeof buildTokenMatcher>;
    },
  ) {
    const file = cursorSessionFile(opts.home, opts.slug, opts.session);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${cursorAssistantToolUse("Shell", { command: opts.command })}\n`,
      "utf8",
    );
    return processFile({
      filePath: file,
      adapter: opts.adapter,
      matcher: opts.matcher,
      decoys: opts.decoys,
      offsets: await loadOffsets(),
      seen: createSeenMap(),
    });
  }

  it("echo .env.backup in an unrelated project gives no hit", async () => {
    const fx = await plantCursorShellFixture();
    try {
      const hits = await shellHits({
        ...fx,
        slug: "c-Users-Other-Documents-OtherRepo",
        session: "shell-unrelated-echo",
        command: "echo .env.backup >> .gitignore",
      });
      expect(hits).toHaveLength(0);
      expect(
        findDecoyMentionedInCommand(
          "echo .env.backup >> .gitignore",
          fx.decoys,
          {
            adapterId: "cursor",
            projectHint: "c-Users-Other-Documents-OtherRepo",
          },
        ),
      ).toBeNull();
    } finally {
      fx.restore();
    }
  });

  it("cat .env.backup.example gives no hit", async () => {
    const fx = await plantCursorShellFixture();
    try {
      const hits = await shellHits({
        ...fx,
        session: "shell-example-suffix",
        command: "cat .env.backup.example",
      });
      expect(hits).toHaveLength(0);
    } finally {
      fx.restore();
    }
  });

  it("rg .env.backup src/ in an unrelated project gives no hit", async () => {
    const fx = await plantCursorShellFixture();
    try {
      const hits = await shellHits({
        ...fx,
        slug: "c-Users-Other-Unrelated",
        session: "shell-unrelated-rg",
        command: "rg .env.backup src/",
      });
      expect(hits).toHaveLength(0);
    } finally {
      fx.restore();
    }
  });

  it("cat .env.backup in the decoy's own project is shell-mention", async () => {
    const fx = await plantCursorShellFixture();
    try {
      const hits = await shellHits({
        ...fx,
        session: "shell-own-cat",
        command: "cat .env.backup",
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.kind).toBe("shell-mention");
    } finally {
      fx.restore();
    }
  });

  it("type config\\secrets.legacy.json in the decoy's project is a hit", async () => {
    const fx = await plantCursorShellFixture();
    try {
      const hits = await shellHits({
        ...fx,
        session: "shell-own-type",
        command: "type config\\secrets.legacy.json",
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.kind).toBe("shell-mention");
      expect(hits[0]?.decoyPath.replace(/\\/g, "/")).toMatch(
        /config\/secrets\.legacy\.json$/,
      );
    } finally {
      fx.restore();
    }
  });
});

describe("remove cosmetic", () => {
  it("second remove does not claim Deleted for already-gone state files", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      await runInit({ projectRoot: project });
      const first = await runRemove({ projectRoot: project });
      expect(
        first.notes.some((n) => /Deleted .*manifest\.json/i.test(n)),
      ).toBe(true);

      const second = await runRemove({ projectRoot: project });
      const text = formatRemoveReport(second);
      expect(text).not.toMatch(/Deleted .*manifest\.json/i);
      expect(text).not.toMatch(/Deleted watcher offsets/i);
      expect(second.notes.some((n) => /nothing to remove/i.test(n))).toBe(true);
    } finally {
      restore();
    }
  });
});

