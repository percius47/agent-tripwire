# Contributing

Thanks for helping make coding agents safer.

## Setup

```bash
git clone https://github.com/percius47/agent-tripwire.git
cd agent-tripwire
npm ci
npm run build
npx vitest run
```

Node.js 20+ is required. CI runs on Ubuntu, Windows and macOS with Node 20 and 22.

## Pull requests

- Keep changes small and focused, with a test for any behavior change.
- Never commit real secrets. Use the decoy generator in tests.
- `npx tsc --noEmit` and `npx vitest run` should pass before you open the PR.

## Reporting bypasses

If you found a way for an agent to read a decoy or secret without Tripwire noticing, please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
