# agent-tripwire

Plant non-functional decoy credentials and get alerted when a coding agent reads them.

## Why

Coding agents can read files in repos and home directories, including secrets. Tripwire plants realistic-looking sibling files with unique, non-authenticating tokens, then watches agent session logs. If a token shows up, you get a desktop notification and a local hit record. **It detects; it does not block.**

## 60-second quickstart

Not yet published to npm. Don't install `agent-tripwire` from the registry until this README says so.

```bash
# install from source (pick one) — do not use npx/npm from the public registry
git clone https://github.com/percius47/agent-tripwire.git
cd agent-tripwire && npm ci && npm run build && npm link

# or from a local pack
npm pack && npm i -g ./agent-tripwire-0.1.0.tgz

# or from GitHub (needs repo access while the repo is private)
npm i -g github:percius47/agent-tripwire

# in a git repo
cd your-project
agent-tripwire init          # project decoys only
# agent-tripwire init --home # also ~/.aws/credentials.bak and ~/.npmrc.bak

agent-tripwire watch         # foreground; Ctrl+C to stop
agent-tripwire scan          # one-shot; exit 1 on a hit
agent-tripwire test-alert    # sample notification + stdout line
agent-tripwire status        # decoys, adapters, recent hits (no full tokens)
agent-tripwire remove        # delete hash-matched decoys; strip exclude block
# agent-tripwire remove --home
# agent-tripwire remove --dry-run
```

Requires Node.js 20+.

## What gets created

**Project (after `init`):**

| Path | Notes |
|------|--------|
| `.env.backup` | Sibling of `.env` — never writes `.env` |
| `.env.local.old` | Sibling only |
| `config/secrets.legacy.json` | Creates `config/` if needed |

**Home (only with `init --home`):**

| Path | Notes |
|------|--------|
| `~/.aws/credentials.bak` | Never writes `~/.aws/credentials` |
| `~/.npmrc.bak` | Never writes `~/.npmrc` |

**State (always under `~/.agent-tripwire/`, or `$AGENT_TRIPWIRE_HOME/.agent-tripwire/` in tests):**

| File | Purpose |
|------|---------|
| `manifest.json` | Paths, sha256, token ids, times |
| `offsets.json` | Byte offsets for log tails |
| `hits.jsonl` | Hit records with redacted snippets |
| `config.json` | Optional extra adapters |

Real credential files (`.env`, `~/.aws/credentials`, `~/.npmrc`) are never opened for writing. New decoys use `fs.open(..., 'wx')`; if a path already exists, it is skipped and reported.

## Git safety

Ignore lines go into **`.git/info/exclude`** (local only — not committed, does not touch `.gitignore`), inside a marked block:

```
# >>> agent-tripwire
...
# <<< agent-tripwire
```

After planting, Tripwire runs `git check-ignore` on each decoy and rolls back if anything is not ignored. `init` refuses paths that are already tracked. `remove` deletes only files whose sha256 still matches the manifest, then strips that exclude block.

## Adapters and log paths

| Adapter | Default glob | Status |
|---------|--------------|--------|
| Claude Code | `~/.claude/projects/*/*.jsonl` | Record shape confirmed on a real Windows machine on Oct 31 2026 (live end-to-end on that machine still pending). Content-based (token in `tool_result`) plus path-based tool_use matching |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | **UNVERIFIED** on a real machine (Codex not installed on the confirmation host). Content-based |
| Cursor IDE | `~/.cursor/projects/*/agent-transcripts/*/*.jsonl` | Transcript shape confirmed on a real Windows 11 machine (read-only field check). **Path-based only** for reads — Cursor logs `tool_use` paths but not file contents, so hits are `read-attempt` / `write-attempt` / `shell-mention` (plus a raw-line token scan if the agent echoed a decoy token in text) |
| Config | globs from `config.json` | Supported |

Parsers are tolerant: if a line does not match the expected tool-result shape, the raw text is still scanned and tagged `seen` instead of `read`. Cursor has no tool_result payloads, so a Cursor Read of a decoy is a `read-attempt` (attempt to read), not a proven content `read`.

## `config.json` format

Optional file at `~/.agent-tripwire/config.json`:

```json
{
  "adapters": [
    {
      "glob": "~/.aider/**/*.log",
      "name": "aider",
      "format": "text"
    },
    {
      "glob": "/absolute/path/to/sessions/*.jsonl",
      "name": "custom",
      "format": "jsonl"
    }
  ]
}
```

- `glob` (required): absolute path, or relative / `~/…` under home
- `name` (optional): label in alerts
- `format` (optional): `"text"` (default) or `"jsonl"`

Missing `config.json` means built-in adapters only.

## Exit codes

| Command | `0` | `1` |
|---------|-----|-----|
| `init` | planted / skipped OK | rolled back or refused tracked paths |
| `remove` | always (idempotent) | — |
| `scan` | no decoy tokens in scanned logs | one or more decoy tokens still present in logs |
| `scan --new-only` | no brand-new hits | one or more hits not yet in `hits.jsonl` |
| `watch` | clean stop (SIGINT/SIGTERM) | fatal startup / unrecoverable error |
| `status` | report printed | fatal error loading state |
| `test-alert` | sample stdout (+ notify attempted) | notify threw synchronously |

`scan` exits `1` while the logs still contain a decoy, even if that hit is already in `hits.jsonl`. Deduping only skips a second `hits.jsonl` append and a second notification. Use `--new-only` for the legacy “new hits only” exit behavior.

## Privacy

No network calls: no telemetry, no update check. State stays on disk under `~/.agent-tripwire/`. Hit snippets are capped and redacted; status and alerts show a short token label (`tw…` + last four), not the full value. Tests stub `net` / `http` / `https` / `fetch` to throw.

## Limitations (UNVERIFIED)

- **Claude Code** JSONL record shape was confirmed on a real Windows machine on Oct 31 2026 (read-only check). Live end-to-end tripwire detection on that machine is still pending. **Codex** remains **UNVERIFIED** (not installed on that host). Path or record-shape drift may reduce attribution quality (hits can still fire via raw-line fallback as `seen`).
- **Cursor IDE** agent transcripts (JSONL under `~/.cursor/projects/…/agent-transcripts/`) are supported via path-based matching. Cursor does not log file contents, so a hit means a read/write/shell *attempt* against a decoy path, not proof the token was loaded into context. Relative tool paths in Cursor logs are **UNVERIFIED**; if present they match by basename / project-relative suffix only. Older Cursor chat SQLite storage is not used.
- The aws/npm “ignore `.bak`” integration tests skip when those binaries are absent.
- Desktop notifications depend on `node-notifier` and the host OS; `test-alert --no-notify` exercises stdout only.
- Foreground `watch` only — no systemd/launchd/Scheduled Task installer in v0.1.0.

## Uninstall

```bash
# from each project where you ran init
agent-tripwire remove
# if you used init --home
agent-tripwire remove --home

# leftover state (only if nothing else remains / you want a full wipe)
rm -rf ~/.agent-tripwire
```

`remove` leaves any decoy whose contents changed since planting (hash mismatch) and reports it. Use `--dry-run` to preview.

## License

MIT © 2026 Prashant Singh Chauhan
