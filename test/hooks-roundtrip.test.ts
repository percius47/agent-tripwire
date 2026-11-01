import { describe, expect, it } from "vitest";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runInit } from "../src/init.js";
import { runRemove } from "../src/remove.js";
import { HOOK_COMMAND, HOOK_MARKER } from "../src/project-state.js";
import {
  makeTempHome,
  makeTempProject,
  useHome,
  initGitRepo,
  readExact,
  writeFixture,
} from "./helpers.js";

describe("init/remove hooks roundtrip", () => {
  it("merges hooks without clobbering; remove restores byte-exact originals", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);

      await mkdir(path.join(project, ".cursor"), { recursive: true });
      await mkdir(path.join(project, ".claude"), { recursive: true });

      const cursorBeforeObj = {
        version: 1,
        hooks: {
          afterFileEdit: [{ command: "./format.sh" }],
        },
      };
      const claudeBeforeObj = {
        permissions: { allow: ["Bash(git *)"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "Write",
              hooks: [{ type: "command", command: "./other.sh" }],
            },
          ],
        },
      };
      const cursorPath = path.join(project, ".cursor", "hooks.json");
      const claudePath = path.join(project, ".claude", "settings.json");
      const cursorBefore = await writeFixture(
        cursorPath,
        `${JSON.stringify(cursorBeforeObj, null, 2)}\n`,
      );
      const claudeBefore = await writeFixture(
        claudePath,
        `${JSON.stringify(claudeBeforeObj, null, 2)}\n`,
      );

      const init = await runInit({ projectRoot: project });
      expect(init.hooks).toBeDefined();

      const cursorAfter = JSON.parse(await readFile(cursorPath, "utf8")) as {
        hooks: Record<string, unknown[]>;
      };
      expect(cursorAfter.hooks.afterFileEdit).toEqual([
        { command: "./format.sh" },
      ]);
      expect(cursorAfter.hooks.beforeReadFile?.some((e) => (e as { command?: string }).command === HOOK_COMMAND)).toBe(true);
      expect(
        (cursorAfter.hooks.beforeReadFile?.[0] as Record<string, unknown>)[
          HOOK_MARKER
        ],
      ).toBe(true);

      const claudeAfter = JSON.parse(await readFile(claudePath, "utf8")) as {
        permissions: unknown;
        hooks: { PreToolUse: unknown[] };
      };
      expect(claudeAfter.permissions).toEqual(claudeBeforeObj.permissions);
      expect(
        claudeAfter.hooks.PreToolUse.some(
          (g) =>
            typeof g === "object" &&
            g !== null &&
            (g as { matcher?: string }).matcher === "Write",
        ),
      ).toBe(true);

      // Idempotent re-init does not duplicate our entries
      await runInit({ projectRoot: project });
      const cursorAgain = JSON.parse(await readFile(cursorPath, "utf8")) as {
        hooks: { beforeReadFile: unknown[] };
      };
      expect(cursorAgain.hooks.beforeReadFile).toHaveLength(1);

      const remove = await runRemove({ projectRoot: project });
      expect(remove.hooksRestored.length + remove.hooksDeleted.length).toBeGreaterThan(0);

      expect(Buffer.compare(await readExact(cursorPath), cursorBefore)).toBe(0);
      expect(Buffer.compare(await readExact(claudePath), claudeBefore)).toBe(0);

      await expect(access(path.join(project, ".tripwire"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      restore();
    }
  });

  it("deletes hook files we created when they were absent before", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      await runInit({ projectRoot: project });
      await access(path.join(project, ".cursor", "hooks.json"));
      await access(path.join(project, ".claude", "settings.json"));
      await runRemove({ projectRoot: project });
      await expect(
        access(path.join(project, ".cursor", "hooks.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(path.join(project, ".claude", "settings.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restore();
    }
  });

  it("incidents log never contains raw decoy tokens", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const project = await makeTempProject(home);
      await initGitRepo(project);
      await runInit({ projectRoot: project });
      const { loadManifest } = await import("../src/manifest.js");
      const { runHookPayload } = await import("../src/hook/run.js");
      const { loadIncidents } = await import("../src/project-state.js");
      const manifest = await loadManifest();
      const token = manifest.decoys[0]!.tokenId;
      const secretVals = manifest.decoys.flatMap((d) => d.matchValues ?? [d.tokenId]);

      await runHookPayload(
        JSON.stringify({
          conversation_id: "c",
          hook_event_name: "beforeReadFile",
          workspace_roots: [project],
          transcript_path: "/t",
          file_path: manifest.decoys[0]!.path,
          content: secretVals.join("\n"),
        }),
      );

      const incidents = await loadIncidents(project);
      expect(incidents.length).toBeGreaterThan(0);
      const blob = JSON.stringify(incidents);
      for (const v of secretVals) {
        expect(blob).not.toContain(v);
      }
      expect(blob).not.toContain(token);
      expect(incidents[0]!.valuePreview ?? "x").not.toBe(token);
    } finally {
      restore();
    }
  });
});
