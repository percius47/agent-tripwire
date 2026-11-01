import path from "node:path";
import { toPosixPath } from "../path-match.js";

/** Basenames / patterns treated as real secret files (high severity). */
const SECRET_BASENAME_RE =
  /^(\.env([.].*)?|\.npmrc|.*\.pem|.*\.key|id_rsa.*|credentials|credentials\.json|secrets?\.(json|ya?ml|toml|env))$/i;

const SECRET_PATH_SEGMENT_RE =
  /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker)(\/|$)/i;

/** Shell tools that read file contents. */
const READ_CMDS =
  /\b(cat|head|tail|less|more|type|Get-Content|gc|Get-Item|gi|Get-Content\b|bat|rg\s+.*|grep\s+)\b/i;

/** Network / exfil-ish commands. */
const NETWORK_CMDS =
  /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|nc|ncat|netcat|ssh|scp|sftp|ftp)\b/i;

export function looksLikeSecretPath(filePath: string): boolean {
  const posix = toPosixPath(filePath);
  const base = path.posix.basename(posix);
  if (SECRET_BASENAME_RE.test(base)) {
    // Allow our own decoy siblings (.env.backup / .env.local.old) — those are rule (a).
    if (/\.backup$/i.test(base) || /\.old$/i.test(base)) return false;
    return true;
  }
  if (SECRET_PATH_SEGMENT_RE.test(posix)) return true;
  // Home ssh/aws shorthand
  if (/(^|\/)~?\/?\.ssh(\/|$)/i.test(posix)) return true;
  if (/(^|\/)~?\/?\.aws(\/|$)/i.test(posix)) return true;
  return false;
}

export function commandReadsSecretPath(command: string): boolean {
  if (!READ_CMDS.test(command)) return false;
  // Heuristic: command mentions a secret-looking token.
  const tokens = command.split(/[\s"'`]+/).filter(Boolean);
  for (const t of tokens) {
    if (looksLikeSecretPath(t)) return true;
    // Expand ~\.ssh style
    if (/~[\\/]\.ssh/i.test(t) || /~[\\/]\.aws/i.test(t)) return true;
  }
  // Also check whole command for path substrings
  if (SECRET_PATH_SEGMENT_RE.test(toPosixPath(command))) return true;
  if (/\.env\b/i.test(command) && !/\.env\.(backup|local\.old)\b/i.test(command)) {
    return READ_CMDS.test(command);
  }
  return false;
}

export function isNetworkExfilCommand(command: string): boolean {
  if (!NETWORK_CMDS.test(command)) return false;
  // Carrying a file or env var: @file, -d @, --data, $VAR, %VAR%, ${VAR}, Get-Content pipe
  if (/[$@%]|`|--data|-d\s| -F |--upload|-T\s|Get-Content|\btype\b|\bcat\b/i.test(command)) {
    return true;
  }
  return false;
}

/** Rough heuristic: string looks like a high-entropy secret (not a decoy tw… token). */
export function looksLikeSecretValue(text: string): boolean {
  if (text.length < 16) return false;
  // Common secret prefixes (real-looking — we never plant these)
  if (/^\s*(AKIA|ASIA|ghp_|gho_|github_pat_|sk-|xox[bprs]-|AIza)/.test(text)) {
    return true;
  }
  // Long base64-ish or hex blobs
  if (/^[A-Za-z0-9+/=_-]{32,}$/.test(text.trim())) return true;
  return false;
}

export function textContainsSecretLookingValue(text: string): boolean {
  if (looksLikeSecretValue(text)) return true;
  // Key=value assignments with long values
  const re =
    /(?:api[_-]?key|secret|token|password|passwd|authorization|bearer)\s*[:=]\s*["']?([^\s"']{16,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] && looksLikeSecretValue(m[1])) return true;
  }
  return false;
}
