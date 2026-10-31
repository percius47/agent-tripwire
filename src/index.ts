export {
  generateToken,
  generateSecretLike,
  BANNED_PREFIXES,
  startsWithBannedPrefix,
} from "./token.js";
export { formatTokenLabel } from "./token-label.js";
export { getHomeDir, getStateDir, getManifestPath } from "./paths.js";
export {
  loadManifest,
  saveManifest,
  emptyManifest,
  ensureStateDir,
  addCreatedDirs,
  type Manifest,
  type DecoyRecord,
} from "./manifest.js";
export {
  projectDecoyPlans,
  homeDecoyPlans,
  FORBIDDEN_WRITE_PATHS,
} from "./decoys.js";
export {
  plantOne,
  plantPlans,
  sha256,
  assertSafePlantTarget,
  isForbiddenEnvName,
  ensureDirsCreated,
  commitWxWrite,
  type PlantResult,
} from "./plant.js";
export {
  runInit,
  formatInitReport,
  type InitOptions,
  type InitReport,
} from "./init.js";
export {
  isGitRepo,
  gitTopLevel,
  writeExcludeBlock,
  stripExcludeBlock,
  isIgnored,
  trackedPaths,
  resolveProjectRoot,
  setCheckIgnoreForTests,
  EXCLUDE_BEGIN,
  EXCLUDE_END,
} from "./git-exclude.js";
export {
  runRemove,
  formatRemoveReport,
  removeDirIfEmpty,
  type RemoveOptions,
  type RemoveReport,
} from "./remove.js";
export { PRIVATE_FILE_MODE } from "./fs-mode.js";
export {
  getOffsetsPath,
  getHitsPath,
  getConfigPath,
} from "./paths.js";
export { loadConfig, emptyConfig, type TripwireConfig } from "./config.js";
export {
  loadAdapters,
  createClaudeCodeAdapter,
  parseClaudeCodeLine,
  createCodexAdapter,
  parseCodexLine,
  createCursorAdapter,
  parseCursorLine,
  createConfigAdapter,
  type LogAdapter,
  type ParsedLine,
  type PathSignal,
  type PathSignalKind,
} from "./adapters/index.js";
export { buildTokenMatcher, valuesForDecoy } from "./match.js";
export {
  pathRefersToDecoy,
  findDecoyForToolPath,
  commandMentionsDecoy,
  normalizeToolPathForCompare,
  decoyProjectRelative,
} from "./path-match.js";
export { loadOffsets, saveOffsets, type OffsetsState } from "./offsets.js";
export {
  appendHit,
  buildHitSnippet,
  loadHits,
  seedSeenFromHits,
  hitDedupeKey,
  type HitRecord,
} from "./hits.js";
export { readNewLines } from "./tail.js";
export {
  processFile,
  runScanPass,
  resolveAdapterFiles,
  type EngineHit,
} from "./engine.js";
export { runScan, formatScanReport } from "./scan.js";
export { startWatch } from "./watch.js";
export { expandGlob, minimatchSimple, deriveWatchRoot } from "./glob-util.js";
export { notifyHit, sampleAlertLine } from "./notify.js";
export { runStatus, formatStatusReport } from "./status.js";
export { runTestAlert } from "./test-alert.js";
export { EXIT } from "./exit-codes.js";
