import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadManifest, saveManifest, emptyManifest } from "../src/manifest.js";
import { getManifestPath, getStateDir } from "../src/paths.js";
import { makeTempHome, useHome } from "./helpers.js";

describe("loadManifest", () => {
  it("returns empty manifest on ENOENT only", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      const m = await loadManifest();
      expect(m).toEqual(emptyManifest());
    } finally {
      restore();
    }
  });

  it("throws on wrong version", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      await mkdir(getStateDir(), { recursive: true });
      await writeFile(
        getManifestPath(),
        JSON.stringify({ version: 99, decoys: [] }),
        "utf8",
      );
      await expect(loadManifest()).rejects.toThrow(/unsupported version/i);
    } finally {
      restore();
    }
  });

  it("throws on wrong shape (decoys not an array)", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      await mkdir(getStateDir(), { recursive: true });
      await writeFile(
        getManifestPath(),
        JSON.stringify({ version: 1, decoys: "nope" }),
        "utf8",
      );
      await expect(loadManifest()).rejects.toThrow(/decoys must be an array/i);
    } finally {
      restore();
    }
  });

  it("saves with mode 0600", async () => {
    const home = await makeTempHome();
    const restore = useHome(home);
    try {
      await saveManifest(emptyManifest());
      const { lstat } = await import("node:fs/promises");
      const mode = (await lstat(getManifestPath())).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      restore();
    }
  });
});
