import { randomBytes } from "node:crypto";

/** Provider prefixes that must never appear at the start of a token value. */
export const BANNED_PREFIXES = [
  "AKIA",
  "ASIA",
  "ghp_",
  "gho_",
  "npm_",
  "sk-",
  "xox",
  "AIza",
] as const;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOKEN_BODY_LENGTH = 26;
const PREFIX = "tw";

/** Encode bytes as Crockford-style uppercase base32 (RFC 4648 alphabet). */
function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Generate a non-functional decoy token: `tw` + 26 base32 characters.
 * Retries if the full string would start with a banned provider prefix
 * (defensive; the fixed `tw` prefix already avoids them).
 */
export function generateToken(): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    // 17 bytes ≈ 136 bits → enough for 26 base32 chars (130 bits)
    const body = toBase32(randomBytes(17)).slice(0, TOKEN_BODY_LENGTH);
    const token = `${PREFIX}${body}`;
    if (!startsWithBannedPrefix(token)) {
      return token;
    }
  }
  throw new Error("Failed to generate a token without a banned prefix");
}

export function startsWithBannedPrefix(value: string): boolean {
  return BANNED_PREFIXES.some((p) => value.startsWith(p));
}

/** Generate a 40-char opaque secret-looking string (non-functional). */
export function generateSecretLike(): string {
  return toBase32(randomBytes(25)).slice(0, 40).toLowerCase();
}
