import { describe, expect, it } from "vitest";
import { connect, createConnection, Socket } from "node:net";
import { request as httpRequest, get as httpGet } from "node:http";
import { request as httpsRequest, get as httpsGet } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { lookup as dnsLookup } from "node:dns";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  it("stubs node:net connect/createConnection/Socket to throw", () => {
    expect(() => connect({ host: "example.com", port: 80 })).toThrow(MSG);
    expect(() => createConnection({ host: "example.com", port: 80 })).toThrow(
      MSG,
    );
    expect(() => new Socket()).toThrow(MSG);
  });

  it("stubs node:http request/get to throw", () => {
    expect(() => httpRequest("http://example.com")).toThrow(MSG);
    expect(() => httpGet("http://example.com")).toThrow(MSG);
  });

  it("stubs node:https request/get to throw", () => {
    expect(() => httpsRequest("https://example.com")).toThrow(MSG);
    expect(() => httpsGet("https://example.com")).toThrow(MSG);
  });

  it("stubs node:tls connect to throw", () => {
    expect(() => tlsConnect({ host: "example.com", port: 443 })).toThrow(MSG);
  });

  it("stubs node:dns lookup to throw", () => {
    expect(() =>
      dnsLookup("example.com", () => undefined),
    ).toThrow(MSG);
  });

  it("stubs global fetch to throw", async () => {
    await expect(fetch("https://example.com")).rejects.toThrow(MSG);
  });

  it("source tree does not import network modules or call fetch/dynamic import of them", async () => {
    const srcRoot = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
    );
    const files = await listSrcFiles(srcRoot);
    expect(files.length).toBeGreaterThan(0);

    const bannedBare = /\b['"](?:node:)?(?:http|https|net|dns|tls|dgram|undici)['"]/;
    const bannedFrom =
      /from\s+['"](?:node:)?(?:http|https|net|dns|tls|dgram|undici)['"]/;
    const bannedRequire =
      /require\(\s*['"](?:node:)?(?:http|https|net|dns|tls|dgram|undici)['"]\s*\)/;
    const bannedDynamic =
      /import\(\s*['"](?:node:)?(?:http|https|net|dns|tls|dgram|undici)['"]\s*\)/;
    const bannedFetch = /\bfetch\s*\(/;

    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text, file).not.toMatch(bannedFrom);
      expect(text, file).not.toMatch(bannedRequire);
      expect(text, file).not.toMatch(bannedDynamic);
      expect(text, file).not.toMatch(bannedFetch);
      // Catch bare string module refs used in any form
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) {
          continue;
        }
        expect(line, `${file}: ${line}`).not.toMatch(bannedBare);
      }
    }
  });
});
