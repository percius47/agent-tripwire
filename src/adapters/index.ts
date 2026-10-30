import { loadConfig } from "../config.js";
import { getHomeDir } from "../paths.js";
import { createClaudeCodeAdapter } from "./claude-code.js";
import { createConfigAdapter } from "./config-adapter.js";
import type { LogAdapter } from "./types.js";

export type { LogAdapter, ParsedLine } from "./types.js";
export {
  createClaudeCodeAdapter,
  parseClaudeCodeLine,
  claudeCodeGlob,
} from "./claude-code.js";
export { createConfigAdapter } from "./config-adapter.js";

/** Built-in + config.json adapters for the current HOME. */
export async function loadAdapters(
  home: string = getHomeDir(),
): Promise<LogAdapter[]> {
  const adapters: LogAdapter[] = [createClaudeCodeAdapter(home)];
  const config = await loadConfig();
  config.adapters.forEach((entry, i) => {
    adapters.push(createConfigAdapter(entry, i, home));
  });
  return adapters;
}
