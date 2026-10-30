import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function makeTempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "tripwire-home-"));
}

export async function makeTempProject(home: string): Promise<string> {
  const project = path.join(home, "projects", "demo");
  await mkdir(project, { recursive: true });
  await mkdir(path.join(project, "config"), { recursive: true });
  return project;
}

/** Initialize a git repo in project with an optional initial commit. */
export async function initGitRepo(
  project: string,
  opts: { commit?: boolean } = {},
): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "tripwire@test.local"], {
    cwd: project,
  });
  await execFileAsync("git", ["config", "user.name", "Tripwire Test"], {
    cwd: project,
  });
  // Avoid depending on the global default branch name.
  await execFileAsync("git", ["checkout", "-b", "main"], { cwd: project }).catch(
    () => undefined,
  );
  if (opts.commit) {
    await writeFile(path.join(project, "README"), "demo\n", "utf8");
    await execFileAsync("git", ["add", "README"], { cwd: project });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: project });
  }
}

export async function gitPorcelain(project: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: project,
    encoding: "utf8",
  });
  return stdout.toString();
}

/** Install a fake HOME for the duration of a test. */
export function useHome(home: string): () => void {
  const prev = process.env.HOME;
  process.env.HOME = home;
  return () => {
    if (prev === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prev;
    }
  };
}

export async function writeFixture(filePath: string, contents: string): Promise<Buffer> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
  return readFile(filePath);
}

export async function readExact(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}
