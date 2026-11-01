import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export async function makeTempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "tripwire-home-"));
}

export async function makeTempProject(home: string): Promise<string> {
  const project = path.join(home, "projects", "demo");
  await mkdir(project, { recursive: true });
  await mkdir(path.join(project, "config"), { recursive: true });
  return project;
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
