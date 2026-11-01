# Changelog

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
