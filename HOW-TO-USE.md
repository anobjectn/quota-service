# quota-service — HOW TO USE

Personal, local-first usage/quota tracker for Codex (ChatGPT Plus), Anthropic
(Claude Code Pro), and Warp. Phases 1–3 of Plan B are built: SQLite store,
collectors for all three providers, `quota` CLI, a small HTTP server, and a
stdio MCP server registered in both Codex and Claude Code.

Everything here is **read-only** against provider systems: no collector ever
calls a consume/purchase/POST endpoint. Every provider result carries an
explicit `ok` / `stale` / `unavailable` status and a data-age, so you always
know whether what you're looking at is current.

## Requirements

- Bun (installed via Homebrew at `/opt/homebrew/bin/bun`, v1.3.14+).
- macOS (collectors use `security` for the Keychain and `defaults` for Warp's
  preferences — this will not run as-is on other OSes).
- Dependencies are already installed (`bun install` if you ever need to
  redo it — `node_modules/` is gitignored).

## Quick start

```bash
cd /Users/luis/htdocs/quota-service

# one-shot, no server needed (this is what most people will do day to day)
bin/quota            # human table, all three providers
bin/quota json        # same data, machine-readable
bin/quota resets       # natural reset countdowns + Codex banked reset credits
bin/quota resets json
```

Sample real output (captured while building this):

```
$ bin/quota
quota — generated 2026-07-12T23:36:19.977Z

Codex      [OK]          age: 7s ago  source: codex_api
  5h window:     not currently tracked
  weekly window: 1.0%  resets in 6d 23h
  plan: plus
  banked reset credits available: 1

Anthropic  [OK]          age: 7s ago  source: anthropic_api
  5h window:     85.0%  resets in 4h 13m
  weekly window: 11.0%  resets in 2d 8h

Warp       [OK]          age: 4m ago  source: warp_plist
  pool: 1500/1500 (100.0%)  refreshes in 21d 1h [Monthly]
```

Notes on what you're seeing:
- Codex's "5h window: not currently tracked" is normal right after that
  window fully resets — the live `wham/usage` endpoint only returns a window
  object once there's been a request in it since the reset. It'll show up
  again after your next Codex turn. The weekly window and banked reset credit
  are unaffected.
- Warp has **no 5h/weekly windows at all** — it's a monthly credit pool, shown
  as `used/limit (%)` plus a refresh countdown, not a percent-of-window.

## Running the server (optional, for continuous polling)

```bash
bun run serve                 # binds 127.0.0.1:8787, polls every 5 min by default
bun run serve --port 9000      # different port
bun run serve --poll-ms 60000   # poll more/less often (per-provider floors still enforced)
bun run serve --host <tailnet-ip-or-hostname>   # expose beyond localhost, e.g. on your tailnet
```

Routes: `GET /usage`, `GET /resets`, `GET /status`.

`bin/quota` / `bin/quota json` try the server first (`http://127.0.0.1:8787/usage`)
and fall back to a direct one-shot collection if it's not running — so the
CLI works identically whether or not `bun run serve` is up. This is the
"on-demand + foreground, poll-while-running" mode called for right now;
nothing is installed as a background service yet (see Launchd section).

## Data

SQLite file at `~/.quota-service/quota.db` (created on first run; override
with `QUOTA_DB_PATH`). Append-only snapshot history per provider — the CLI/
server always read the latest row. Nothing provider-side is ever written back;
this file only accumulates what the collectors observed.

## What each collector does and where it gets data

| Provider | Tactic | Source | Auth |
|---|---|---|---|
| Codex | live GET `chatgpt.com/backend-api/wham/usage`, degrades to tailing the newest `~/.codex/sessions/**/*.jsonl` `rate_limits` snapshot on any failure (network error, non-200, malformed body) | in-memory only | `~/.codex/auth.json` bearer token, read-only, never persisted |
| Codex reset credits | GET `.../wham/rate-limit-reset-credits` — **report only**, this service never calls the `/consume` endpoint | same as above | same as above |
| Anthropic | GET `api.anthropic.com/api/oauth/usage` with required `anthropic-beta: oauth-2025-04-20` and `User-Agent: claude-code/<version>` headers | in-memory only | macOS Keychain item **"Claude Code-credentials"**, re-read fresh every poll via `security find-generic-password`, never persisted |
| Warp | `defaults read dev.warp.Warp-Stable AIRequestLimitInfo` (Warp stores this key as a JSON string, so it parses directly) | plist mtime as data-age signal | none — no credentials involved |

### Codex freshness upgrade, concretely

The live `wham/usage` response shape turned out to differ from what Phase 0's
research anchored on (that doc's `rate_limits.{primary,secondary}` was from
an older RPC/community capture). The live shape is
`rate_limit.{primary_window,secondary_window}`, and this account's live
response only populates one window at a time — so the collector classifies
whichever window(s) are present by duration (`limit_window_seconds` — ≤6h is
the 5h window, ≥3d is the weekly window) rather than trusting field position
or names. This is more robust to the account-state variation observed live.

### Anthropic gotchas honored

- Poll floor: the collector will not re-hit the network more than once per
  180s (`ANTHROPIC_POLL_FLOOR_MS` in `src/collectors/anthropic.ts`); a rapid
  repeat `quota` call within that window serves the last cached row from
  SQLite instead.
- `401` is treated as **stale credentials**, not an error to recover from —
  the service never attempts a token refresh (a wrong write-back to the
  Keychain could log you out of Claude Code). It self-heals the next time you
  use Claude Code normally and the token rotates.
- If the Keychain item ever holds only MCP OAuth state (a known variant on
  some Claude Code installs) instead of `claudeAiOauth`, the collector
  reports it as an `unavailable` config error rather than crashing.

### Warp: manual entry for add-on credits

Warp's `AIRequestLimitInfo` plist key has no field for purchased add-on
credits (Phase 0 confirmed this — neither the plist nor the GraphQL API
expose it). Record your add-on balance manually after checking
`warp://settings/billing`:

```bash
bin/quota manual set warp addon_credits 500 "purchased 2026-07-12"
```

Manual entries show up under the provider's block in `quota` output and in
the JSON report (`providers[].manualEntries`), each stamped with when you set
it. There's no manual-entry mechanism for Codex or Anthropic — both have
complete programmatic collectors.

### Stale / unavailable badges

- `[OK]` — data came from a successful collector run just now (network calls)
  or a recent local read (Codex file tactic, Warp plist).
- `[STALE]` — the collector ran but the result shouldn't be trusted at face
  value: Anthropic 401 (credentials need Claude Code to be used again), or
  Warp's plist not updated in over an hour (Warp probably isn't running, so
  the pool value may be frozen at its last-known state).
- `[UNAVAILABLE]` — the collector couldn't produce a snapshot at all (e.g. no
  rollout files yet, keychain access denied, Warp preference key missing).
  The `note:` line under the provider always says why.
- `age:` is always the age of the underlying data, not of the collector call
  — for live API tactics those are the same; for Codex's file fallback and
  Warp's plist, age reflects when that data was actually produced.

## MCP server (Phase 3)

`src/mcp.ts` is a stdio MCP server exposing:

- `get_usage` — same data as `quota json`, refreshed on call (best-effort,
  respecting poll floors).
- `get_resets` — natural 5h/weekly/pool reset times plus Codex's banked reset
  credits (`available_count`, `total_earned_count`, each credit's status and
  expiry). Report-only, as above.
- `estimate_cost`, `recommend_model` — Phase 4 stubs. Both return
  `{ implemented: false, message: "... not implemented until Plan B Phase 4 ..." }`
  so callers can wire up the interface now without erroring.

### Registration

Registered in both harness configs with minimal, surgical edits (both use the
same invocation: `bun run /Users/luis/htdocs/quota-service/src/mcp.ts`).

**`~/.claude.json`** (top-level `mcpServers`, applies to Claude Code
everywhere — added the `quota-service` entry, left `figma-dev-mode-mcp-server`
untouched):

```diff
   "mcpServers": {
     "figma-dev-mode-mcp-server": {
       "type": "sse",
       "url": "http://127.0.0.1:3845/sse"
-    }
+    },
+    "quota-service": {
+      "command": "bun",
+      "args": ["run", "/Users/luis/htdocs/quota-service/src/mcp.ts"]
+    }
   },
```

**`~/.codex/config.toml`** (added a new `[mcp_servers.quota-service]` table
right after the existing `playwright` entry, nothing else touched):

```diff
 [mcp_servers.playwright]
 command = "npx"
 args = ["@playwright/mcp@latest"]

+[mcp_servers.quota-service]
+command = "bun"
+args = ["run", "/Users/luis/htdocs/quota-service/src/mcp.ts"]
+
 [mcp_servers.figma-console]
 command = "/Users/luis/.codex/bin/figma-console-mcp.sh"
 enabled = false
```

### How an agent in each harness queries it

- **Codex** (CLI or app): once you start a new Codex session, `quota-service`
  is available like any other MCP server — call the `get_usage` / `get_resets`
  tools directly.
- **Claude Code**: same, via the top-level `~/.claude.json` registration —
  available in any project's session, no per-project `.mcp.json` needed.
- **T3 Code**: T3C runs the real `codex`/`claude` binaries against these same
  home directories (`~/.codex`, `~/.claude.json`), so it **inherits both
  registrations automatically** — a T3C thread running either backend gets
  `quota-service` for free, no separate T3C-specific config.
- **Warp**: Warp isn't an MCP host for this service (it's a *tracked provider*,
  not a client here) — query quota data from Warp's own agent via the CLI
  (`bin/quota`) if you want it in a Warp session, since Warp doesn't consume
  this MCP server directly today.

### Verifying it yourself

Claude Code/Codex/T3C sessions can't be observed from outside, so the gate for
this phase was a scripted JSON-RPC test driving the MCP server directly over
stdio. Full transcript (abbreviated where responses are large) is in the
build report; the short version: `initialize` → `tools/list` (returns all 4
tools) → `tools/call get_usage` (returned real current Codex/Anthropic/Warp
data) → `tools/call get_resets` (returned real reset countdowns + the real
banked Codex reset credit) → both stubs called cleanly. If you want to
re-verify by hand from a shell:

```bash
cd /Users/luis/htdocs/quota-service
bun run src/mcp.ts
# then paste newline-delimited JSON-RPC requests to stdin, e.g.:
# {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}
# {"jsonrpc":"2.0","method":"notifications/initialized"}
# {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_usage","arguments":{}}}
```

**Manual verification still needed from Luis:** confirm `get_usage` actually
surfaces inside a live Codex session, a live Claude Code session, and a T3
Code thread of each — this cannot be exercised from inside this build
session.

## Launchd (written, NOT loaded)

`launchd/com.luis.quota-service.plist` runs `bun run src/server.ts` at load
and keeps it alive, polling every 5 minutes on port 8787. **It is not loaded.**
The Anthropic collector's first Keychain read from a new binary triggers a
one-time interactive "always allow" prompt — launchd runs headless and can't
answer that prompt, so it would silently fail. Install it only after you've
run `bun run serve` in the foreground at least once and confirmed the
Keychain prompt (if any appears) was granted:

```bash
# 1. Run foreground first, confirm Anthropic isn't stuck on a keychain denial:
cd /Users/luis/htdocs/quota-service
bun run serve
# Ctrl-C once you've seen a clean /usage response for anthropic.

# 2. Install:
cp launchd/com.luis.quota-service.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.luis.quota-service.plist

# Check it's up:
curl http://127.0.0.1:8787/status

# Stop / uninstall:
launchctl unload ~/Library/LaunchAgents/com.luis.quota-service.plist
rm ~/Library/LaunchAgents/com.luis.quota-service.plist
```

Logs land at `~/.quota-service/quota-service.{out,err}.log`.

## Known-unverified / left degraded

- **Codex 5h window can show "not currently tracked" right after a reset** —
  observed live, not a bug: the live endpoint only returns a window object
  once the window has activity. Documented above; self-heals on next Codex
  use.
- **Warp plist semantics** — Phase 0 flagged the requests-vs-credits
  accounting as unverified; this build didn't cross-check against
  `warp://settings/billing` (out of scope for a build session — genuinely
  needs Luis's eyes on the billing UI once). If it ever looks wrong, that's
  the first place to check.
- **MCP tool inheritance in T3 Code** is asserted from the plan's own
  architecture notes (T3C runs the real binaries against the real home dirs)
  but not observed directly in this session — see manual verification note
  above.
- Nothing was left in a stale/unavailable state due to being blocked — all
  three collectors are live and returning `[OK]` as of this writing.
