/**
 * Documented process exit codes for each CLI command.
 *
 * | command     | 0                                      | 1                                              |
 * |-------------|----------------------------------------|------------------------------------------------|
 * | init        | planted / skipped OK                   | rolled back decoys or refused tracked paths    |
 * | remove      | always (idempotent; reports via stdout)| (unused)                                       |
 * | scan        | no decoy tokens in scanned logs        | one or more decoy tokens still present in logs |
 * | scan --new-only | no brand-new hits                  | one or more hits not yet in hits.jsonl         |
 * | watch       | clean stop (SIGINT/SIGTERM)            | fatal startup / unrecoverable error            |
 * | status      | report printed                         | fatal error loading state                      |
 * | test-alert  | sample stdout (+ notify attempted)     | notify threw synchronously                     |
 *
 * Scan always exits 1 while logs still contain a decoy, even if that hit is
 * already in hits.jsonl. Dedupe applies only to hits.jsonl append and notify.
 * Pass --new-only for the legacy “new hits only” exit behavior.
 */
export const EXIT = {
  OK: 0,
  /** init rollback / refused; scan hits; watch/status/test-alert fatal */
  FAIL: 1,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
