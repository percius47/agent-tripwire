import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { getHomeDir, getStateDir } from "../src/paths.js";
import { canonicalizePathSync, pathsEqual } from "../src/path-util.js";

describe("paths / AGENT_TRIPWIRE_HOME", () => {
  it("uses os.homedir() when AGENT_TRIPWIRE_HOME is unset", () => {
    const prev = process.env.AGENT_TRIPWIRE_HOME;
    const prevHome = process.env.HOME;
    delete process.env.AGENT_TRIPWIRE_HOME;
    // Mutating HOME must not affect Tripwire
    process.env.HOME = "/tmp/should-not-be-used-by-tripwire";
    try {
      expect(pathsEqual(getHomeDir(), os.homedir())).toBe(true);
      expect(pathsEqual(getStateDir(), path.join(os.homedir(), ".agent-tripwire"))).toBe(
        true,
      );
    } finally {
      if (prev === undefined) delete process.env.AGENT_TRIPWIRE_HOME;
      else process.env.AGENT_TRIPWIRE_HOME = prev;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("respects AGENT_TRIPWIRE_HOME override for tests", () => {
    const prev = process.env.AGENT_TRIPWIRE_HOME;
    process.env.AGENT_TRIPWIRE_HOME = "/tmp/tripwire-test-home";
    try {
      expect(pathsEqual(getHomeDir(), "/tmp/tripwire-test-home")).toBe(true);
      expect(
        pathsEqual(
          getStateDir(),
          path.join(
            canonicalizePathSync("/tmp/tripwire-test-home"),
            ".agent-tripwire",
          ),
        ),
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGENT_TRIPWIRE_HOME;
      else process.env.AGENT_TRIPWIRE_HOME = prev;
    }
  });
});
