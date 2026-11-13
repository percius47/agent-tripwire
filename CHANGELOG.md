# Changelog

## 0.2.1

- Fix: a shell command that names a decoy by relative path (for example `cat .env.local.old`) is now logged in the agent's own project, not another guarded project with the same decoy name
- Fix: Claude Code tamper attempts are logged as `deny`, matching what Claude was told (was `ask`)
- Docs: README rewrite with real screenshots, CONTRIBUTING.md and SECURITY.md
- Docs: clearer wording for how `pause` works
- Fix: `--version` now reports 0.2.1

## 0.2.0

**Agent Tripwire V1 — per-project guard**

- `init` writes project-level `.cursor/hooks.json` + `.claude/settings.json` (merge, mark, backup), `.gitignore` block, and `.tripwire/`
- New bin `agent-tripwire-hook`: local stdin JSON policy for Cursor (`beforeReadFile`, `beforeShellExecution`, `beforeMCPExecution`) and Claude Code (`PreToolUse`)
- Rules: decoy deny, real-secret alert/allow (optional block), exfil ask/deny; allowlist; redacted incidents log
- `incidents` CLI; native OS notify via `node-notifier` (mocked in tests)
- `remove` restores hooks byte-exact when possible and deletes Tripwire-created empties
- Docs: README quickstart + `docs/roadmap/v2-desktop-guard.md`
- CI: add `macos-latest` to the Node 20/22 matrix

## 0.1.0

First release of **agent-tripwire**: plant non-functional decoy credentials and alert when a coding agent reads them.

### Commands

- `init` / `init --home` — plant project (and optional home) decoys; never overwrite existing files
- `watch` — foreground log watcher with desktop notifications
- `scan` / `scan --new-only` — one-shot pass; exit 1 while decoys remain in logs (dedupe covers append + notify only)
- `status` — decoys, adapters, recent hits (no full tokens)
- `test-alert` — sample notification + stdout
- `remove` / `remove --dry-run` / `remove --home` — hash-matched cleanup

### Adapters

- Claude Code (`~/.claude/projects/*/*.jsonl`) — record shape confirmed on a real Windows machine on Oct 31 2026 (live e2e pending); token-in-tool_result plus path-based tool_use matching
- Codex CLI (`~/.codex/sessions/**/rollout-*.jsonl`) — **UNVERIFIED** on a real machine
- Cursor IDE (`~/.cursor/projects/*/agent-transcripts/*/*.jsonl`) — path-based detection (Cursor does not log file contents)
- Config globs via `~/.agent-tripwire/config.json`

### Safety

- Real `.env`, `~/.aws/credentials`, and `~/.npmrc` are never opened for writing
- Git ignore via `.git/info/exclude` marked block (not `.gitignore`)
- No network calls; state stays under `~/.agent-tripwire/`
