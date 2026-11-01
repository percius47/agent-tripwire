import { describe, expect, it } from "vitest";
import {
  BANNED_PREFIXES,
  generateToken,
  startsWithBannedPrefix,
} from "../src/token.js";

describe("generateToken", () => {
  it("returns tw + 26 base32 characters", () => {
    const token = generateToken();
    expect(token).toMatch(/^tw[A-Z2-7]{26}$/);
    expect(token).toHaveLength(28);
  });

  it("never starts with a banned provider prefix", () => {
    const tokens = Array.from({ length: 200 }, () => generateToken());
    for (const token of tokens) {
      expect(startsWithBannedPrefix(token)).toBe(false);
      for (const prefix of BANNED_PREFIXES) {
        expect(token.startsWith(prefix)).toBe(false);
      }
    }
  });

  it("produces unique values across many draws", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(tokens.size).toBe(100);
  });
});
