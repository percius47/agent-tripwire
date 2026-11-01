import { copyFile, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  HOOK_COMMAND,
  HOOK_MARKER,
  ensureTripwireDir,
  loadInstallMeta,
  projectBackupsDir,
  saveInstallMeta,
  type InstallMeta,
} from "./project-state.js";

const CURSOR_HOOKS_REL = path.join(".cursor", "hooks.json");
const CLAUDE_SETTINGS_REL = path.join(".claude", "settings.json");

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Order-independent JSON compare so restore can still be byte-exact from backup. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as JsonObject;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function markedEntry(extra: JsonObject = {}): JsonObject {
  return {
    ...extra,
    command: HOOK_COMMAND,
    [HOOK_MARKER]: true,
  };
}

function isOurEntry(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  if (entry[HOOK_MARKER] === true) return true;
  return entry.command === HOOK_COMMAND;
}

async function readJsonFile(filePath: string): Promise<{
  exists: boolean;
  raw: string | null;
  value: unknown;
}> {
  try {
    const raw = await readFile(filePath, "utf8");
    try {
      return { exists: true, raw, value: JSON.parse(raw) };
    } catch {
      return { exists: true, raw, value: null };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { exists: false, raw: null, value: null };
    throw err;
  }
}

async function backupIfExists(
  projectRoot: string,
  relPath: string,
  backups: Record<string, string>,
): Promise<boolean> {
  const abs = path.join(projectRoot, relPath);
  const { exists, raw } = await readJsonFile(abs);
  if (!exists || raw === null) return false;
  if (backups[relPath]) return true; // already backed up on prior init
  await ensureTripwireDir(projectRoot);
  const stamp = Date.now().toString(36);
  const backupRel = path.join(
    ".tripwire",
    "backups",
    `${relPath.replace(/[\\/]/g, "__")}.${stamp}.bak`,
  );
  const backupAbs = path.join(projectRoot, backupRel);
  await mkdir(path.dirname(backupAbs), { recursive: true });
  await copyFile(abs, backupAbs);
  backups[relPath] = backupRel;
  return true;
}

function ensureCursorHooks(doc: JsonObject): JsonObject {
  const hooks = isObject(doc.hooks) ? { ...doc.hooks } : {};
  const events = [
    "beforeReadFile",
    "beforeShellExecution",
    "beforeMCPExecution",
  ] as const;

  for (const event of events) {
    const list = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const filtered = list.filter((e) => !isOurEntry(e));
    filtered.push(markedEntry());
    hooks[event] = filtered;
  }

  return {
    ...doc,
    version: typeof doc.version === "number" ? doc.version : 1,
    hooks,
  };
}

function stripCursorHooks(doc: JsonObject): JsonObject {
  const hooks = isObject(doc.hooks) ? { ...doc.hooks } : {};
  for (const key of Object.keys(hooks)) {
    const list = hooks[key];
    if (!Array.isArray(list)) continue;
    const next = list.filter((e) => !isOurEntry(e));
    if (next.length === 0) {
      delete hooks[key];
    } else {
      hooks[key] = next;
    }
  }
  const out: JsonObject = { ...doc, hooks };
  if (Object.keys(hooks).length === 0) {
    delete out.hooks;
  }
  return out;
}

function cursorEmptyAfterStrip(doc: JsonObject): boolean {
  const keys = Object.keys(doc).filter((k) => k !== "version");
  if (keys.length === 0) return true;
  if (keys.length === 1 && keys[0] === "hooks") {
    const hooks = doc.hooks;
    return isObject(hooks) && Object.keys(hooks).length === 0;
  }
  return false;
}

/** Claude PreToolUse matcher groups we install. */
const CLAUDE_MATCHERS = ["Read", "Bash", "PowerShell", "mcp__.*"] as const;

function ensureClaudeSettings(doc: JsonObject): JsonObject {
  const hooks = isObject(doc.hooks) ? { ...doc.hooks } : {};
  const pre = Array.isArray(hooks.PreToolUse)
    ? [...(hooks.PreToolUse as unknown[])]
    : [];

  // Drop prior tripwire matcher groups (identified by our command in nested hooks).
  const kept = pre.filter((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return true;
    return !(group.hooks as unknown[]).some((h) => isOurEntry(h));
  });

  for (const matcher of CLAUDE_MATCHERS) {
    kept.push({
      matcher,
      [HOOK_MARKER]: true,
      hooks: [
        {
          type: "command",
          command: HOOK_COMMAND,
          [HOOK_MARKER]: true,
        },
      ],
    });
  }

  return {
    ...doc,
    hooks: {
      ...hooks,
      PreToolUse: kept,
    },
  };
}

function stripClaudeSettings(doc: JsonObject): JsonObject {
  const hooks = isObject(doc.hooks) ? { ...doc.hooks } : {};
  if (Array.isArray(hooks.PreToolUse)) {
    const next = (hooks.PreToolUse as unknown[]).filter((group) => {
      if (!isObject(group)) return true;
      if (group[HOOK_MARKER] === true) return false;
      if (!Array.isArray(group.hooks)) return true;
      const nested = (group.hooks as unknown[]).filter((h) => !isOurEntry(h));
      if (nested.length === 0 && (group.hooks as unknown[]).some(isOurEntry)) {
        return false;
      }
      group.hooks = nested;
      return true;
    });
    if (next.length === 0) {
      delete hooks.PreToolUse;
    } else {
      hooks.PreToolUse = next;
    }
  }
  const out: JsonObject = { ...doc, hooks };
  if (Object.keys(hooks).length === 0) {
    delete out.hooks;
  }
  return out;
}

function claudeEmptyAfterStrip(doc: JsonObject): boolean {
  const keys = Object.keys(doc).filter((k) => k !== "hooks");
  if (keys.length > 0) return false;
  const hooks = doc.hooks;
  if (hooks === undefined) return true;
  return isObject(hooks) && Object.keys(hooks).length === 0;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export interface HooksInstallReport {
  cursorPath: string;
  claudePath: string;
  cursorCreated: boolean;
  claudeCreated: boolean;
  notes: string[];
}

export async function installProjectHooks(
  projectRoot: string,
  decoyRelPaths: string[],
): Promise<HooksInstallReport> {
  await ensureTripwireDir(projectRoot);
  const notes: string[] = [];
  const existingMeta = await loadInstallMeta(projectRoot);
  const backups: Record<string, string> = {
    ...(existingMeta?.backups ?? {}),
  };
  const createdFiles = new Set<string>(existingMeta?.createdFiles ?? []);

  // Cursor
  const cursorAbs = path.join(projectRoot, CURSOR_HOOKS_REL);
  const cursorBefore = await readJsonFile(cursorAbs);
  if (cursorBefore.exists) {
    await backupIfExists(projectRoot, CURSOR_HOOKS_REL, backups);
  } else {
    createdFiles.add(CURSOR_HOOKS_REL);
  }
  const cursorBase =
    cursorBefore.exists && isObject(cursorBefore.value)
      ? (cursorBefore.value as JsonObject)
      : { version: 1 };
  // Re-strip then re-add so init is idempotent.
  const cursorNext = ensureCursorHooks(stripCursorHooks(cursorBase));
  await writeJson(cursorAbs, cursorNext);
  notes.push(`Wrote ${CURSOR_HOOKS_REL}`);

  // Claude
  const claudeAbs = path.join(projectRoot, CLAUDE_SETTINGS_REL);
  const claudeBefore = await readJsonFile(claudeAbs);
  if (claudeBefore.exists) {
    await backupIfExists(projectRoot, CLAUDE_SETTINGS_REL, backups);
  } else {
    createdFiles.add(CLAUDE_SETTINGS_REL);
  }
  const claudeBase =
    claudeBefore.exists && isObject(claudeBefore.value)
      ? (claudeBefore.value as JsonObject)
      : {};
  const claudeNext = ensureClaudeSettings(stripClaudeSettings(claudeBase));
  await writeJson(claudeAbs, claudeNext);
  notes.push(`Wrote ${CLAUDE_SETTINGS_REL}`);

  const meta: InstallMeta = {
    version: 1,
    createdAt: existingMeta?.createdAt ?? new Date().toISOString(),
    projectRoot,
    createdFiles: [...createdFiles].sort(),
    backups,
    decoyRelPaths,
  };
  await saveInstallMeta(projectRoot, meta);

  return {
    cursorPath: cursorAbs,
    claudePath: claudeAbs,
    cursorCreated: createdFiles.has(CURSOR_HOOKS_REL),
    claudeCreated: createdFiles.has(CLAUDE_SETTINGS_REL),
    notes,
  };
}

export interface HooksRemoveReport {
  restored: string[];
  deleted: string[];
  rewritten: string[];
  notes: string[];
}

async function restoreOrStrip(options: {
  projectRoot: string;
  relPath: string;
  created: boolean;
  backupRel: string | undefined;
  strip: (doc: JsonObject) => JsonObject;
  isEmpty: (doc: JsonObject) => boolean;
}): Promise<"restored" | "deleted" | "rewritten" | "missing"> {
  const abs = path.join(options.projectRoot, options.relPath);
  const current = await readJsonFile(abs);
  if (!current.exists) return "missing";

  // Prefer byte-exact restore when we have a backup and current only differs by our entries.
  if (options.backupRel) {
    const backupAbs = path.join(options.projectRoot, options.backupRel);
    try {
      const backupRaw = await readFile(backupAbs);
      const backupParsed = JSON.parse(backupRaw.toString("utf8")) as unknown;
      if (isObject(backupParsed) && isObject(current.value)) {
        const strippedCurrent = options.strip(current.value);
        const strippedBackup = options.strip(backupParsed);
        // If after stripping ours, current equals backup (with ours also stripped = original),
        // and backup had none of ours, restore original bytes.
        if (
          deepEqualJson(strippedCurrent, strippedBackup) &&
          deepEqualJson(strippedBackup, backupParsed)
        ) {
          await writeFile(abs, backupRaw);
          return "restored";
        }
        // Backup is the pre-init original; if strip(current) equals it, restore bytes.
        if (deepEqualJson(strippedCurrent, backupParsed)) {
          await writeFile(abs, backupRaw);
          return "restored";
        }
      }
    } catch {
      // fall through to strip
    }
  }

  if (!isObject(current.value)) {
    // Unreadable JSON — leave alone.
    return "rewritten";
  }

  const stripped = options.strip(current.value);
  if (options.created && options.isEmpty(stripped)) {
    await unlink(abs);
    return "deleted";
  }

  await writeJson(abs, stripped);
  return "rewritten";
}

export async function removeProjectHooks(
  projectRoot: string,
): Promise<HooksRemoveReport> {
  const meta = await loadInstallMeta(projectRoot);
  const notes: string[] = [];
  const restored: string[] = [];
  const deleted: string[] = [];
  const rewritten: string[] = [];

  const created = new Set(meta?.createdFiles ?? []);
  const backups = meta?.backups ?? {};

  const cursorResult = await restoreOrStrip({
    projectRoot,
    relPath: CURSOR_HOOKS_REL,
    created: created.has(CURSOR_HOOKS_REL),
    backupRel: backups[CURSOR_HOOKS_REL],
    strip: stripCursorHooks,
    isEmpty: cursorEmptyAfterStrip,
  });
  if (cursorResult === "restored") restored.push(CURSOR_HOOKS_REL);
  else if (cursorResult === "deleted") deleted.push(CURSOR_HOOKS_REL);
  else if (cursorResult === "rewritten") rewritten.push(CURSOR_HOOKS_REL);

  const claudeResult = await restoreOrStrip({
    projectRoot,
    relPath: CLAUDE_SETTINGS_REL,
    created: created.has(CLAUDE_SETTINGS_REL),
    backupRel: backups[CLAUDE_SETTINGS_REL],
    strip: stripClaudeSettings,
    isEmpty: claudeEmptyAfterStrip,
  });
  if (claudeResult === "restored") restored.push(CLAUDE_SETTINGS_REL);
  else if (claudeResult === "deleted") deleted.push(CLAUDE_SETTINGS_REL);
  else if (claudeResult === "rewritten") rewritten.push(CLAUDE_SETTINGS_REL);

  // Clean empty .cursor / .claude dirs if we created the only file.
  const { removeDirIfEmpty } = await import("./remove.js");
  for (const dir of [".cursor", ".claude"]) {
    const removed = await removeDirIfEmpty(path.join(projectRoot, dir));
    if (removed) notes.push(`Removed empty ${dir}/`);
  }

  // Remove backups dir contents we created, then install.json handled by caller.
  try {
    const { readdir, rm } = await import("node:fs/promises");
    const bdir = projectBackupsDir(projectRoot);
    const entries = await readdir(bdir).catch(() => [] as string[]);
    for (const e of entries) {
      await rm(path.join(bdir, e), { force: true });
    }
    await removeDirIfEmpty(bdir);
  } catch {
    // ignore
  }

  return { restored, deleted, rewritten, notes };
}

export { CURSOR_HOOKS_REL, CLAUDE_SETTINGS_REL, CLAUDE_MATCHERS };
