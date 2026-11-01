import type { DecoyRecord } from "./manifest.js";

export interface TokenMatch {
  /** Matched string (token or secret-like). */
  value: string;
  /** Primary decoy token id (for labels / dedupe). */
  tokenId: string;
  /** Absolute decoy file path. */
  decoyPath: string;
}

export interface TokenMatcher {
  /** Find all token/secret hits in `text` (deduped by tokenId within the call). */
  findAll(text: string): TokenMatch[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match values for a decoy: matchValues if present, else [tokenId]. */
export function valuesForDecoy(decoy: DecoyRecord): string[] {
  if (decoy.matchValues && decoy.matchValues.length > 0) {
    return [...new Set(decoy.matchValues)];
  }
  return [decoy.tokenId];
}

/**
 * Build one precompiled regex over all active decoy tokens and secret-likes.
 * Longer values are tried first so a shorter token cannot shadow a longer one.
 */
export function buildTokenMatcher(decoys: DecoyRecord[]): TokenMatcher {
  const byValue = new Map<string, { tokenId: string; decoyPath: string }>();
  for (const d of decoys) {
    for (const v of valuesForDecoy(d)) {
      if (v.length === 0) continue;
      // First decoy wins if the same value were somehow shared.
      if (!byValue.has(v)) {
        byValue.set(v, { tokenId: d.tokenId, decoyPath: d.path });
      }
    }
  }

  if (byValue.size === 0) {
    return { findAll: () => [] };
  }

  const values = [...byValue.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(values.map(escapeRegExp).join("|"), "g");

  return {
    findAll(text: string): TokenMatch[] {
      if (text.length === 0) return [];
      pattern.lastIndex = 0;
      const seenToken = new Set<string>();
      const out: TokenMatch[] = [];
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text)) !== null) {
        const value = m[0];
        const meta = byValue.get(value);
        if (!meta) continue;
        if (seenToken.has(meta.tokenId)) continue;
        seenToken.add(meta.tokenId);
        out.push({
          value,
          tokenId: meta.tokenId,
          decoyPath: meta.decoyPath,
        });
        // Avoid zero-length loops (should not happen with our tokens).
        if (m[0].length === 0) pattern.lastIndex++;
      }
      return out;
    },
  };
}
