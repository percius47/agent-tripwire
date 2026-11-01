import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInit } from "../src/init.js";
import { makeTempHome, makeTempProject, useHome } from "./helpers.js";

function which(name: string): boolean {
  const probe = spawnSync("sh", ["-c", `command -v ${name}`], {
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

describe("aws and npm ignore .bak decoys", () => {
  it("aws configure list-profiles is unchanged by credentials.bak", async () => {
    if (!which("aws")) {
      console.warn(
        "SKIP: aws CLI binary absent — cannot verify credentials.bak is ignored",
      );
      return;
    }

    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      await mkdir(path.join(home, ".aws"), { recursive: true });
      await writeFile(
        path.join(home, ".aws", "credentials"),
        "[default]\naws_access_key_id = FIXTUREKEYNOTREAL0000\naws_secret_access_key = fixturesecretnotreal0000000000000000\n",
        "utf8",
      );

      const env = { ...process.env, HOME: home, AWS_SHARED_CREDENTIALS_FILE: path.join(home, ".aws", "credentials") };

      const before = spawnSync("aws", ["configure", "list-profiles"], {
        encoding: "utf8",
        env,
      });
      expect(before.status).toBe(0);
      const beforeOut = before.stdout;

      const project = await makeTempProject(home);
      await runInit({ projectRoot: project, home: true });

      const after = spawnSync("aws", ["configure", "list-profiles"], {
        encoding: "utf8",
        env,
      });
      expect(after.status).toBe(0);
      expect(after.stdout).toBe(beforeOut);
      // The decoy profile name must not appear
      expect(after.stdout).not.toMatch(/legacy-ci/);
    } finally {
      restore();
    }
  });

  it("npm config get userconfig still points at .npmrc, not .npmrc.bak", async () => {
    if (!which("npm")) {
      console.warn(
        "SKIP: npm binary absent — cannot verify .npmrc.bak is ignored",
      );
      return;
    }

    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const npmrc = path.join(home, ".npmrc");
      await writeFile(npmrc, "registry=https://registry.npmjs.org/\n", "utf8");

      const env = { ...process.env, HOME: home };

      const before = spawnSync("npm", ["config", "get", "userconfig"], {
        encoding: "utf8",
        env,
      });
      expect(before.status).toBe(0);
      const beforeOut = before.stdout.trim();

      const project = await makeTempProject(home);
      await runInit({ projectRoot: project, home: true });

      const after = spawnSync("npm", ["config", "get", "userconfig"], {
        encoding: "utf8",
        env,
      });
      expect(after.status).toBe(0);
      expect(after.stdout.trim()).toBe(beforeOut);
      expect(after.stdout.trim()).not.toContain(".npmrc.bak");
      // Resolve to the real npmrc path under the temp home when possible
      expect(path.normalize(after.stdout.trim())).not.toBe(
        path.normalize(path.join(home, ".npmrc.bak")),
      );
    } finally {
      restore();
    }
  });
});
