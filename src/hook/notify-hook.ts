import notifier from "node-notifier";

/**
 * Desktop notification for a hook incident. Failures must never break the hook.
 */
export function notifyHookAlert(message: string): void {
  if (!message) return;
  try {
    notifier.notify(
      {
        title: "Agent Tripwire",
        message: message.slice(0, 240),
        wait: false,
      },
      (err?: Error | null) => {
        if (err) {
          // Swallow — never break the hook.
        }
      },
    );
  } catch {
    // Swallow.
  }
}
