# Agent Tripwire V2 — Desktop Guard (parked)

V1 is the **per-project guard**: `init` plants decoys and project-level Cursor / Claude Code hooks; `agent-tripwire-hook` decides locally on each tool call; native OS toasts + IDE messages + `.tripwire/incidents.log`.

V2 is intentionally **parked**. It does not ship in this release. This document is the owner-approved outline so V1 stays focused.

## Always-on desktop service

- Background service started at login (launchd / systemd user unit / Windows Scheduled Task or startup folder).
- Watches for agent activity beyond a single repo checkout.
- Localhost dashboard with:
  - Incident timeline
  - Root-cause summary
  - Transcript evidence links
  - Suspend / resume controls

## MCP and skill governance

- One-click **suspend per MCP server** via deny hooks (project + optional user-scoped, still never silent global clobber).
- New skill or MCP **install watcher** with a probation period (alert-heavy, block-light until trusted).
- Skill attribution inferred from transcripts and **labeled as inferred** (never presented as proven).
- Confidence-based policy: **block high**, **alert medium**, **log low**.
- Tamper alerts when hook files, `.tripwire/`, or decoys are modified outside Tripwire.

## Later hardening

- OS-level process and network monitoring (egress of secret-looking payloads).
- Admin-protected hook paths (harder for an agent to rewrite its own guardrails).
- Tauri tray app for status, mute, and quick suspend.

## Relationship to V1

V1 remains the on-by-default path for any real project: hooks only see what the agent asks to do; disguised shell can slip past; transcript `watch` / `scan` stay as a backstop. V2 adds the always-on layer and richer UI without replacing the local hook decision loop.
