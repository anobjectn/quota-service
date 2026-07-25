# AI Usage Observatory handoff: dense Claude quota, credits, and provenance

## Suggested receiving-model prompt

```text
Work in /Users/luis/htdocs/ai-usage-observatory. Implement the integration
specified in
/Users/luis/htdocs/quota-service/AIUO-CLAUDE-CREDITS-HANDOFF.md.
Inspect both repositories before editing. Preserve the AIUO worktree's
unrelated untracked files. Complete the server proxy, backwards-compatible
types, compact Overview presentation, grouped Fable promotion, Sources /
Provenance detail, update workflow, tests, typecheck, and production build.
Do not commit unless asked.
```

## Goal

Bring the richer `quota-service` Anthropic data into the sibling
`/Users/luis/htdocs/ai-usage-observatory` project in two places:

1. The Overview quota dashboard: dense, compact, readable allowance and credit
   information.
2. Sources / Data Provenance: long-form source boundaries, timestamps, raw
   evidence, supporting links, and refresh/update actions.

The Fable promotion must be one visual object. Do not scatter its grant,
remaining value, campaign, and expiry across unrelated metrics.

## Repositories and current state

- Producer: `/Users/luis/htdocs/quota-service`
- Consumer: `/Users/luis/htdocs/ai-usage-observatory`
- `quota-service` contains the producer-side implementation in the commit that
  adds this handoff.
- AIUO `main` was at `6227cf5` when this handoff was written.
- AIUO has unrelated untracked `_temp/` and screenshot files. Preserve them.

Run both projects' typecheck and test suites. Do not modify or clean unrelated
AIUO files.

## Verified authentication boundary

`quota-service`'s Claude Code OAuth credential was tested against:

- `claude.ai/api/organizations/…/prepaid/credits`
- `claude.ai/api/organizations/…/overage_credit_grant?campaign=fable_transition`

Both returned:

```text
403 account_session_invalid
```

Therefore:

- OAuth remains the automatic source for allowance windows and monthly spend.
- Claude Web prepaid/promotion details remain a separately timestamped,
  user-imported observation.
- Do not ask for, copy, persist, or proxy browser cookies.
- Do not label imported Claude Web values as live/provider-polled.

## Current `quota-service` contract

`GET http://127.0.0.1:8787/usage` now includes:

```ts
type UsageCredits = {
  enabled: boolean;
  spentAmount: number;
  limitAmount: number | null;
  currency: string;
  resetsAt: number | null;
};

type AnthropicWebCredits = {
  source: "claude_web_manual";
  capturedAt: number; // when the user observed Claude Web
  updatedAt: number;  // when quota-service stored it
  currentBalance: number | null;
  balanceCredits: number | null;
  currency: string;
  autoReloadEnabled: boolean | null;
  nextExpiresAt: number | null;
  promotionalTranches: Array<{
    remainingAmount: number;
    grantedAmount: number | null;
    expiresAt: number | null;
  }>;
  campaign: {
    id: string;
    granted: boolean | null;
    amount: number | null;
    expiresAt: number | null;
  } | null;
  purchases: {
    purchasedThisMonthAmount: number | null;
    monthlyCapAmount: number | null;
    resetsAt: number | null;
    maxDiscountPercent: number | null;
  } | null;
};
```

The Anthropic provider report also carries `dataAgeMs`, `capturedAt`,
`snapshot.usageCredits`, `snapshot.modelWindows`, and
`snapshot.extra.rawLimits`.

The imported observation currently contains:

- Prepaid balance: `$84.97`
- Fable promotion remaining: `$84.96`
- Original grant: `$100.00`
- Campaign: `fable_transition`
- Expiry: `2026-09-19`
- Auto-reload: off
- Purchased this month: `$0`
- Monthly bundle purchase cap: `$2,000`
- Purchase reset: `2026-08-01`
- Maximum bundle discount: `30%`

`POST http://127.0.0.1:8787/anthropic-web-import` accepts:

```ts
type AnthropicWebImport = {
  capturedAt?: number | string;
  currentBalance?: number | null;
  balanceCredits?: number | null;
  currency?: string;
  autoReloadEnabled?: boolean | null;
  nextExpiresAt?: number | string | null;
  promoRemaining?: number | null;
  promoGranted?: number | null;
  promoExpiresAt?: number | string | null;
  campaignId?: string | null;
  campaignGranted?: boolean | null;
  campaignAmount?: number | null;
  campaignExpiresAt?: number | string | null;
  purchasedThisMonthAmount?: number | null;
  monthlyCapAmount?: number | null;
  purchasesResetAt?: number | string | null;
  maxDiscountPercent?: number | null;
};
```

It returns `{ ok: true, snapshot }`.

## AIUO integration points

### Server

- `server/quota.ts`
  - Already fetches `/usage`, `/resets`, and `/status`.
  - Preserve the new fields instead of reducing them.
  - Add a small proxy function for `POST /anthropic-web-import`.
- `server/index.ts`
  - Add `POST /api/quotas/anthropic-web-import`.
  - Validate the body, proxy it to quota-service, then call the existing
    collector `refresh()` so the response and in-memory dashboard update in
    one interaction.
  - Return the refreshed dashboard or normalized quota result.
- `server/collector.ts`
  - Existing `POST /api/refresh` already rebuilds quota data.
  - No new global refresh system is needed.

Keep all mutation endpoints localhost-only under the existing Host validation.
Use the configured `QUOTA_SERVICE_URL`; do not hardcode `8787` in the React
client.

### Types

Update `src/types.ts`:

- Add `UsageCredits`.
- Add `AnthropicWebCredits`.
- Add `usageCredits?: UsageCredits | null` to `WindowQuotaSnapshot`.
- Add `rawLimits?: unknown[] | null` without removing existing `extra` fields.
- Add `dataAgeMs`, `capturedAt`, `manualEntries`, and
  `anthropicWebCredits?: AnthropicWebCredits | null` to `QuotaProvider`.

Keep the contract tolerant of older or alternative quota services: every new
field is optional.

### Overview

Primary code is `quotaCards()` and `QuotaDials()` in `src/App.tsx`.

Within the Anthropic card, retain the existing allowance buckets, then add a
compact credit section:

1. **Usage credit spend**
   - `$spent / $monthly cap`
   - percent used
   - enabled/disabled
   - source: live OAuth
2. **Prepaid balance**
   - current balance
   - observed age
   - source: Claude Web import
3. **Fable transition credit** — one bordered/grouped component
   - heading: `Fable transition credit`
   - remaining amount as the primary value
   - original grant
   - expiry date/countdown
   - campaign status
   - import age/status

Do not describe the monetary Fable promotion as a Fable model allowance.
If `modelWindows.Fable` appears, render it separately with the other quota
buckets as `Fable model window`.

The Fable component should vanish cleanly when no matching
`campaign.id === "fable_transition"` and no promotional tranche exist.

### Sources / Data Provenance

Primary code is `Sources()` in `src/App.tsx`.

Expand quota-service from one generic source card into three clearly nested
evidence groups:

1. **Provider quota API — live**
   - `api.anthropic.com/api/oauth/usage`
   - provider status, `capturedAt`, `dataAgeMs`
   - five-hour, weekly, scoped/model limits, monthly spend
   - expandable formatted `rawLimits`
   - link to AIUO's raw normalized quota JSON
2. **Claude Web credits — imported**
   - endpoint names above
   - `capturedAt` and `updatedAt`
   - explicit OAuth `403 account_session_invalid` boundary
   - prepaid balance
   - one grouped Fable promotion evidence block
   - update action and link to
     `https://claude.ai/new#settings/usage`
   - supporting policy:
     `https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans`
3. **Local quota history**
   - `~/.quota-service/quota.db`
   - explain observed quota reaches and reset-credit consumption
   - distinguish this from provider-authoritative quota state

Also link the allowance explanation:

`https://support.claude.com/en/articles/11647753-understanding-usage-and-length-limits`

Avoid dumping unbounded JSON into the initial view. Raw evidence belongs in an
expandable region with a bounded height and scrolling.

## Refresh and stale-data workflow

AIUO should offer two different actions because the authentication boundaries
are different.

### Refresh live allowance

Button: `Refresh provider data`

Chain:

```text
AIUO client
  → POST /api/refresh
  → AIUO collector refresh()
  → quota-service GET /usage, /resets, /status
  → quota-service collect-on-read (subject to provider poll floors)
  → refreshed AIUO dashboard
```

Reuse the existing global refresh behavior and loading/error states.

### Update Claude Web credits

Button: `Update Claude Web snapshot`

Preferred initial workflow:

1. Open a compact AIUO modal or inline provenance form.
2. Provide `Open Claude Usage` in a new tab.
3. If Claude requires authentication, the user completes it on Claude's site.
4. User copies the small set of displayed values into the prefilled AIUO form.
5. Submit to `POST /api/quotas/anthropic-web-import`.
6. AIUO proxies to quota-service.
7. AIUO calls `refresh()` and replaces the dashboard snapshot.
8. Show `Updated just now` without requiring a manual second refresh.

The form should expose the common fields first:

- current balance
- Fable remaining
- original Fable grant
- Fable expiry

Place campaign, auto-reload, purchase cap/reset, and discount details under
`More details`.

Future enhancement, not required for the first implementation: an optional
browser companion/extension can read the same-origin Claude responses and
submit only normalized credit data to the AIUO localhost proxy. It must never
send session cookies to either local service.

### Stale-state semantics

Do not combine live quota freshness and imported-credit freshness.

- Live quota state comes from provider `status`, `dataAgeMs`, and `capturedAt`.
- Imported state comes from `anthropicWebCredits.capturedAt`.
- Show imported age at all times.
- Initial suggestion: mark the import `aging` after 24 hours and `stale` after
  7 days, but keep the values visible. Keep these thresholds named constants
  so they can be adjusted after real use.
- Expired is distinct from stale: a promotion can be freshly observed and
  already expired.
- A failed live refresh must preserve the last successful AIUO snapshot, as it
  does today.
- A failed web import must preserve the prior imported observation and show an
  inline error.

## API convenience additions in AIUO

Recommended:

- `GET /api/quotas` — existing normalized quota snapshot or alias of current
  `/api/quotas` behavior.
- `POST /api/quotas/refresh` — optional quota-focused alias of global refresh.
- `POST /api/quotas/anthropic-web-import` — proxy described above.

The client must call AIUO's API, not quota-service directly. This avoids CORS,
centralizes error handling, honors `QUOTA_SERVICE_URL`, and leaves room for a
future companion importer.

## Tests expected

### Server

- `server/quota.test.ts`
  - preserves `usageCredits`, `anthropicWebCredits`, timestamps, and raw limits
  - proxies a valid import
  - reports quota-service non-2xx without destroying prior data
- Route test for `POST /api/quotas/anthropic-web-import`
  - rejects invalid numeric/date fields
  - refreshes the AIUO snapshot after a successful import

### Client/data shaping

- `quotaCards()` or an extracted mapper groups the Fable campaign and tranche
  into one presentation object.
- Fable credit does not become a model quota bucket.
- A real `modelWindows.Fable` still renders separately.
- Imported-credit freshness is independent of provider quota freshness.
- Missing new fields remain backwards compatible.
- UTC date-only expiry renders as September 19 in US time zones, not September
  18.

### Interaction

- Opening the update form does not trigger a provider write.
- Submitting calls the AIUO proxy once.
- Successful submission refreshes visible data.
- Failure leaves prior values visible and announces the error.

Run:

```bash
cd /Users/luis/htdocs/ai-usage-observatory
bun run typecheck
bun test
bun run build
```

## Acceptance criteria

- Overview shows live allowance, spend, prepaid balance, and a single grouped
  Fable promotion without making the card visually noisy.
- Sources gives enough long-form context to determine exactly where each value
  came from and when it was observed.
- Users can refresh live quota and update Claude Web-only data from AIUO.
- The web-update workflow never stores browser credentials.
- Stale imported values remain visible but are unmistakably labeled.
- AIUO works unchanged when quota-service is missing or returns the older
  contract.
- Existing quota history, banked resets, filters, and global refresh continue
  to work.
