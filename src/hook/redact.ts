import { createHash } from "node:crypto";

/** sha256 + first-4 + length. Never store or return the raw secret. */
export function redactSecretValue(value: string): {
  valueSha256: string;
  valuePreview: string;
} {
  const valueSha256 = createHash("sha256").update(value, "utf8").digest("hex");
  const prefix = value.slice(0, Math.min(4, value.length));
  return {
    valueSha256,
    valuePreview: `${prefix}…(len=${value.length})`,
  };
}

/** Replace any known decoy/secret values in `text` with redacted previews. */
export function scrubKnownValues(text: string, values: string[]): string {
  let out = text;
  const sorted = [...values].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  for (const v of sorted) {
    if (!out.includes(v)) continue;
    const { valuePreview } = redactSecretValue(v);
    out = out.split(v).join(valuePreview);
  }
  return out;
}
