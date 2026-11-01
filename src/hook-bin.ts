#!/usr/bin/env node
/**
 * agent-tripwire-hook — stdin JSON → local allow/deny/ask decision.
 * No network. No daemon. Fail-open except evaluated decoy denies.
 */
import { readStdin, runHookPayload } from "./hook/run.js";

async function main(): Promise<void> {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    process.stdout.write(`${JSON.stringify({ permission: "allow" })}\n`);
    process.exitCode = 0;
    return;
  }

  try {
    const result = await runHookPayload(raw);
    // Always print JSON (Cursor requires valid schema on permission hooks;
    // empty object is OK for Claude silent allow).
    process.stdout.write(`${JSON.stringify(result.response)}\n`);
    process.exitCode = result.exitCode;
  } catch {
    // Last-resort fail-open. Decoy deny path is handled inside runHookPayload.
    process.stdout.write(`${JSON.stringify({ permission: "allow" })}\n`);
    process.exitCode = 0;
  }
}

void main();
