import { notifyTestAlert, sampleAlertLine } from "./notify.js";
import { EXIT } from "./exit-codes.js";

export interface TestAlertReport {
  alertLine: string;
  notified: boolean;
  exitCode: number;
  error?: string;
}

/**
 * Fire one sample notification + stdout alert without touching the manifest
 * or hits log.
 */
export function runTestAlert(opts: {
  notify?: boolean;
} = {}): TestAlertReport {
  const alertLine = sampleAlertLine();
  const doNotify = opts.notify !== false;
  if (!doNotify) {
    return { alertLine, notified: false, exitCode: EXIT.OK };
  }
  try {
    notifyTestAlert();
    return { alertLine, notified: true, exitCode: EXIT.OK };
  } catch (err) {
    return {
      alertLine,
      notified: false,
      exitCode: EXIT.FAIL,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
