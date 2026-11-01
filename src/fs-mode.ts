/** Mode for decoy files and the manifest (owner read/write only). */
export const PRIVATE_FILE_MODE = 0o600;

/** POSIX file modes are not meaningful on Windows (ACLs); skip assertions there. */
export const SUPPORTS_POSIX_FILE_MODES = process.platform !== "win32";
