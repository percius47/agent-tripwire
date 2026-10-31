import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseClaudeCodeLine,
  createClaudeCodeAdapter,
} from "../src/adapters/claude-code.js";
import {
  buildExcludeBlock,
  EXCLUDE_BEGIN,
  EXCLUDE_END,
  isIgnored,
  writeExcludeBlock,
} from "../src/git-exclude.js";
import { deriveWatchRoot, minimatchSimple } from "../src/glob-util.js";
import { runInit } from "../src/init.js";
import { buildTokenMatcher } from "../src/match.js";
import { loadManifest } from "../src/manifest.js";
import { processFile, createSeenMap } from "../src/engine.js";
import { loadOffsets } from "../src/offsets.js";
import { readNewLines } from "../src/tail.js";
import {
  initGitRepo,
  makeTempHome,
  makeTempProject,
  useHome,
} from "./helpers.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

/** Key set confirmed on a real Windows Claude Code JSONL (Oct 31 2026). */
const CONFIRMED_TOOL_RESULT_KEYS = [
  "parentUuid",
  "isSidechain",
  "promptId",
  "type",
  "message",
  "uuid",
  "timestamp",
  "toolUseResult",
  "sourceToolAssistantUUID",
  "userType",
  "entrypoint",
  "cwd",
  "sessionId",
  "version",
  "gitBranch",
] as const;

describe("Windows path / glob matching", () => {
  it("minimatchSimple matches backslash paths with spaces (Claude mangled cwd)", () => {
    const file =
      "C:\\Users\\Name With Space\\.claude\\projects\\C--Users-Name With Space-LAMP\\abc-def.jsonl";
    const pattern =
      "C:\\Users\\Name With Space\\.claude\\projects\\*\\*.jsonl";
    expect(minimatchSimple(file, pattern)).toBe(true);
    expect(
      minimatchSimple(
        file,
        "C:/Users/Name With Space/.claude/projects/*/*.jsonl",
      ),
    ).toBe(true);
  });

  it("deriveWatchRoot stops before the first wildcard segment", () => {
    // Avoid path.join("C:", …) — on Windows that is drive-relative ("C:Users").
    const absPattern =
      process.platform === "win32"
        ? `C:\\Users\\Name With Space\\.claude\\projects\\*\\*.jsonl`
        : `/Users/Name With Space/.claude/projects/*/*.jsonl`;
    const { root, depth } = deriveWatchRoot(absPattern);
    expect(root.replace(/\\/g, "/")).toMatch(
      /Users\/Name With Space\/\.claude\/projects$/,
    );
    expect(depth).toBe(2);
  });

  it("expands Claude glob under a home path that contains a space", async () => {
    const home = await makeTempHome();
    // Force a space in the home path segment used for Claude projects.
    const spaced = path.join(home, "Name With Space");
    const restore = useHome(spaced);
    try {
      const project = await makeTempProject(spaced);
      const report = await runInit({ projectRoot: project });
      const tokenId = report.project.created[0]?.tokenId;
      if (!tokenId) throw new Error("missing token");

      const mangled = "C--Users-Name With Space-LAMP";
      const dir = path.join(spaced, ".claude", "projects", mangled);
      await mkdir(dir, { recursive: true });
      const session = path.join(dir, "sess-space.jsonl");
      await writeFile(
        session,
        `${JSON.stringify({
          type: "user",
          sessionId: "sess-space",
          timestamp: "2026-10-31T12:00:00.000Z",
          message: {
            content: [
              {
                type: "tool_result",
                content: `AWS_ACCESS_KEY_ID=${tokenId}\n`,
              },
            ],
          },
          toolUseResult: { content: `AWS_ACCESS_KEY_ID=${tokenId}\n` },
        })}\n`,
        "utf8",
      );

      const adapter = createClaudeCodeAdapter(spaced);
      const matcher = buildTokenMatcher((await loadManifest()).decoys);
      const hits = await processFile({
        filePath: session,
        adapter,
        matcher,
        offsets: await loadOffsets(),
        seen: createSeenMap(),
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.kind).toBe("read");
      expect(hits[0]?.sourceFile).toBe(path.resolve(session));
    } finally {
      restore();
    }
  });
});

describe("CRLF handling", () => {
  it("tail reader strips CR so CRLF JSONL parses cleanly", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const file = path.join(home, "crlf.jsonl");
      await writeFile(file, '{"a":1}\r\n{"b":2}\r\n', "utf8");
      const r = await readNewLines(file, { offset: 0, partial: "" });
      expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
      for (const line of r.lines) {
        expect(line.endsWith("\r")).toBe(false);
        expect(JSON.parse(line)).toBeTruthy();
      }
    } finally {
      restore();
    }
  });

  it("exclude block edit normalizes CRLF and keeps forward-slash paths", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      const excludePath = path.join(project, ".git", "info", "exclude");
      await mkdir(path.dirname(excludePath), { recursive: true });
      await writeFile(
        excludePath,
        `# preexisting\r\n*.log\r\n`,
        "utf8",
      );

      await writeExcludeBlock(project, [
        ".env.backup",
        "config/secrets.legacy.json",
      ]);
      const body = await readFile(excludePath, "utf8");
      expect(body).not.toContain("\r");
      expect(body).toContain(EXCLUDE_BEGIN);
      expect(body).toContain(EXCLUDE_END);
      expect(body).toContain("config/secrets.legacy.json");
      expect(body).not.toContain("config\\secrets.legacy.json");
      expect(isIgnored(project, ".env.backup")).toBe(true);
      expect(isIgnored(project, "config/secrets.legacy.json")).toBe(true);
      expect(buildExcludeBlock([".env.backup"]).split("\n")).toEqual([
        EXCLUDE_BEGIN,
        ".env.backup",
        EXCLUDE_END,
      ]);
    } finally {
      restore();
    }
  });
});

describe("Claude Code Windows-confirmed fixture", () => {
  it("toolUseResult token yields isToolResult hit with confirmed key set", async () => {
    const raw = await readFile(
      path.join(fixtureDir, "claude-code-windows-confirmed.jsonl"),
      "utf8",
    );
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual([
      "queue-operation",
      "user",
      "attachment",
      "ai-title",
      "assistant",
      "user",
      "last-prompt",
    ]);

    const toolResultLine = lines.find((l) => {
      const o = JSON.parse(l) as Record<string, unknown>;
      return o.type === "user" && "toolUseResult" in o;
    });
    expect(toolResultLine).toBeTruthy();
    const obj = JSON.parse(toolResultLine!) as Record<string, unknown>;
    expect(Object.keys(obj).sort()).toEqual(
      [...CONFIRMED_TOOL_RESULT_KEYS].sort(),
    );

    const message = obj.message as { content: Array<{ type: string }> };
    expect(message.content.some((b) => b.type === "tool_result")).toBe(true);

    const assistantLine = lines.find((l) => {
      const o = JSON.parse(l) as { type?: string };
      return o.type === "assistant";
    });
    const assistant = JSON.parse(assistantLine!) as {
      message: { content: Array<{ type: string; name?: string }> };
    };
    expect(
      assistant.message.content.some(
        (b) => b.type === "tool_use" && b.name === "Read",
      ),
    ).toBe(true);

    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      const report = await runInit({ projectRoot: project });
      const tokenId = report.project.created[0]?.tokenId;
      if (!tokenId) throw new Error("missing token");

      const injected = toolResultLine!.replaceAll(
        "PLACEHOLDER_TOKEN_IN_TOOL_RESULT",
        tokenId,
      );
      const filePath = path.join(
        home,
        ".claude",
        "projects",
        "C--Users-Name With Space-LAMP",
        "sess-win-confirmed.jsonl",
      );
      const parsed = parseClaudeCodeLine(injected, filePath);
      expect(parsed?.isToolResult).toBe(true);
      expect(parsed?.text).toContain(tokenId);

      const matcher = buildTokenMatcher((await loadManifest()).decoys);
      const matches = matcher.findAll(parsed!.text);
      expect(matches.some((m) => m.tokenId === tokenId)).toBe(true);
    } finally {
      restore();
    }
  });
});
