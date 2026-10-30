/** Redacted token label for CLI output: tw…last4 — never print the full token. */
export function formatTokenLabel(tokenId: string): string {
  const last4 = tokenId.length >= 4 ? tokenId.slice(-4) : tokenId;
  return `tw…${last4}`;
}
