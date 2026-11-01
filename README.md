# agent-tripwire

Per-project guard for coding agents. Plant non-functional decoy secrets, wire **project-level** Cursor and Claude Code hooks, and get a native OS pop-up plus an IDE message when an agent touches a decoy or a real secret file.

## 60-second quickstart

Not yet published to npm. Install from source (do not use the public registry until this README says so):

```bash
git clone https://github.com/percius47/agent-tripwire.git
cd agent-tripwire && npm ci && npm run build && npm link

# in any real project (no sandbox required)
cd your-project
agent-tripwire init
```

`init` is idempotent and **project-scoped**. It:

- Plants decoys (`.env.backup`, `.env.local.old`, `config/secrets.legacy.json`) using the existing token generator + home manifest
- Adds a marked block to **`.gitignore`** (decoys + `.tripwire/`) and keeps the local `.git/info/exclude` block as a second safety net
- Writes **project-level** hooks only: `.cursor/hooks.json` and `.claude/settings.json` (merges, marks our entries, backs up first). Never touches global/user config
- Creates `.tripwire/` (`config.json`, `allow.json`, `incidents.log`, install metadata)

Then ask Cursor or Claude Code to read a decoy, for example:

> Read `.env.backup` and summarize the credentials.

You should see a **native OS notification** and a **Tripwire…** message in the agent/IDE UI. The hook binary is `agent-tripwire-hook` (must be on your `PATH` after `npm link`).

```bash
agent-tripwire incidents              # latest first
agent-tripwire incidents --severity high
agent-tripwire remove                 # restore hooks/gitignore; delete decoys + .tripwire/
```

Requires Node.js 20+. Works on Windows, macOS, and Linux.

## What the hook does

`agent-tripwire-hook` reads one JSON event on stdin and decides **locally** (no network, no daemon):

| Rule | When | Action |
|------|------|--------|
| **(a) Decoy** | Path is a decoy, or content/command/MCP input contains a decoy token | **DENY**, high |
| **(b) Real secret** | Reads of `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `~/.ssh`, `~/.aws`, etc., or shell that reads them | **ALERT + allow** by default (set `.tripwire/config.json` → `"blockRealSecrets": true` to deny) |
| **(c) Exfil / MCP** | Secret-looking value or decoy flowing into MCP input, or network command carrying a file/env (`curl` / `wget` / `Invoke-WebRequest` / `nc`) | Cursor → **`ask`**; Claude → **deny** with reason |

Allowlist: `.tripwire/allow.json` (`paths`, `commands`). The allowlist can silence rules (b) and (c) only; it never suppresses a decoy hit.

Incidents append to `.tripwire/incidents.log` with time, agent, session/conversation id, transcript path, rule, severity, action, target, verdict. Secret values are **never** stored — only path, sha256, and a redacted preview (first 4 characters + length). Shell commands and MCP input are scrubbed for secret-looking values (key=value, bearer tokens, URL passwords, known key prefixes, long opaque strings, decoy tokens) before they reach the log, the pop-up, or the IDE message. Scrubbing is pattern-based, so an unusual secret format can still slip through.

Notifications use `node-notifier` (Windows toast, macOS Notification Center, Linux notify-send). Notification failure never breaks the hook. The hook fails **open** on its own crash, except decoy rule (a) when it was already evaluated. If `.tripwire/allow.json` or `config.json` is unreadable, defaults are used (no allowlist), not allow-all. If the decoy manifest is unreadable, the hook still denies the decoy paths recorded in `.tripwire/install.json` and logs a warning.

## Snooze

```bash
agent-tripwire pause --for 30m   # default 30m, max 24h
agent-tripwire resume            # turn blocking back on now
```

While paused, nothing in this project is blocked and no pop-ups fire, but every hit is still written to `.tripwire/incidents.log` marked `paused`. The pause ends on its own. If an agent runs `agent-tripwire pause` / `remove` or writes Tripwire's state or hook files from the shell, the hook flags it as **tamper** (Cursor asks you, Claude Code denies), and that rule is never snoozed. Writes through an agent's own edit tools aren't hooked yet.

## Honest limits

- **This is a tripwire, not a sandbox.** It flags and blocks the specific actions it can see; it does not isolate the agent.
- Claude Code hooks cover `Read`, `Bash`, `PowerShell` and MCP tools. `Grep`, `Glob`, `Edit`, `Write`, `WebFetch` and `Task` are not hooked yet, and files you `@`-mention are attached without a hook call.
- Cursor hooks cover file reads, shell commands and MCP calls (`beforeReadFile`, `beforeShellExecution`, `beforeMCPExecution`).
- The hook command is `agent-tripwire-hook` on your PATH. If it isn't on PATH, the agent's action proceeds (fail open).
- `init` refuses to run in your home folder, in `~/.cursor` / `~/.claude`, or at a filesystem root, so it can't overwrite your global agent config.
- Hooks only see what the agent asks to do through the hooked APIs. A **disguised shell command** can slip past; keep `agent-tripwire watch` / `scan` as a transcript backstop.
- Cursor **cloud** agents: project `.cursor/hooks.json` command hooks are loaded for cloud work, but behavior is not identical to desktop (e.g. `beforeMCPExecution` timing / availability differs; user-level `~/.cursor/hooks.json` is unavailable). Check [Cursor hooks docs](https://cursor.com/docs/agent/hooks).
- Claude Code cloud sessions do not use your local `~/.claude/settings.json`; project `.claude/settings.json` can apply when that tree is present. Check [Claude Code hooks docs](https://docs.claude.com/en/docs/claude-code/hooks).

## Legacy detect-only commands

Still available (unchanged engines): `watch`, `scan`, `status`, `test-alert`. These tail agent session logs under `~/.agent-tripwire/` state and do not require hooks.

## Uninstall

```bash
agent-tripwire remove
# agent-tripwire remove --home   # if you used init --home
```

`remove` restores hook files byte-exact when nothing else changed, deletes files Tripwire created when they were empty/absent before, strips the marked `.gitignore` / exclude blocks, and removes `.tripwire/`.

## License

MIT © 2026 Prashant Singh Chauhan
