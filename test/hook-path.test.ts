import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findOnPath, hookPathStatus, hookPathWarning } from "../src/hook-path.js";

async function binDir(...segments: string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-path-"));
  const dir = path.join(root, ...segments);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("hook PATH check", () => {
  it("reports missing when the hook is not on PATH", async () => {
    const empty = await binDir("bin");
    const status = hookPathStatus({ PATH: empty }, process.platform);
    expect(status).toEqual({ ok: false, reason: "missing" });
    expect(hookPathWarning(status)).toContain("NOT protecting");
    expect(hookPathWarning(status)).toContain("npm i -g agent-tripwire");
  });

  it("accepts a lasting install", async () => {
    const dir = await binDir("global", "bin");
    await writeFile(path.join(dir, "agent-tripwire-hook"), "#!/bin/sh\n");
    const status = hookPathStatus({ PATH: dir }, process.platform);
    expect(status.ok).toBe(true);
    expect(hookPathWarning(status)).toBeNull();
  });

  it("flags the temporary npx cache as not lasting", async () => {
    const dir = await binDir("_npx", "abc123", "node_modules", ".bin");
    await writeFile(path.join(dir, "agent-tripwire-hook"), "#!/bin/sh\n");
    const status = hookPathStatus({ PATH: dir }, process.platform);
    expect(status).toMatchObject({ ok: false, reason: "npx-temporary" });
    expect(hookPathWarning(status)).toContain("npx");
  });

  it.skipIf(process.platform !== "win32")("uses PATHEXT on Windows", async () => {
    const dir = await binDir("npm");
    await writeFile(path.join(dir, "agent-tripwire-hook.cmd"), "@echo off\r\n");
    const found = findOnPath(
      "agent-tripwire-hook",
      { Path: dir, PATHEXT: ".EXE;.CMD" },
      "win32",
    );
    expect(found?.toLowerCase().endsWith("agent-tripwire-hook.cmd")).toBe(true);
  });
});
