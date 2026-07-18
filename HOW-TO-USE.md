# quota-service — HOW TO USE

Personal, local-first usage/quota tracker for Codex (ChatGPT Plus), Anthropic
(Claude Code Pro), and Warp. Phases 1–5 of Plan B are built: SQLite store,
collectors for all three providers, `quota` CLI, a small HTTP server, a stdio
MCP server registered in both Codex and Claude Code, task-profile cost
estimation + model recommendation, and a web dashboard. Phase 6 (agent status
feed) is stretch and not built — see "Status feed (Phase 6, not built)" below.

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

# web dashboard (recommended — starts server + opens at http://127.0.0.1:8787/)
bin/serve                        # default port 8787, localhost only
bin/serve --port 9000            # different port
bin/serve --host <tailnet-ip>    # expose on your tailnet

# one-shot CLI, no server needed (this is what most people will do day to day)
bin/quota            # human table, all three providers
bin/quota json        # same data, machine-readable
bin/quota resets       # natural reset countdowns + Codex banked reset credits
bin/quota resets json
bin/quota estimate feature       # token-range estimate for a task profile
bin/quota estimate feature json
bin/quota recommend large_refactor    # ranked model/provider suggestion given live headroom
bin/quota recommend large_refactor json
```

Task profiles: `small_fix`, `feature`, `large_refactor`, `research` (defaults
to `feature` if omitted or unrecognized). These map onto the
`plan-review-execute` skill's `model-rubric.md` tiering (light/mid/frontier)
so both tools speak the same vocabulary.

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

## Running the server / web dashboard

```bash
bin/serve                                       # dashboard at http://127.0.0.1:8787/
bin/serve --port 9000                           # different port
bin/serve --poll-ms 60000                       # poll more/less often (per-provider floors still enforced)
bin/serve --host <tailnet-ip-or-hostname>       # expose beyond localhost, e.g. on your tailnet

# equivalent long-form (same flags, same binary):
bun run serve
```

Routes: `GET /usage`, `GET /runs`, `GET /resets`, `GET /status`, `GET /estimate[?taskProfile=...]`,
`GET /recommend[?taskProfile=...]`, `POST /manual` (body:
`{provider, field, value, note?}`), and the dashboard itself at `GET /`
(static files served from `public/`).

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

### Per-model weekly windows and usage credits (plan-dependent)

The `oauth/usage` response carries a generic `limits[]` array alongside the
`five_hour`/`seven_day` fields. Anthropic uses this array for **per-model**
weekly windows — currently a temporary "Fable" bucket (Claude Fable 5 /
Opus 4.8's shared 7-day window, separate from the "all models" weekly
window, both resetting Wed 4:00am) — and this service parses it generically
rather than hardcoding a "Fable" field: any `limits[]` entry with a
`scope.model.display_name` becomes a `snapshot.modelWindows[<name>]` entry
(`{ usedPercent, resetsAt }`). **This is plan-dependent and vanishes
gracefully**: when a per-model bucket disappears from the API response (e.g.
the temporary Fable window's ~1-week expiry), `modelWindows` for that key
just stops appearing — no schema change, no crash, and the CLI/dashboard
simply stop rendering that row.

Usage credits are similarly first-class: `snapshot.usageCredits` is
`{ enabled, spentAmount, limitAmount, currency, resetsAt }` in major currency
units (already converted from the API's minor-unit `amount_minor` +
`exponent`). The collector prefers the newer `spend` block and falls back to
the legacy `extra_usage` block if `spend` is absent. This is a manual-style
**fallback balance**, exactly like Warp's add-on credits — `recommend_model`
surfaces it as a flagged note (`usageCreditsNote`) when enabled with a
remaining balance, but never factors it into automated ranking or spending.

`recommend_model`'s binding-constraint logic treats Anthropic's frontier tier
(Fable 5) specially: the binding bucket is whichever of 5h / all-models
weekly / any present per-model window has the least headroom, and the
`reason` string names it (e.g. `"...on its Fable weekly window"` or
`"...on its 5h window"`). A fresh per-model bucket can make the frontier tier
cheaper to recommend even when the all-models weekly window is tight.

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

### Reliability: collect-on-query, the stale-status rule, and the Jul 13 wedge

**What happened (root cause):** the launchd service stayed up (`RunAtLoad` +
`KeepAlive` kept the process alive under launchd's eyes) but its SQLite WAL
stopped advancing after the Mac slept overnight. The old poll loop was
`while (true) { await collectAll(db); await Bun.sleep(pollMs) }`, and none of
the three collectors' `fetch()` calls (Anthropic `oauth/usage`, Codex
`wham/usage`, Codex `rate-limit-reset-credits`) had a request timeout. Bun's
`fetch()` can stall indefinitely on a socket left half-open across a sleep/
wake cycle instead of erroring, so the `await collectAll(db)` in that loop
never returned, `Bun.sleep` never ran, and no further snapshots were ever
written — while the process itself looked perfectly healthy to launchd. Every
subsequent `GET /usage` kept serving the last-known row with status `"ok"`,
because nothing checked the row's age against how it was collected.

**The fix has three parts, all independent of nailing down 100% certainty on
the root cause above:**

1. **Fetch timeouts.** Every collector network call now passes
   `signal: AbortSignal.timeout(10_000)`, so a stalled socket fails fast
   instead of hanging forever.
2. **Self-rescheduling poll loop with a watchdog.** `src/server.ts`'s poll
   loop is a `setTimeout`-based cycle that only schedules its *next* run once
   the current one has settled (success or failure), wrapped in
   `Promise.race` against a 30s watchdog timeout and a catch-all that logs
   and moves on. Even an unexpected hang somewhere outside the fetch layer
   can no longer stop the schedule.
3. **Collect-on-query.** `GET /usage`, `GET /resets`, and `GET /recommend`
   now call `collectAll(db)` before responding — which is cheap on the
   common path (each provider's `collectXAndSave` only actually re-hits the
   network once its data has aged past that provider's poll floor;
   otherwise it's a cached-row read) and self-heals staleness caused by a
   slow/wedged background loop. MCP's `get_usage`/`get_resets`/
   `recommend_model` already did this from Phase 3; the CLI gets it for free
   by talking to the server (its direct-collection fallback path already did
   this too). Collection attempts are additionally capped at 12s
   (`COLLECT_ATTEMPT_TIMEOUT_MS` in `src/collect.ts`) so a request can never
   hang waiting on a re-collect — on failure/timeout it serves the
   last-known snapshot with an honest `"re-collect failed (...); serving
   last-known data"` note rather than clobbering good history with a bare
   failure row.

**The stale-status rule.** Independent of what the last collector run
reported, a provider whose collector hasn't actually *run* in over 3x its
poll floor (`POLL_FLOORS_MS` in `src/collect.ts`: Codex 60s, Anthropic 180s,
Warp 60s) is presented as `"stale"` in `src/present.ts`, with an explanatory
note. This is keyed off **when the collector last ran** (`capturedAt`), not
the age of the underlying data (`dataAsOf`) — those two diverge for a tactic
like Warp's plist read, where `dataAsOf` tracks Warp's own last-usage
timestamp and can be legitimately old just because Warp hasn't been used
recently, even though the collector itself is running fine on every
poll/collect-on-query. Using `capturedAt` means the rule fires exactly when
it should (the poll loop stopped advancing) and doesn't false-positive on
normal inactivity. The CLI, dashboard, and MCP surfaces already render
`stale`/`unavailable` badges identically to `ok` — this rule is what makes
sure they actually get triggered by a wedge instead of a badge staying `ok`
next to a 22-hour-old timestamp, like it did on Jul 13.

## Web dashboard (Phase 5)

```bash
bun run serve                                    # dashboard at http://127.0.0.1:8787/
bun run serve --host <tailnet-ip-or-hostname>     # same flag as always, now also serves the dashboard there
```

Dark-mode "instrument panel" SPA (`public/index.html` + `styles.css` +
`app.js`, plain JS, no framework, no build step — Bun serves it as static
files off the same server as the API). It reads `GET /usage` and re-polls
every 30s client-side:

- **Provider cards**: Codex and Anthropic get two radial arc gauges (5h,
  weekly) with a reset countdown; Warp gets a linear pool bar (used/limit +
  refresh countdown) since it has no window semantics. Every card shows a
  data-freshness pill (`OK`/`STALE`/`UNAVAILABLE`), source, and data age.
  Anthropic additionally renders a linear meter row per `modelWindows` entry
  (e.g. the temporary "Fable" weekly bucket) and a usage-credits line
  (spent/limit + enabled badge + reset countdown) — both driven entirely by
  what `GET /usage` returns, so the card silently shows nothing extra when
  a provider reports none (e.g. once the Fable bucket expires).
- **Recent-run ledger**: Codex and Anthropic cards also read `GET /runs` and
  show up to the 50 newest activity bursts from the local session logs. All
  returned runs remain available in a ledger that scrolls after roughly eight
  rows; the bound only prevents an unbounded archive scan and DOM on each
  30-second dashboard refresh. A burst
  is split after 30 minutes idle, so resuming an old thread does not make it
  look like one multi-day run. Each row shows an ellipsized prompt/thread
  label, start time and duration, model, recorded reasoning effort (Claude
  Fable/Mythos is labeled `adaptive`), total/input/cache/output tokens,
  subagent status, and an estimated API-key equivalent. When a live 5-hour
  reset is available, a summary above the rows totals runs that ended inside
  the current window. Codex reads `~/.codex/sessions` and
  `~/.codex/archived_sessions`; Anthropic reads `~/.claude/projects`, including
  subagent logs. Claude streamed rows are deduplicated by message ID.

  The dollar number is explicitly an **API-equivalent estimate**, not what the
  subscription charged and not a reverse-engineering of provider quota
  weights. It applies current public list prices to the token categories in
  each log (including discounted cache reads and Claude 5-minute/1-hour cache
  writes). Provider-controlled subscription windows can weight models,
  effort, tools, and demand differently. The ledger therefore explains what
  ran and its relative size/cost, while the gauge remains the source of truth
  for quota consumed. `GET /runs?refresh=1` bypasses its 20-second filesystem
  cache for diagnostics.

  Pricing is model-aware and date-aware where list pricing has a published
  cutoff (currently Claude Sonnet 5's introductory $2/$10 per MTok through
  2026-08-31, after which new runs use its standard $3/$15 rate). Pricing
  constants live together in `src/run-history.ts` for straightforward updates.
- **Estimate & recommend panel**: click a task-profile chip
  (`small_fix`/`feature`/`large_refactor`/`research`) to get a live
  `recommend_model`-equivalent call against `GET /recommend` — shows the
  picked provider/model, the one-line reason, the token-range estimate, and
  alternates.
- **Manual entry form**: embedded directly in the Warp card (Warp is the only
  provider with a manual field — Codex and Anthropic are both API-driven).
  Same mechanism as `bin/quota manual set` (posts to `POST /manual`) — use it
  instead of the CLI to record Warp add-on credits from the dashboard.
- **Purchase/manage links**: static outbound links per provider (Codex →
  ChatGPT subscription settings, Anthropic → claude.ai billing, Warp →
  `warp://settings/billing`). Links only — nothing here ever calls a
  purchase/consume endpoint. Verify these still resolve if a provider
  reshuffles their settings UI; they were not exhaustively checked against
  every account state.
- No status feed panel is present in the markup — see "Status feed (Phase 6,
  not built)" below for the designed-but-not-built shape, to be added fresh
  whenever Phase 6 gets picked up.
- No auth beyond network-level (tailnet), matching Plan B's default. Dark mode
  is the only mode (no light theme built).

Colors: the four fixed status colors (`ok`/`stale`/`unavailable` badges, and
the usage-magnitude ring/bar tint) come from the `dataviz` skill's validated
status palette, checked against this app's dark surface. Typography: Manrope
is the primary UI face (headings, labels, chrome); IBM Plex Mono is reserved
for tabular figures (token counts, currency, gauge/percent readouts) where
fixed-width alignment helps scanning.

**Verified live** (this session): `curl` against `/`, `/styles.css`, `/app.js`
all returned 200 with real content; `/usage`, `/estimate`, `/recommend` all
returned real live data; `POST /manual` round-tripped a real write/read; a
browser preview tool loaded the page and rendered real provider cards with
correct gauge values, colors, and an overall status banner reflecting Warp's
pool being fully used. **Final visual approval is still Luis's call** — no
automated test can approve "pretty."

## Status feed (Phase 6, not built)

Explicitly stretch scope; time-boxed out after Phases 4–5 to avoid blocking
their sign-off. Designed-but-not-built shape, for whoever picks this up:

- MCP tools `post_status(harness, task, message)` / `get_status_feed(limit?)`,
  mirrored as REST `POST /status-feed` / `GET /status-feed`, and a `quota
  status post` / `quota status feed` CLI form — following the same pattern as
  `get_usage`/`get_resets`.
- New SQLite table `status_feed (id, harness, task, message, posted_at)`,
  append-only like `snapshots`.
- Dashboard: no panel exists yet in `public/index.html` (an earlier
  placeholder panel was removed as dead weight in the 2026-07-17 UI revamp,
  since it wasn't built) — add a new panel with a newest-first list, each row
  showing a harness chip, the message, and a relative timestamp; poll
  `GET /status-feed` on the same 30s interval as `/usage`.
- Purpose (from the plan doc): the dashboard doubles as cross-harness mission
  control — agents in Codex/Claude Code/T3C/Warp `post_status` a short
  progress string, so the feed becomes the "what's running where" view.

## MCP server (Phase 3, extended in Phase 4)

`src/mcp.ts` is a stdio MCP server exposing:

- `get_usage` — same data as `quota json`, refreshed on call (best-effort,
  respecting poll floors).
- `get_resets` — natural 5h/weekly/pool reset times plus Codex's banked reset
  credits (`available_count`, `total_earned_count`, each credit's status and
  expiry). Report-only, as above.
- `estimate_cost({ taskProfile? })` — v1.5 heuristic token-range estimate
  (see `src/estimation.ts` for the full calibration-provenance comment).
  Returns real structured data, no longer a stub.
- `recommend_model({ taskProfile? })` — combines that estimate with live
  `get_usage` headroom across all three providers and returns a ranked
  provider+model suggestion with a one-line reason, alternates, and explicit
  warnings for any stale/unavailable provider (never silently dropped).
  Returns real structured data, no longer a stub. This is the tool the
  `plan-review-execute` skill's pre-flight gate was waiting on — once this
  shipped, the gate's `{ implemented: false }` fallback path stops
  triggering automatically (no changes needed on that skill's side).

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

## Launchd (loaded and running as of Phase 4–6)

`launchd/com.luis.quota-service.plist` runs `bun run src/server.ts` at load
and keeps it alive, polling every 5 minutes on port 8787. **It is loaded** —
found running (uptime ~10.7h) at the start of this Phase 4–6 session, so it
was installed sometime after the Phase 1–3 handoff was written (that handoff
still says "not loaded"; this note supersedes it). It picked up the new
Phase 4/5 code automatically on restart during this session's testing (kill +
launchd's `KeepAlive` respawns it; no reinstall needed for code changes).
Reference, if it's ever uninstalled and needs reinstalling — the Anthropic
collector's first Keychain read from a new binary triggers a one-time
interactive "always allow" prompt, which launchd can't answer headless, so
install it only after a foreground run has confirmed that prompt was granted:

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
- **Estimation calibration is v1.5, not full v2** — `src/estimation.ts`'s
  token-range bounds were sanity-checked against real per-session token
  totals from 119 Claude Code transcripts
  (`~/.claude/projects/**/*.jsonl`, one-off analysis, 2026-07-13:
  p10=20,507 p25=25,950 p50=73,399 p75=120,258 p90=229,201 p95=293,455
  max=761,626), but the task-profile *labels*
  (`small_fix`/`feature`/`large_refactor`/`research`) are still hand-assigned
  — the transcripts carry no ground-truth task-type field. Codex equivalents
  (`~/.codex/sessions/**/*.jsonl`) were not cross-referenced (different token-
  accounting shape; the Codex collector at `src/collectors/codex.ts` already
  knows how to tail these and would be the natural place to reuse that
  parsing). Full methodology and the real-v2 TODO are in a comment block at
  the top of `src/estimation.ts`.
- **Purchase/manage links on the dashboard are best-effort**, not
  exhaustively verified against every account state — see the "Web dashboard"
  section above.
- **Dashboard visual approval is still pending** — built to the "pretty is a
  requirement" bar using the `frontend-design` and `dataviz` skills, verified
  functionally (real data renders correctly, live-tested in a browser
  preview), but only Luis can sign off on "pretty."
