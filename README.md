# quota-service

A local-first, read-only usage and quota tracker for Codex, Claude Code, and optional Warp usage. It provides a command-line report, a local web dashboard, and an MCP server for agents that need current quota context.

Use it alongside [AI Usage Observatory](https://github.com/anobjectn/ai-usage-observatory) when you want local provider-quota and usage signals available to your broader AI-usage workflow.

![Quota Service dashboard](docs/images/dashboard.png)

## What it provides

- Live quota collection for Codex and Anthropic; optional manual Warp credit tracking.
- A localhost dashboard and JSON endpoints.
- A CLI for usage, reset windows, cost estimates, and model recommendations.
- An MCP server exposing usage, reset, estimation, and recommendation tools.
- A local SQLite history of collected snapshots.

All provider collection is read-only. The service does not consume credits, purchase anything, or write to provider systems.

## Requirements

- macOS: collectors use the macOS Keychain and Warp preferences.
- [Bun](https://bun.sh/).
- Existing local sign-in for the providers you enable.

## Quick start

```bash
git clone https://github.com/anobjectn/quota-service.git
cd quota-service
bun install
cp .env.example .env

# Print the current usage report.
bun run quota

# Start the dashboard at http://127.0.0.1:8787/.
bun run serve
```

The default providers are `codex,anthropic`. To include Warp, edit `.env`:

```dotenv
QUOTA_PROVIDERS=codex,anthropic,warp
QUOTA_PORT=8787
```

## Common commands

```bash
# Machine-readable quota report and reset windows.
bun run quota json
bun run quota resets json

# Estimate a task and recommend a provider/model based on current headroom.
bun run quota estimate feature
bun run quota recommend large_refactor

# Start the MCP server over stdio.
bun run mcp

# Run checks.
bun run typecheck
bun test
```

## Local data and credentials

The repository ignores `.env`, `data/`, and SQLite database files. Collected snapshots are stored locally in `~/.quota-service/quota.db` by default. Provider credentials are read from existing local Codex and macOS Keychain sources and are not persisted by this service.

For detailed collector behavior, MCP setup, API routes, and launchd guidance, see [HOW-TO-USE.md](HOW-TO-USE.md).
