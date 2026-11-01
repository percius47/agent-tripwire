import path from "node:path";
import type { DecoyRecord } from "../manifest.js";
import { buildTokenMatcher, valuesForDecoy } from "../match.js";
import {
  commandMentionsDecoy,
  findDecoyForToolPath,
  normalizeToolPathForCompare,
  toPosixPath,
} from "../path-match.js";
import type { ProjectAllowlist, ProjectConfig } from "../project-state.js";
import { redactSecretValue, scrubText } from "./redact.js";
import {
  commandReadsSecretPath,
  isNetworkExfilCommand,
  looksLikeSecretPath,
  textContainsSecretLookingValue,
} from "./secrets.js";

export type HookAgent = "cursor" | "claude-code";

export type HookPermission = "allow" | "deny" | "ask";

export type HookRule = "decoy" | "real-secret" | "exfil" | "allowlist" | "none";

export interface HookDecision {
  permission: HookPermission;
  rule: HookRule;
  severity: "high" | "medium" | "low" | "info";
  /** Shown to the user (IDE / OS). */
  userMessage: string;
  /** Fed back to the agent when supported. */
  agentMessage: string;
  target: string;
  valueSha256?: string;
  valuePreview?: string;
  /** True when this is a hard decoy deny that must survive fail-open. */
  decoyDeny: boolean;
  /** Project root of the decoy that matched (incident goes there). */
  decoyProjectRoot?: string;
}

export interface HookEvalInput {
  agent: HookAgent;
  /** Cursor: beforeReadFile | beforeShellExecution | beforeMCPExecution; Claude: PreToolUse */
  event: string;
  filePath?: string;
  content?: string;
  command?: string;
  cwd?: string;
  toolName?: string;
  /** Stringified MCP / tool input. */
  toolInputText?: string;
  projectRoot: string;
  decoys: DecoyRecord[];
  allowlist: ProjectAllowlist;
  config: ProjectConfig;
}

/**
 * All project-scope decoys, from every project. Matching is by absolute path
 * or token, so a decoy is caught even when the agent's cwd / workspace root
 * differs from the project where it was planted.
 */
function projectDecoys(decoys: DecoyRecord[]): DecoyRecord[] {
  return decoys.filter(
    (d) => d.scope === "project" && d.projectRoot !== undefined,
  );
}

function relForDisplay(projectRoot: string, d: DecoyRecord): string {
  const base = d.projectRoot ?? projectRoot;
  return toPosixPath(path.relative(base, d.path)) || d.path;
}

function allowlisted(
  allow: ProjectAllowlist,
  projectRoot: string,
  target: string,
  command?: string,
): boolean {
  const targetNorm = normalizeToolPathForCompare(target);
  for (const p of allow.paths) {
    const abs = path.isAbsolute(p) ? p : path.join(projectRoot, p);
    const n = normalizeToolPathForCompare(abs);
    if (targetNorm === n || targetNorm.endsWith(`/${toPosixPath(p)}`)) {
      return true;
    }
    if (toPosixPath(target).endsWith(toPosixPath(p))) return true;
  }
  if (command) {
    const lower = command.toLowerCase();
    for (const c of allow.commands) {
      if (c.length > 0 && lower.includes(c.toLowerCase())) return true;
    }
  }
  return false;
}

function msg(
  agentLabel: string,
  action: string,
  detail: string,
): { userMessage: string; agentMessage: string } {
  const userMessage = `Tripwire: ${agentLabel} ${action} (${detail}).`;
  return { userMessage, agentMessage: userMessage };
}

function agentLabel(agent: HookAgent): string {
  return agent === "cursor" ? "Cursor" : "Claude Code";
}

function findDecoyTokenInText(
  text: string,
  decoys: DecoyRecord[],
): { decoy: DecoyRecord; value: string } | null {
  const matcher = buildTokenMatcher(decoys);
  const hits = matcher.findAll(text);
  if (hits.length === 0) return null;
  const hit = hits[0]!;
  const decoy = decoys.find((d) => d.tokenId === hit.tokenId);
  if (!decoy) return null;
  return { decoy, value: hit.value };
}

/**
 * Evaluate a hook event locally. Prefer decoy deny (rule a) over other rules.
 */
export function evaluateHook(input: HookEvalInput): HookDecision {
  const decoys = projectDecoys(input.decoys);
  const label = agentLabel(input.agent);
  const target =
    input.filePath ??
    input.command ??
    input.toolName ??
    input.event;

  // --- Rule (a): decoy hit ---
  if (input.filePath) {
    const byPath = findDecoyForToolPath(input.filePath, decoys);
    if (byPath) {
      const rel = relForDisplay(input.projectRoot, byPath);
      const m = msg(label, "tried to read a decoy secret", rel);
      return {
        permission: "deny",
        rule: "decoy",
        severity: "high",
        userMessage: `${m.userMessage} Blocked.`,
        agentMessage: `${m.agentMessage} Blocked.`,
        target: rel,
        decoyDeny: true,
        ...(byPath.projectRoot ? { decoyProjectRoot: byPath.projectRoot } : {}),
      };
    }
  }

  const textBlobs = [
    input.content,
    input.command,
    input.toolInputText,
  ].filter((t): t is string => typeof t === "string" && t.length > 0);

  for (const blob of textBlobs) {
    const tokenHit = findDecoyTokenInText(blob, decoys);
    if (tokenHit) {
      const rel = relForDisplay(input.projectRoot, tokenHit.decoy);
      const red = redactSecretValue(tokenHit.value);
      const m = msg(
        label,
        "tried to use a decoy secret token",
        rel,
      );
      return {
        permission: "deny",
        rule: "decoy",
        severity: "high",
        userMessage: `${m.userMessage} Blocked.`,
        agentMessage: `${m.agentMessage} Blocked.`,
        target: rel,
        valueSha256: red.valueSha256,
        valuePreview: red.valuePreview,
        decoyDeny: true,
        ...(tokenHit.decoy.projectRoot
          ? { decoyProjectRoot: tokenHit.decoy.projectRoot }
          : {}),
      };
    }
  }

  if (input.command) {
    for (const d of decoys) {
      if (commandMentionsDecoy(input.command, d)) {
        const rel = relForDisplay(input.projectRoot, d);
        const m = msg(label, "ran a command targeting a decoy secret", rel);
        return {
          permission: "deny",
          rule: "decoy",
          severity: "high",
          userMessage: `${m.userMessage} Blocked.`,
          agentMessage: `${m.agentMessage} Blocked.`,
          target: rel,
          decoyDeny: true,
          ...(d.projectRoot ? { decoyProjectRoot: d.projectRoot } : {}),
        };
      }
    }
  }

  // Also scan all match values against tool input for MCP
  if (input.toolInputText) {
    for (const d of decoys) {
      for (const v of valuesForDecoy(d)) {
        if (v.length > 0 && input.toolInputText.includes(v)) {
          const rel = relForDisplay(input.projectRoot, d);
          const red = redactSecretValue(v);
          const m = msg(label, "sent a decoy token to an MCP tool", rel);
          return {
            permission: "deny",
            rule: "decoy",
            severity: "high",
            userMessage: `${m.userMessage} Blocked.`,
            agentMessage: `${m.agentMessage} Blocked.`,
            target: rel,
            valueSha256: red.valueSha256,
            valuePreview: red.valuePreview,
            decoyDeny: true,
            ...(d.projectRoot ? { decoyProjectRoot: d.projectRoot } : {}),
          };
        }
      }
    }
  }

  if (
    allowlisted(
      input.allowlist,
      input.projectRoot,
      input.filePath ?? target,
      input.command,
    )
  ) {
    return {
      permission: "allow",
      rule: "allowlist",
      severity: "info",
      ...msg(label, "allowed an allowlisted action", scrubText(target)),
      target: scrubText(target),
      decoyDeny: false,
    };
  }

  // --- Rule (c): exfil / MCP secret flow (before real-secret allow) ---
  const isMcp =
    input.event === "beforeMCPExecution" ||
    (typeof input.toolName === "string" &&
      (input.toolName.startsWith("mcp__") ||
        input.toolName.startsWith("MCP:")));

  if (isMcp && input.toolInputText) {
    if (
      textContainsSecretLookingValue(input.toolInputText) ||
      findDecoyTokenInText(input.toolInputText, decoys)
    ) {
      const permission: HookPermission =
        input.agent === "cursor" ? "ask" : "deny";
      const m = msg(
        label,
        permission === "ask"
          ? "may send a secret-looking value to an MCP tool — confirm"
          : "tried to send a secret-looking value to an MCP tool",
        input.toolName ?? "mcp",
      );
      return {
        permission,
        rule: "exfil",
        severity: "high",
        userMessage:
          permission === "deny" ? `${m.userMessage} Blocked.` : m.userMessage,
        agentMessage:
          permission === "deny" ? `${m.agentMessage} Blocked.` : m.agentMessage,
        target: input.toolName ?? "mcp",
        decoyDeny: false,
      };
    }
  }

  if (input.command && isNetworkExfilCommand(input.command)) {
    const permission: HookPermission =
      input.agent === "cursor" ? "ask" : "deny";
    const m = msg(
      label,
      permission === "ask"
        ? "may exfiltrate data over the network — confirm"
        : "tried a network command that may carry secrets",
      scrubText(input.command).slice(0, 120),
    );
    return {
      permission,
      rule: "exfil",
      severity: "high",
      userMessage:
        permission === "deny" ? `${m.userMessage} Blocked.` : m.userMessage,
      agentMessage:
        permission === "deny" ? `${m.agentMessage} Blocked.` : m.agentMessage,
      target: scrubText(input.command).slice(0, 200),
      decoyDeny: false,
    };
  }

  // --- Rule (b): real secret access — alert + allow (or block via config) ---
  const secretPath =
    (input.filePath && looksLikeSecretPath(input.filePath)) ||
    (input.command !== undefined && commandReadsSecretPath(input.command));

  if (secretPath) {
    const block = input.config.blockRealSecrets === true;
    // Cursor beforeReadFile only documents allow|deny (not ask).
    const permission: HookPermission = block ? "deny" : "allow";
    const detail = input.filePath
      ? toPosixPath(path.relative(input.projectRoot, input.filePath)) ||
        input.filePath
      : scrubText(input.command ?? target).slice(0, 120);
    const m = msg(
      label,
      block
        ? "tried to access a real secret file"
        : "accessed a real secret file",
      detail,
    );
    return {
      permission,
      rule: "real-secret",
      severity: "high",
      userMessage: block
        ? `${m.userMessage} Blocked.`
        : `${m.userMessage} Allowed (alert).`,
      agentMessage: block
        ? `${m.agentMessage} Blocked.`
        : `${m.agentMessage} Allowed (alert).`,
      target: detail,
      decoyDeny: false,
    };
  }

  return {
    permission: "allow",
    rule: "none",
    severity: "info",
    userMessage: "",
    agentMessage: "",
    target: scrubText(target),
    decoyDeny: false,
  };
}
