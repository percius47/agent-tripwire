import notifier from "node-notifier";
import type { EngineHit } from "./engine.js";
import { formatTokenLabel } from "./token-label.js";

export interface NotifyFn {
  (hit: EngineHit): void;
}

/**
 * Desktop notification for a hit. Never includes the full token — uses the
 * pre-built alertLine (label + paths only). Failures are logged and swallowed
 * so watch/scan keep running.
 */
export function notifyHit(hit: EngineHit): void {
  try {
    // Double-check: never ship the raw tokenId in a notification body.
    const message = hit.alertLine.includes(hit.tokenId)
      ? hit.alertLine.split(hit.tokenId).join(formatTokenLabel(hit.tokenId))
      : hit.alertLine;
    notifier.notify(
      {
        title: "Agent Tripwire",
        message,
        wait: false,
      },
      (err?: Error | null) => {
        if (err) {
          console.warn(
            "tripwire: notification failed:",
            err instanceof Error ? err.message : err,
          );
        }
      },
    );
  } catch (err) {
    console.warn(
      "tripwire: notification failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Sample alert for `test-alert` (no manifest / hits touch). */
export function sampleAlertLine(): string {
  return "Tripwire: test-alert sample (tw…TEST) — notifications are working";
}

export function notifyTestAlert(): void {
  try {
    notifier.notify(
      {
        title: "Agent Tripwire",
        message: sampleAlertLine(),
        wait: false,
      },
      (err?: Error | null) => {
        if (err) {
          console.warn(
            "tripwire: notification failed:",
            err instanceof Error ? err.message : err,
          );
        }
      },
    );
  } catch (err) {
    console.warn(
      "tripwire: notification failed:",
      err instanceof Error ? err.message : err,
    );
    throw err;
  }
}
