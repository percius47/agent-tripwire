export { generateToken, generateSecretLike, BANNED_PREFIXES, startsWithBannedPrefix } from "./token.js";
export { getHomeDir, getStateDir, getManifestPath } from "./paths.js";
export {
  loadManifest,
  saveManifest,
  emptyManifest,
  ensureStateDir,
  type Manifest,
  type DecoyRecord,
} from "./manifest.js";
export { projectDecoyPlans, homeDecoyPlans, FORBIDDEN_WRITE_PATHS } from "./decoys.js";
export { plantOne, plantPlans, sha256, type PlantResult } from "./plant.js";
export { runInit, formatInitReport, type InitOptions, type InitReport } from "./init.js";
export {
  runRemove,
  formatRemoveReport,
  type RemoveOptions,
  type RemoveReport,
  type RemoveAction,
} from "./remove.js";
export {
  EXCLUDE_BEGIN,
  EXCLUDE_END,
  defaultGitRunner,
  addExcludePaths,
  removeExcludePaths,
  parseExcludeBlock,
  readExclude,
  type GitRunner,
} from "./git-exclude.js";
