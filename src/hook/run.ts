import path from "node:path";
import { loadManifest, type DecoyRecord } from "../manifest.js";
import { valuesForDecoy } from "../match.js";
import { commandHasBoundedPathToken } from "../path-match.js";
import { resolveProjectRoot } from "../git-exclude.js";
import { canonicalizePathSync } from "../path-util.js";
import {
  appendIncident,
  defaultAllowlist,
  defaultProjectConfig,
  loadAllowlist,
  loadInstallMeta,
  loadProjectConfig,
  type IncidentRecord,
  type ProjectAllowlist,
  type ProjectConfig,
} from "../project-state.js";
import { scrubKnownValues, scrubText } from "./redact.js";
import { activePause } from "../pause.js";
import {
  evaluateHook,
  type HookAgent,
  type HookDecision,
  type HookPermission,
} from "./decision.js";
import { notifyHookAlert } from "./notify-hook.js";

export interface HookRunResult {
  /** JSON object to print on stdout (agent-specific shape). */
  response: Record<string, unknown>;
  decision: HookDecision;
  agent: HookAgent;
  projectRoot: string;
  /** Exit code hint: 0 success; Cursor uses 2 for deny equivalently but we prefer JSON. */
  exitCode: number;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function detectAgent(
  payload: Record<string, unknown>,
): HookAgent | "unknown" {
  const event = String(
    payload.hook_event_name ?? payload.hookEventName ?? "",
  );
  if (
    event === "PreToolUse" ||
    event === "PostToolUse" ||
    event === "PermissionRequest"
  ) {
    return "claude-code";
  }
  if (
    event === "beforeReadFile" ||
    event === "beforeShellExecution" ||
    event === "beforeMCPExecution" ||
    event === "preToolUse"
  ) {
    return "cursor";
  }
  if (Array.isArray(payload.workspace_roots) || typeof payload.conversation_id === "string") {
    return "cursor";
  }
  if (typeof payload.session_id === "string" && payload.tool_input !== undefined) {
    return "claude-code";
  }
  return "unknown";
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveRoot(
  payload: Record<string, unknown>,
  agent: HookAgent,
): string {
  if (agent === "cursor") {
    const roots = Array.isArray(payload.workspace_roots)
      ? (payload.workspace_roots as unknown[]).filter(
          (r): r is string => typeof r === "string" && r.length > 0,
        )
      : [];
    if (roots.length > 0) {
      // Multi-root: pick the root that contains the file / cwd, else the first.
      const probe =
        typeof payload.file_path === "string"
          ? payload.file_path
          : typeof payload.cwd === "string"
            ? payload.cwd
            : undefined;
      if (probe && path.isAbsolute(probe)) {
        const hit = roots.find((r) =>
          isInside(canonicalizePathSync(probe), canonicalizePathSync(r)),
        );
        if (hit) return canonicalizePathSync(hit);
      }
      return canonicalizePathSync(roots[0]!);
    }
  }
  if (typeof payload.cwd === "string" && payload.cwd.length > 0) {
    return resolveProjectRoot(payload.cwd).projectRoot;
  }
  const toolInput = asRecord(payload.tool_input);
  if (toolInput && typeof toolInput.cwd === "string") {
    return resolveProjectRoot(toolInput.cwd).projectRoot;
  }
  return resolveProjectRoot(process.cwd()).projectRoot;
}

function cursorResponse(
  decision: HookDecision,
  event: string,
): Record<string, unknown> {
  // beforeReadFile: docs list permission allow|deny and user_message only.
  // beforeShellExecution / beforeMCPExecution: allow|deny|ask + user_message + agent_message.
  const permission: HookPermission =
    event === "beforeReadFile" && decision.permission === "ask"
      ? "deny"
      : decision.permission;

  const out: Record<string, unknown> = { permission };
  if (decision.userMessage) {
    out.user_message = decision.userMessage;
  }
  if (
    decision.agentMessage &&
    (event === "beforeShellExecution" ||
      event === "beforeMCPExecution" ||
      event === "preToolUse")
  ) {
    out.agent_message = decision.agentMessage;
  }
  // beforeReadFile: only user_message documented; still include for IDE visibility when denied.
  if (event === "beforeReadFile" && decision.userMessage) {
    out.user_message = decision.userMessage;
  }
  return out;
}

function claudeResponse(decision: HookDecision): Record<string, unknown> {
  // Official PreToolUse decision control:
  // hookSpecificOutput.permissionDecision + permissionDecisionReason
  // https://docs.claude.com/en/docs/claude-code/hooks
  if (decision.permission === "allow" && decision.rule === "none") {
    // Silent allow — exit 0 with empty object is fine; omit decision noise.
    return {};
  }
  const permission =
    decision.permission === "ask"
      ? "deny" // Claude ask prompts user; for exfil we deny with reason (product: Claude denies)
      : decision.permission;

  // Product: Claude denies with a reason for rule (c). Real-secret alert+allow keeps allow.
  const decisionPermission =
    decision.rule === "exfil"
      ? "deny"
      : decision.rule === "real-secret" && decision.permission === "allow"
        ? "allow"
        : permission;

  if (decisionPermission === "allow" && decision.rule === "real-secret") {
    // Alert-only: return no decision so Claude's normal permission prompt
    // still applies. "allow" would auto-approve and skip the prompt.
    return {};
  }

  if (decisionPermission === "allow") {
    return {};
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decisionPermission,
      permissionDecisionReason:
        decision.agentMessage || decision.userMessage || "Blocked by Tripwire",
    },
  };
}

function extractFields(
  payload: Record<string, unknown>,
  agent: HookAgent,
): {
  event: string;
  filePath?: string;
  content?: string;
  command?: string;
  cwd?: string;
  toolName?: string;
  toolInputText?: string;
} {
  const event = String(payload.hook_event_name ?? "");
  if (agent === "cursor") {
    const filePath =
      typeof payload.file_path === "string" ? payload.file_path : undefined;
    const content =
      typeof payload.content === "string" ? payload.content : undefined;
    const command =
      typeof payload.command === "string" ? payload.command : undefined;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
    const toolName =
      typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    let toolInputText: string | undefined;
    if (typeof payload.tool_input === "string") {
      toolInputText = payload.tool_input;
    } else if (payload.tool_input !== undefined) {
      toolInputText = JSON.stringify(payload.tool_input);
    }
    return {
      event,
      ...(filePath !== undefined ? { filePath } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(toolName !== undefined ? { toolName } : {}),
      ...(toolInputText !== undefined ? { toolInputText } : {}),
    };
  }

  // Claude PreToolUse
  const toolName =
    typeof payload.tool_name === "string" ? payload.tool_name : undefined;
  const toolInput = asRecord(payload.tool_input) ?? {};
  const filePath =
    typeof toolInput.file_path === "string" ? toolInput.file_path : undefined;
  const command =
    typeof toolInput.command === "string" ? toolInput.command : undefined;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
  const toolInputText = JSON.stringify(payload.tool_input ?? {});
  // Read has no content in PreToolUse (pre-read); path-only for decoys.
  return {
    event: event || "PreToolUse",
    ...(filePath !== undefined ? { filePath } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    toolInputText,
  };
}

/**
 * Load every project-scope decoy (all projects). Decoys are matched by
 * absolute path or token, so cwd / workspace root differences can't hide them.
 */
async function loadAllProjectDecoys(): Promise<DecoyRecord[]> {
  const manifest = await loadManifest();
  return manifest.decoys.filter(
    (d) => d.scope === "project" && d.projectRoot !== undefined,
  );
}

interface LoadedState {
  decoys: DecoyRecord[];
  allowlist: ProjectAllowlist;
  config: ProjectConfig;
  /** Names of state files that failed to load (never means allow-all). */
  errors: string[];
}

async function loadStateSafely(projectRoot: string): Promise<LoadedState> {
  const errors: string[] = [];
  const [decoys, allowlist, config] = await Promise.all([
    loadAllProjectDecoys().catch(() => {
      errors.push("manifest");
      return [] as DecoyRecord[];
    }),
    loadAllowlist(projectRoot).catch(() => {
      // Corrupt allowlist: ignore it entirely (no suppression), keep guarding.
      errors.push("allow.json");
      return defaultAllowlist();
    }),
    loadProjectConfig(projectRoot).catch(() => {
      errors.push("config.json");
      return defaultProjectConfig();
    }),
  ]);
  return { decoys, allowlist, config, errors };
}

/**
 * Fallback when the manifest can't be read: deny any access to the decoy
 * paths recorded in this project's .tripwire/install.json.
 */
async function fallbackDecoyDeny(
  projectRoot: string,
  agent: HookAgent,
  filePath: string | undefined,
  command: string | undefined,
): Promise<HookDecision | null> {
  let rels: string[] = [];
  try {
    rels = (await loadInstallMeta(projectRoot))?.decoyRelPaths ?? [];
  } catch {
    rels = [];
  }
  // Last resort: Tripwire's default decoy names.
  if (rels.length === 0) {
    rels = [".env.backup", ".env.local.old", path.join("config", "secrets.legacy.json")];
  }
  const label = agent === "cursor" ? "Cursor" : "Claude Code";
  for (const rel of rels) {
    const abs = canonicalizePathSync(path.resolve(projectRoot, rel));
    const relPosix = rel.split(/[\\/]/).join("/");
    const fileHit =
      filePath !== undefined &&
      canonicalizePathSync(filePath).toLowerCase() === abs.toLowerCase();
    const cmdHit =
      command !== undefined &&
      (commandHasBoundedPathToken(command, relPosix) ||
        commandHasBoundedPathToken(command, rel) ||
        commandHasBoundedPathToken(command, abs));
    if (fileHit || cmdHit) {
      const m = `Tripwire: ${label} tried to access a decoy secret (${relPosix}). Blocked. (Tripwire state was unreadable; fallback guard.)`;
      return {
        permission: "deny",
        rule: "decoy",
        severity: "high",
        userMessage: m,
        agentMessage: m,
        target: relPosix,
        decoyDeny: true,
      };
    }
  }
  return null;
}

/** Final redaction pass on everything that leaves the hook. */
function sanitizeDecision(
  decision: HookDecision,
  decoys: DecoyRecord[],
): HookDecision {
  const known = decoys.flatMap((d) => valuesForDecoy(d));
  const clean = (t: string) => scrubText(scrubKnownValues(t, known));
  return {
    ...decision,
    userMessage: clean(decision.userMessage),
    agentMessage: clean(decision.agentMessage),
    target: clean(decision.target),
  };
}

function shouldNotify(decision: HookDecision): boolean {
  if (decision.rule === "none" || decision.rule === "allowlist") return false;
  return (
    decision.permission === "deny" ||
    decision.permission === "ask" ||
    decision.rule === "real-secret"
  );
}

/**
 * Process one hook stdin JSON payload. Fail-open on unexpected errors, except
 * when a decoy deny was already computed.
 */
export async function runHookPayload(
  raw: string,
  options: { notify?: boolean; recordIncident?: boolean } = {},
): Promise<HookRunResult> {
  let decoyDenyFallback: HookDecision | null = null;
  try {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Malformed input — fail open.
      return {
        response: { permission: "allow" },
        decision: {
          permission: "allow",
          rule: "none",
          severity: "info",
          userMessage: "",
          agentMessage: "",
          target: "",
          decoyDeny: false,
        },
        agent: "cursor",
        projectRoot: process.cwd(),
        exitCode: 0,
      };
    }

    const agentRaw = detectAgent(payload);
    const agent: HookAgent = agentRaw === "unknown" ? "cursor" : agentRaw;
    const projectRoot = resolveRoot(payload, agent);
    const fields = extractFields(payload, agent);
    // Relative tool paths (Claude Read) resolve against the agent's cwd.
    if (fields.filePath && !path.isAbsolute(fields.filePath)) {
      fields.filePath = path.resolve(fields.cwd ?? projectRoot, fields.filePath);
    }
    const state = await loadStateSafely(projectRoot);
    const { decoys, allowlist, config } = state;

    let decision = evaluateHook({
      agent,
      event: fields.event,
      projectRoot,
      decoys,
      allowlist,
      config,
      ...(fields.filePath !== undefined ? { filePath: fields.filePath } : {}),
      ...(fields.content !== undefined ? { content: fields.content } : {}),
      ...(fields.command !== undefined ? { command: fields.command } : {}),
      ...(fields.cwd !== undefined ? { cwd: fields.cwd } : {}),
      ...(fields.toolName !== undefined ? { toolName: fields.toolName } : {}),
      ...(fields.toolInputText !== undefined
        ? { toolInputText: fields.toolInputText }
        : {}),
    });

    if (state.errors.includes("manifest") && !decision.decoyDeny) {
      const fb = await fallbackDecoyDeny(
        projectRoot,
        agent,
        fields.filePath,
        fields.command,
      );
      if (fb) decision = fb;
    }

    decision = sanitizeDecision(decision, decoys);
    const incidentRoot = decision.decoyProjectRoot ?? projectRoot;

    // Snooze: `agent-tripwire pause --for 30m` turns blocks into log-only
    // until it expires. Tamper attempts are never snoozed.
    let pausedUntil: string | null = null;
    if (
      decision.rule !== "none" &&
      decision.rule !== "allowlist" &&
      decision.rule !== "tamper"
    ) {
      const pause = await activePause(incidentRoot).catch(() => null);
      if (pause) {
        pausedUntil = pause.until;
        decision = {
          ...decision,
          permission: "allow",
          decoyDeny: false,
        };
      }
    }

    if (decision.decoyDeny) {
      decoyDenyFallback = decision;
    }

    const response =
      agent === "claude-code"
        ? claudeResponse(decision)
        : cursorResponse(decision, fields.event);

    if (options.recordIncident !== false && decision.rule !== "none") {
      const sessionId = String(
        payload.session_id ?? payload.conversation_id ?? "",
      );
      const transcriptPath = String(payload.transcript_path ?? "");
      const incident: IncidentRecord = {
        at: new Date().toISOString(),
        agent,
        sessionId,
        transcriptPath,
        rule: decision.rule,
        severity: decision.severity,
        action:
          pausedUntil !== null ||
          (decision.permission === "allow" && decision.rule === "real-secret")
            ? "alert"
            : decision.permission,
        target: decision.target,
        verdict:
          (decision.userMessage || decision.permission) +
          (pausedUntil !== null ? ` [paused until ${pausedUntil}; not blocked]` : "") +
          (state.errors.length > 0
            ? ` [warning: unreadable Tripwire state: ${state.errors.join(", ")}]`
            : ""),
        ...(decision.valueSha256 !== undefined
          ? { valueSha256: decision.valueSha256 }
          : {}),
        ...(decision.valuePreview !== undefined
          ? { valuePreview: decision.valuePreview }
          : {}),
      };
      try {
        await appendIncident(incidentRoot, incident);
      } catch {
        // never break hook on log failure
      }
    }

    if (
      options.notify !== false &&
      config.notify !== false &&
      pausedUntil === null &&
      shouldNotify(decision) &&
      decision.userMessage
    ) {
      notifyHookAlert(decision.userMessage);
    }

    return {
      response,
      decision,
      agent,
      projectRoot,
      exitCode: 0,
    };
  } catch {
    if (decoyDenyFallback) {
      return {
        response: {
          permission: "deny",
          user_message: decoyDenyFallback.userMessage,
          agent_message: decoyDenyFallback.agentMessage,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: decoyDenyFallback.agentMessage,
          },
        },
        decision: decoyDenyFallback,
        agent: "cursor",
        projectRoot: process.cwd(),
        exitCode: 0,
      };
    }
    // Fail open
    return {
      response: { permission: "allow" },
      decision: {
        permission: "allow",
        rule: "none",
        severity: "info",
        userMessage: "",
        agentMessage: "",
        target: "",
        decoyDeny: false,
      },
      agent: "cursor",
      projectRoot: process.cwd(),
      exitCode: 0,
    };
  }
}

/** Read all of stdin as utf8. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function formatIncidentsCli(
  incidents: IncidentRecord[],
  options: { severity?: string; limit?: number } = {},
): string {
  let list = [...incidents].sort((a, b) => (a.at < b.at ? 1 : -1));
  if (options.severity) {
    const sev = options.severity.toLowerCase();
    list = list.filter((i) => i.severity === sev);
  }
  if (options.limit !== undefined && options.limit >= 0) {
    list = list.slice(0, options.limit);
  }
  if (list.length === 0) {
    return "No incidents.";
  }
  const lines: string[] = [];
  for (const i of list) {
    lines.push(
      `${i.at}  [${i.severity}]  ${i.action}  ${i.rule}  ${i.agent}  ${i.target}`,
    );
    if (i.verdict) lines.push(`  ${i.verdict}`);
    if (i.valuePreview) {
      lines.push(`  value ${i.valuePreview} sha256=${i.valueSha256 ?? "?"}`);
    }
    if (i.sessionId) lines.push(`  session ${i.sessionId}`);
    if (i.transcriptPath) lines.push(`  transcript ${i.transcriptPath}`);
  }
  return lines.join("\n");
}
