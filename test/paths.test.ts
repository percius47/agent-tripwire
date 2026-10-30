import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { getHomeDir, getStateDir } from "../src/paths.js";

describe("paths / AGENT_TRIPWIRE_HOME", () => {
  it("uses os.homedir() when AGENT_TRIPWIRE_HOME is unset", () => {
    const prev = process.env.AGENT_TRIPWIRE_HOME;
    const prevHome = process.env.HOME;
    delete process.env.AGENT_TRIPWIRE_HOME;
    // Mutating HOME must not affect Tripwire
    process.env.HOME = "/tmp/should-not-be-used-by-tripwire";
    try {
      expect(getHomeDir()).toBe(os.homedir());
      expect(getStateDir()).toBe(path.join(os.homedir(), ".agent-tripwire"));
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
      expect(getHomeDir()).toBe("/tmp/tripwire-test-home");
      expect(getStateDir()).toBe(
        path.join("/tmp/tripwire-test-home", ".agent-tripwire"),
      );
    } finally {
      if (prev === undefined) delete process.env.AGENT_TRIPWIRE_HOME;
      else process.env.AGENT_TRIPWIRE_HOME = prev;
    }
  });
});
