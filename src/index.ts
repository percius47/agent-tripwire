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
