import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

export async function makeTempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "tripwire-home-"));
}

/** Project dir without pre-creating config/ (so createdDirs can be recorded). */
export async function makeTempProject(home: string): Promise<string> {
  const project = path.join(home, "projects", "demo");
  await mkdir(project, { recursive: true });
  return project;
}

/** Install AGENT_TRIPWIRE_HOME for Tripwire state/home decoys. */
export function useHome(home: string): () => void {
  const prev = process.env.AGENT_TRIPWIRE_HOME;
  process.env.AGENT_TRIPWIRE_HOME = home;
  return () => {
    if (prev === undefined) {
      delete process.env.AGENT_TRIPWIRE_HOME;
    } else {
      process.env.AGENT_TRIPWIRE_HOME = prev;
    }
  };
}

export async function writeFixture(
  filePath: string,
  contents: string,
): Promise<Buffer> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
  return readFile(filePath);
}

export async function readExact(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}

export function which(name: string): boolean {
  if (process.platform === "win32") {
    const probe = spawnSync("where", [name], {
      encoding: "utf8",
      shell: true,
    });
    return probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
  }
  const probe = spawnSync("sh", ["-c", `command -v ${name}`], {
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

/** `npm` resolves to npm.cmd on Windows; bare `npm` ENOENTs without a shell. */
export function npmCmd(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/** Init a git repo in `dir` with an initial commit (so exclude/check-ignore work). */
export async function initGitRepo(dir: string): Promise<void> {
  const run = (args: string[]) => {
    const r = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_ASKPASS: "",
        GIT_EDITOR: "true",
        GC_AUTO: "0",
        GIT_AUTHOR_NAME: "tripwire-test",
        GIT_AUTHOR_EMAIL: "tripwire@test",
        GIT_COMMITTER_NAME: "tripwire-test",
        GIT_COMMITTER_EMAIL: "tripwire@test",
      },
    });
    if (r.error) {
      throw new Error(`git ${args.join(" ")} error: ${r.error.message}`);
    }
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    }
  };
  run(["init"]);
  run(["config", "user.email", "tripwire@test"]);
  run(["config", "user.name", "tripwire-test"]);
  run(["config", "commit.gpgsign", "false"]);
  run(["config", "tag.gpgsign", "false"]);
  await writeFile(path.join(dir, "README"), "test\n", "utf8");
  run(["add", "README"]);
  run(["commit", "--no-gpg-sign", "-m", "init"]);
}
