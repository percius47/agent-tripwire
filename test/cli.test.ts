import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempHome, makeTempProject, npmCmd } from "./helpers.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliJs = path.join(root, "dist", "cli.js");

describe("CLI", () => {
  beforeAll(() => {
    const build = spawnSync(npmCmd(), ["run", "build"], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (build.status !== 0) {
      throw new Error(`build failed: ${build.stderr || build.stdout}`);
    }
  });

  it("init with and without --home exits 0 and prints no full tokens", async () => {
    const home = await makeTempHome();
    const project = await makeTempProject(home);
    const env = {
      ...process.env,
      AGENT_TRIPWIRE_HOME: home,
      HOME: home,
    };

    const withoutHome = spawnSync("node", [cliJs, "init"], {
      cwd: project,
      encoding: "utf8",
      env,
    });
    expect(withoutHome.status).toBe(0);
    expect(withoutHome.stdout).toMatch(/created /);
    expect(withoutHome.stdout).toMatch(/tw…[A-Za-z0-9]{4}/);
    expect(withoutHome.stdout).not.toMatch(/tw[A-Z2-7]{26}/);

    const withHome = spawnSync("node", [cliJs, "init", "--home"], {
      cwd: project,
      encoding: "utf8",
      env,
    });
    expect(withHome.status).toBe(0);
    expect(withHome.stdout).toMatch(/tw…[A-Za-z0-9]{4}/);
    expect(withHome.stdout).not.toMatch(/tw[A-Z2-7]{26}/);
    // Re-run skips; still no full tokens
    expect(withHome.stdout).toMatch(/skipped /);
  });
});
