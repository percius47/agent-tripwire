import { describe, expect, it } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runInit } from "../src/init.js";
import { runHookPayload } from "../src/hook/run.js";
import { loadIncidents } from "../src/project-state.js";
import { makeTempHome, makeTempProject, useHome, initGitRepo } from "./helpers.js";

describe("incident attribution across guarded projects", () => {
  it("a shell command naming a decoy by relative path logs in the agent's own project", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      // Two guarded projects share decoy names (.env.local.old etc.).
      const other = path.join(home, "projects", "other");
      await mkdir(other, { recursive: true });
      await initGitRepo(other);
      await runInit({ projectRoot: other });
      const mine = await makeTempProject(home);
      await initGitRepo(mine);
      await runInit({ projectRoot: mine });

      const res = await runHookPayload(
        JSON.stringify({
          conversation_id: "c-attr",
          hook_event_name: "beforeShellExecution",
          workspace_roots: [mine],
          cwd: mine,
          command: "cat .env.local.old",
        }),
        { notify: false },
      );
      expect(res.response.permission).toBe("deny");
      const mineLog = await loadIncidents(mine);
      expect(mineLog.some((i) => i.sessionId === "c-attr" && i.rule === "decoy")).toBe(true);
      const otherLog = await loadIncidents(other);
      expect(otherLog.some((i) => i.sessionId === "c-attr")).toBe(false);
    } finally {
      restore();
    }
  });

  it("Claude Code tamper is logged as deny, matching what Claude was told", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      await runInit({ projectRoot: project });
      const res = await runHookPayload(
        JSON.stringify({
          session_id: "s-tamper",
          hook_event_name: "PreToolUse",
          cwd: project,
          tool_name: "Bash",
          tool_input: { command: "agent-tripwire pause --for 24h" },
        }),
        { notify: false },
      );
      expect(
        (res.response as { hookSpecificOutput?: { permissionDecision?: string } })
          .hookSpecificOutput?.permissionDecision,
      ).toBe("deny");
      const log = await readFile(path.join(project, ".tripwire", "incidents.log"), "utf8");
      const rec = JSON.parse(log.trim().split("\n").pop()!);
      expect(rec.rule).toBe("tamper");
      expect(rec.action).toBe("deny");
    } finally {
      restore();
    }
  });
});
