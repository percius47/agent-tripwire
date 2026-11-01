import { describe, expect, it } from "vitest";
import { connect, createConnection } from "node:net";
import { request as httpRequest, get as httpGet } from "node:http";
import { request as httpsRequest, get as httpsGet } from "node:https";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";

const MSG = /Network calls are forbidden/;

async function listSrcFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listSrcFiles(full)));
    } else if (e.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("no network calls", () => {
  it("stubs node:net connect/createConnection to throw", () => {
    expect(() => connect({ host: "example.com", port: 80 })).toThrow(MSG);
    expect(() => createConnection({ host: "example.com", port: 80 })).toThrow(MSG);
  });

  it("stubs node:http request/get to throw", () => {
    expect(() => httpRequest("http://example.com")).toThrow(MSG);
    expect(() => httpGet("http://example.com")).toThrow(MSG);
  });

  it("stubs node:https request/get to throw", () => {
    expect(() => httpsRequest("https://example.com")).toThrow(MSG);
    expect(() => httpsGet("https://example.com")).toThrow(MSG);
  });

  it("stubs global fetch to throw", async () => {
    await expect(fetch("https://example.com")).rejects.toThrow(MSG);
  });

  it("source tree does not import network modules or call fetch", async () => {
    const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files = await listSrcFiles(srcRoot);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text, file).not.toMatch(
        /from\s+['"]node:(net|http|https|dns|undici)['"]/,
      );
      expect(text, file).not.toMatch(/require\(\s*['"]node:(net|http|https)['"]\s*\)/);
      expect(text, file).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
