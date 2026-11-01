import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runInit } from "../src/init.js";
import { makeTempHome, makeTempProject, useHome, which } from "./helpers.js";

/** Keep awscli importable when tests override HOME to a temp dir. */
function awsEnv(home: string): NodeJS.ProcessEnv {
  const realHome = os.homedir();
  return {
    ...process.env,
    HOME: home,
    AGENT_TRIPWIRE_HOME: home,
    AWS_SHARED_CREDENTIALS_FILE: path.join(home, ".aws", "credentials"),
    PYTHONPATH: path.join(
      realHome,
      ".local",
      "lib",
      "python3.12",
      "site-packages",
    ),
    PYTHONUSERBASE: path.join(realHome, ".local"),
    PATH: [
      path.join(realHome, ".local", "bin"),
      process.env.PATH ?? "",
    ].join(path.delimiter),
  };
}

function npmEnv(home: string, npmrc: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    AGENT_TRIPWIRE_HOME: home,
    npm_config_userconfig: npmrc,
    NPM_CONFIG_USERCONFIG: npmrc,
  };
}

describe("aws and npm ignore .bak decoys", () => {
  it.skipIf(!which("aws"))(
    "aws configure list is unchanged by credentials.bak",
    async () => {
      const home = await makeTempHome();
      const restore = useHome(home);
      try {
        await mkdir(path.join(home, ".aws"), { recursive: true });
        await writeFile(
          path.join(home, ".aws", "credentials"),
          "[default]\naws_access_key_id = FIXTUREKEYNOTREAL0000\naws_secret_access_key = fixturesecretnotreal0000000000000000\n",
          "utf8",
        );

        const env = awsEnv(home);

        // Prefer list-profiles (CLI v2); fall back to configure list (CLI v1).
        const probe = spawnSync("aws", ["configure", "list-profiles"], {
          encoding: "utf8",
          env,
        });
        const useListProfiles = probe.status === 0;
        const args = useListProfiles
          ? (["configure", "list-profiles"] as string[])
          : (["configure", "list"] as string[]);

        const before = spawnSync("aws", args, { encoding: "utf8", env });
        expect(before.status).toBe(0);
        const beforeOut = before.stdout;

        const project = await makeTempProject(home);
        const report = await runInit({ projectRoot: project, home: true });
        const decoyToken = report.homeResult?.created.find((c) =>
          c.path.endsWith("credentials.bak"),
        )?.tokenId;

        const after = spawnSync("aws", args, { encoding: "utf8", env });
        expect(after.status).toBe(0);
        expect(after.stdout).toBe(beforeOut);
        expect(after.stdout).not.toMatch(/legacy-ci/);
        if (decoyToken) {
          expect(after.stdout).not.toContain(decoyToken);
        }
      } finally {
        restore();
      }
    },
  );

  it.skipIf(!which("npm"))(
    "npm config list/authToken are unchanged and never contain the decoy token",
    async () => {
      const home = await makeTempHome();
      const restore = useHome(home);
      try {
        const npmrc = path.join(home, ".npmrc");
        await writeFile(
          npmrc,
          "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=FIXTURE_REAL_STYLE_TOKEN\n",
          "utf8",
        );

        const env = npmEnv(home, npmrc);

        const npm = process.platform === "win32" ? "npm.cmd" : "npm";
        const beforeList = spawnSync(npm, ["config", "list"], {
          encoding: "utf8",
          env,
          shell: process.platform === "win32",
        });
        expect(beforeList.status).toBe(0);

        const authErrorCore = (s: string) =>
          s
            .split("\n")
            .filter((l) => /protected|authToken|_authToken/i.test(l))
            .join("\n");

        const beforeAuth = spawnSync(
          npm,
          ["config", "get", "//registry.npmjs.org/:_authToken"],
          {
            encoding: "utf8",
            env,
            shell: process.platform === "win32",
          },
        );
        // npm may refuse to print protected tokens; treat identical failure as unchanged.
        const beforeAuthSnapshot = {
          status: beforeAuth.status,
          stdout: beforeAuth.stdout,
          stderrCore: authErrorCore(beforeAuth.stderr),
        };

        const project = await makeTempProject(home);
        const report = await runInit({ projectRoot: project, home: true });
        const decoy = report.homeResult?.created.find((c) =>
          c.path.endsWith(".npmrc.bak"),
        );
        expect(decoy).toBeTruthy();
        const decoyToken = decoy!.tokenId;
        const bakBody = await readFile(decoy!.path, "utf8");
        expect(bakBody).toContain(decoyToken);

        const afterList = spawnSync(npm, ["config", "list"], {
          encoding: "utf8",
          env,
          shell: process.platform === "win32",
        });
        expect(afterList.status).toBe(0);
        expect(afterList.stdout).toBe(beforeList.stdout);
        expect(afterList.stdout).not.toContain(decoyToken);
        expect(afterList.stdout).not.toContain(".npmrc.bak");

        const afterAuth = spawnSync(
          npm,
          ["config", "get", "//registry.npmjs.org/:_authToken"],
          {
            encoding: "utf8",
            env,
            shell: process.platform === "win32",
          },
        );
        expect(afterAuth.status).toBe(beforeAuthSnapshot.status);
        expect(afterAuth.stdout).toBe(beforeAuthSnapshot.stdout);
        expect(authErrorCore(afterAuth.stderr)).toBe(beforeAuthSnapshot.stderrCore);
        expect(afterAuth.stdout).not.toContain(decoyToken);
        expect(afterAuth.stderr).not.toContain(decoyToken);
        if (afterAuth.status === 0) {
          expect(afterAuth.stdout.trim()).toBe("FIXTURE_REAL_STYLE_TOKEN");
        } else {
          expect(beforeAuthSnapshot.stderrCore).toMatch(/protected/i);
        }
      } finally {
        restore();
      }
    },
  );
});
