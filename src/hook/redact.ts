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

/** Known secret shapes. Each match is replaced with a redacted preview. */
const SECRET_PATTERNS: RegExp[] = [
  // key=value / key: value with a long value
  /((?:api[_-]?key|secret|token|password|passwd|pwd|auth(?:orization)?|bearer|access[_-]?key|private[_-]?key|client[_-]?secret)[\w-]*\s*[:=]\s*["']?)([^\s"'&;|]{6,})/gi,
  // HTTP auth headers
  /((?:authorization:\s*)?(?:bearer|basic|token)\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
  // user:password@host in URLs
  /(\/\/[^\s/:@]+:)([^\s/@]{3,})(@)/g,
  // Well-known prefixes
  /()((?:AKIA|ASIA)[A-Z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g,
  // Tripwire decoy tokens (tw + long id)
  /()(\btw[A-Za-z0-9_-]{16,})/g,
  // Long opaque blobs (base64 / hex), 32+ chars
  /()(\b[A-Za-z0-9+/_-]{32,}={0,2})/g,
];

/**
 * Redact secret-looking values in free text (shell commands, MCP input,
 * messages) before it is logged, shown in a notification or returned to the IDE.
 */
export function scrubText(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, pre: string, value: string, post?: string) => {
      const { valuePreview } = redactSecretValue(value);
      return `${pre}[redacted ${valuePreview}]${typeof post === "string" ? post : ""}`;
    });
  }
  return out;
}
