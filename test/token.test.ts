import { describe, expect, it } from "vitest";
import {
  BANNED_PREFIXES,
  generateSecretLike,
  generateToken,
  startsWithBannedPrefix,
} from "../src/token.js";
import { formatTokenLabel } from "../src/token-label.js";

describe("token generator", () => {
  it("produces tw + 26 base32 chars without banned prefixes", () => {
    for (let i = 0; i < 20; i++) {
      const t = generateToken();
      expect(t).toMatch(/^tw[A-Z2-7]{26}$/);
      expect(startsWithBannedPrefix(t)).toBe(false);
      for (const p of BANNED_PREFIXES) {
        expect(t.toLowerCase().startsWith(p.toLowerCase())).toBe(false);
      }
    }
  });

  it("generateSecretLike avoids banned prefixes case-insensitively", () => {
    for (let i = 0; i < 20; i++) {
      const s = generateSecretLike();
      expect(s).toHaveLength(40);
      expect(startsWithBannedPrefix(s)).toBe(false);
      for (const p of BANNED_PREFIXES) {
        expect(s.toLowerCase().startsWith(p.toLowerCase())).toBe(false);
      }
    }
  });

  it("startsWithBannedPrefix is case-insensitive for tokens and secrets", () => {
    expect(startsWithBannedPrefix("akiaXXXX")).toBe(true);
    expect(startsWithBannedPrefix("AKIAXXXX")).toBe(true);
    expect(startsWithBannedPrefix("GhP_xxxx")).toBe(true);
    expect(startsWithBannedPrefix("Sk-xxxx")).toBe(true);
    expect(startsWithBannedPrefix("twSAFE")).toBe(false);
    // Secrets are lowercased; guard must still catch mixed-case banned prefixes
    expect(startsWithBannedPrefix("npm_abc")).toBe(true);
    expect(startsWithBannedPrefix("NPM_abc")).toBe(true);
  });
});

describe("formatTokenLabel", () => {
  it("shows tw…last4 and never the full token", () => {
    const token = "twABCDEFGHIJKLMNOPQRSTUVWX";
    const label = formatTokenLabel(token);
    expect(label).toBe("tw…UVWX");
    expect(label).not.toBe(token);
    expect(label.length).toBeLessThan(token.length);
  });
});
