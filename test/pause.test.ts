import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInit } from "../src/init.js";
import { runHookPayload } from "../src/hook/run.js";
import {
  activePause,
  isTamperCommand,
  parseDuration,
  pausePath,
  pauseProject,
  resumeProject,
} from "../src/pause.js";
import {
  makeTempHome,
  makeTempProject,
  useHome,
  initGitRepo,
} from "./helpers.js";

function decoyRead(project: string) {
  return JSON.stringify({
    conversation_id: "c1",
    hook_event_name: "beforeReadFile",
    workspace_roots: [project],
    file_path: path.join(project, ".env.backup"),
    content: "x",
  });
}

describe("pause / resume", () => {
  it("parses durations and rejects bad or too-long ones", async () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("1h30m")).toBe(90 * 60_000);
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
    await expect(pauseProject("/tmp/x-nonexistent", "25h")).rejects.toThrow(/24h/);
  });

  it("pause makes decoy reads log-only, resume restores blocking", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      await runInit({ projectRoot: project });

      await pauseProject(project, "10m");
      const paused = await runHookPayload(decoyRead(project), { notify: false });
      expect(paused.response.permission).toBe("allow");
      const log = await readFile(
        path.join(project, ".tripwire", "incidents.log"),
        "utf8",
      );
      expect(log).toMatch(/paused until/);

      expect(await resumeProject(project)).toBe(true);
      const back = await runHookPayload(decoyRead(project), { notify: false });
      expect(back.response.permission).toBe("deny");
    } finally {
      restore();
    }
  });

  it("expired, corrupt or hand-extended pauses do not pause", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      await runInit({ projectRoot: project });
      const t0 = new Date("2026-01-01T00:00:00Z");
      await pauseProject(project, "5m", t0);
      expect(await activePause(project, new Date("2026-01-01T00:06:00Z"))).toBeNull();

      await writeFile(pausePath(project), "{broken");
      expect(await activePause(project)).toBeNull();

      const now = Date.now();
      await writeFile(
        pausePath(project),
        JSON.stringify({
          version: 1,
          createdAt: new Date(now).toISOString(),
          until: new Date(now + 30 * 24 * 3600_000).toISOString(),
        }),
      );
      expect(await activePause(project)).toBeNull();
      const res = await runHookPayload(decoyRead(project), { notify: false });
      expect(res.response.permission).toBe("deny");
    } finally {
      restore();
    }
  });

  it("agent trying to pause/remove Tripwire is flagged as tamper, even while paused", async () => {
    expect(isTamperCommand("npx agent-tripwire pause --for 24h")).toBe(true);
    expect(isTamperCommand("agent-tripwire remove")).toBe(true);
    expect(isTamperCommand("rm .tripwire/pause.json")).toBe(true);
    expect(isTamperCommand('echo {} > .cursor/hooks.json')).toBe(true);
    expect(isTamperCommand("agent-tripwire incidents")).toBe(false);
    expect(isTamperCommand("cat .cursor/hooks.json")).toBe(false);

    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      await runInit({ projectRoot: project });
      await pauseProject(project, "10m");
      const res = await runHookPayload(
        JSON.stringify({
          conversation_id: "c1",
          hook_event_name: "beforeShellExecution",
          workspace_roots: [project],
          command: "npx agent-tripwire pause --for 24h",
          cwd: project,
        }),
        { notify: false },
      );
      expect(res.decision.rule).toBe("tamper");
      expect(res.response.permission).toBe("ask");
      const claude = await runHookPayload(
        JSON.stringify({
          session_id: "s1",
          hook_event_name: "PreToolUse",
          cwd: project,
          tool_name: "Bash",
          tool_input: { command: "agent-tripwire remove" },
        }),
        { notify: false },
      );
      expect(
        (claude.response as { hookSpecificOutput?: { permissionDecision?: string } })
          .hookSpecificOutput?.permissionDecision,
      ).toBe("deny");
    } finally {
      restore();
    }
  });
});
