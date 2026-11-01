/**
 * Documented process exit codes for each CLI command.
 *
 * | command     | 0                                      | 1                                              |
 * |-------------|----------------------------------------|------------------------------------------------|
 * | init        | planted / skipped OK                   | rolled back decoys or refused tracked paths    |
 * | remove      | always (idempotent; reports via stdout)| (unused)                                       |
 * | scan        | no hits                                | one or more hits                               |
 * | watch       | clean stop (SIGINT/SIGTERM)            | fatal startup / unrecoverable error            |
 * | status      | report printed                         | fatal error loading state                      |
 * | test-alert  | sample stdout (+ notify attempted)     | notify threw synchronously                     |
 */
export const EXIT = {
  OK: 0,
  /** init rollback / refused; scan hits; watch/status/test-alert fatal */
  FAIL: 1,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
