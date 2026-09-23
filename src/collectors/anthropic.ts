import { readGenericPassword } from "../lib/keychain";
import { finiteNumber, parseInstant } from "../lib/time";
import type { CollectorResult, UsageCredits, WindowQuota, WindowSnapshot } from "../types";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

// Community-reported safe interval; Claude Code's own User-Agent-gated bucket
// gets aggressively rate limited below this. Enforced by the caller (server
// poll loop / CLI collect-on-query guard), not this module, so this constant
// is exported for those call sites to share.
export const ANTHROPIC_POLL_FLOOR_MS = 180_000;

// Live network calls must never hang past this — a fetch that stalls after
// the Mac wakes from sleep (observed root cause of the Jul 13 wedge, where
// the poll loop's `await` on a hung fetch blocked forever and no further
// snapshots were written) must fail fast instead of blocking the caller
// (poll loop, or a collect-on-query HTTP/MCP/CLI read) indefinitely.
const FETCH_TIMEOUT_MS = 10_000;

interface ClaudeAiOauth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
}

interface KeychainPayload {
  claudeAiOauth?: ClaudeAiOauth;
}

interface WindowField {
  utilization: number;
  resets_at: string;
}

/** Generic per-bucket limit entry — the live response carries the Fable
 * per-model weekly bucket (and any other model-scoped bucket) here, not
 * under a dedicated `seven_day_<model>` field. Those dedicated fields still
 * appear in the payload but were observed always-null; `limits[]` is the
 * real source and is what we parse. */
interface OauthLimit {
  kind: string;
  group: string;
  percent: number;
  severity?: string | null;
  resets_at: string | null;
  scope?: {
    model?: { id: string | null; display_name: string | null } | null;
    surface?: string | null;
  } | null;
  is_active?: boolean;
}

interface OauthMoneyAmount {
  amount_minor: number;
  currency: string;
  exponent: number;
}

/** Observed live shape (2026-07-14): the authoritative usage-credits surface
 * is `spend`, not the older `extra_usage` block (both can be present;
 * `extra_usage` is kept as a fallback for accounts where `spend` is absent). */
interface OauthSpend {
  used?: OauthMoneyAmount | null;
  limit?: OauthMoneyAmount | null;
  percent?: number | null;
  enabled?: boolean | null;
  disabled_reason?: string | null;
  resets_at?: string | null;
}

interface OauthExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency?: string | null;
  decimal_places?: number | null;
  resets_at?: string | null;
}

interface OauthUsageResponse {
  five_hour?: WindowField | null;
  seven_day?: WindowField | null;
  /** Generic per-model/per-scope limits — includes the Fable weekly bucket
   * (kind: "weekly_scoped", scope.model.display_name: "Fable") when present.
   * This bucket is temporary by design (Anthropic's own framing) and simply
   * won't appear in `limits[]` once it expires — nothing to special-case. */
  limits?: OauthLimit[] | null;
  extra_usage?: OauthExtraUsage | null;
  spend?: OauthSpend | null;
}

interface OauthProfileResponse {
  organization?: {
    organization_type?: string | null;
    rate_limit_tier?: string | null;
  } | null;
}

type CredentialResult =
  | { ok: true; oauth: ClaudeAiOauth & { accessToken: string } }
  | { ok: false; denied: boolean; error: string };

type OauthProfile = { planType: string | null; rateLimitTier: string | null };

/** The plan tier changes rarely, but the profile call spends a request on
 * every poll. Reuse a successful lookup for hours and a failed one for a
 * shorter time, so the usage call is the only request on most polls. */
const PROFILE_CACHE_MS = 6 * 60 * 60_000;
const PROFILE_FAILURE_CACHE_MS = 30 * 60_000;

export type OauthProfileCache = {
  value: OauthProfile | null;
  fetchedAt: number;
} | null;

const profileCache: { current: OauthProfileCache } = { current: null };

type AnthropicCollectorDependencies = {
  readCredentials?: () => Promise<CredentialResult>;
  request?: typeof globalThis.fetch;
  now?: () => number;
  /** Tests pass their own holder so the module cache does not leak between cases. */
  profileCache?: { current: OauthProfileCache };
};

async function readClaudeCodeCredentials(): Promise<
  CredentialResult
> {
  const kc = await readGenericPassword(KEYCHAIN_SERVICE);
  if (!kc.ok) {
    return { ok: false, denied: kc.denied ?? false, error: kc.error ?? "keychain read failed" };
  }
  let parsed: KeychainPayload;
  try {
    parsed = JSON.parse(kc.value!) as KeychainPayload;
  } catch {
    return { ok: false, denied: false, error: "keychain value is not valid JSON" };
  }
  if (!parsed.claudeAiOauth?.accessToken) {
    // Known gotcha: on some installs the item holds only MCP OAuth state.
    return {
      ok: false,
      denied: false,
      error: 'keychain item "Claude Code-credentials" has no claudeAiOauth.accessToken (config error, not a crash)',
    };
  }
  return {
    ok: true,
    oauth: { ...parsed.claudeAiOauth, accessToken: parsed.claudeAiOauth.accessToken },
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Claude Code uses the same profile fields to distinguish its Max plans.
 * Keep the normalized value stable for history consumers while retaining the
 * provider's raw rate-limit tier beside it. */
export function planTypeFromOauthProfile(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const organization = (body as OauthProfileResponse).organization;
  if (!organization || typeof organization !== "object") return null;
  const organizationType = nonEmptyString(organization.organization_type);
  const rateLimitTier = nonEmptyString(organization.rate_limit_tier);
  if (organizationType === "claude_max") {
    if (rateLimitTier === "default_claude_max_5x") return "max_5x";
    if (rateLimitTier === "default_claude_max_20x") return "max_20x";
    return null;
  }
  if (organizationType === "claude_pro") return "pro";
  if (organizationType === "claude_team") return "team";
  if (organizationType === "claude_enterprise") return "enterprise";
  return null;
}

async function cachedOauthProfile(
  accessToken: string,
  request: typeof globalThis.fetch,
  cache: { current: OauthProfileCache },
  now: number,
): Promise<OauthProfile | null> {
  const cached = cache.current;
  if (cached) {
    const ttl = cached.value ? PROFILE_CACHE_MS : PROFILE_FAILURE_CACHE_MS;
    if (now - cached.fetchedAt < ttl) return cached.value;
  }
  const value = await fetchOauthProfile(accessToken, request);
  cache.current = { value, fetchedAt: now };
  return value;
}

async function fetchOauthProfile(
  accessToken: string,
  request: typeof globalThis.fetch,
): Promise<OauthProfile | null> {
  try {
    const response = await request(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": claudeCodeUserAgent(),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as OauthProfileResponse;
    return {
      planType: planTypeFromOauthProfile(body),
      rateLimitTier: nonEmptyString(body.organization?.rate_limit_tier),
    };
  } catch {
    return null;
  }
}

/** Generic across whatever per-model buckets `limits[]` carries — no
 * "Fable" special-casing beyond the display name coming through as-is
 * (e.g. "Fable"). Behaves cleanly when `limits` is empty/absent: returns {}. */
function buildModelWindows(limits: OauthLimit[] | null | undefined): Record<string, WindowQuota> {
  const out: Record<string, WindowQuota> = {};
  for (const limit of limits ?? []) {
    const model = limit.scope?.model;
    const name = model?.display_name ?? model?.id;
    if (!name) continue; // not a per-model bucket (e.g. the aggregate "weekly_all" entry)
    const usedPercent = finiteNumber(limit.percent);
    if (usedPercent === null) continue; // a bucket with a non-finite percent is meaningless; omit it
    out[name] = {
      usedPercent,
      resetsAt: parseInstant(limit.resets_at),
    };
  }
  return out;
}

function minorToMajor(amountMinor: number, exponent: number): number {
  return amountMinor / 10 ** exponent;
}

/** Prefers the newer `spend` block (structured minor-unit amounts + currency);
 * falls back to the legacy `extra_usage` shape when `spend` is absent. */
function buildUsageCredits(body: OauthUsageResponse): UsageCredits | null {
  const spend = body.spend;
  if (spend && (spend.used || spend.limit)) {
    const exponent = finiteNumber(spend.used?.exponent) ?? finiteNumber(spend.limit?.exponent) ?? 2;
    const usedMinor = finiteNumber(spend.used?.amount_minor);
    const limitMinor = finiteNumber(spend.limit?.amount_minor);
    return {
      enabled: !!spend.enabled,
      spentAmount: usedMinor !== null ? minorToMajor(usedMinor, exponent) : 0,
      limitAmount: limitMinor !== null ? minorToMajor(limitMinor, exponent) : null,
      currency: spend.used?.currency ?? spend.limit?.currency ?? "USD",
      resetsAt: parseInstant(spend.resets_at),
    };
  }
  const extra = body.extra_usage;
  if (extra) {
    const decimals = finiteNumber(extra.decimal_places) ?? 2;
    const usedCredits = finiteNumber(extra.used_credits);
    const monthlyLimit = finiteNumber(extra.monthly_limit);
    return {
      enabled: !!extra.is_enabled,
      spentAmount: usedCredits !== null ? usedCredits / 10 ** decimals : 0,
      limitAmount: monthlyLimit !== null ? monthlyLimit / 10 ** decimals : null,
      currency: extra.currency ?? "USD",
      resetsAt: parseInstant(extra.resets_at),
    };
  }
  return null;
}

/** A rolling-window field -> WindowQuota, guarding both the percent and the
 * reset instant. A non-finite `utilization` yields `null` (window omitted)
 * rather than a `NaN` dial silently serialized as `null`. */
function toWindowQuota(field: WindowField | null | undefined): WindowQuota | null {
  if (!field) return null;
  const usedPercent = finiteNumber(field.utilization);
  if (usedPercent === null) return null;
  return { usedPercent, resetsAt: parseInstant(field.resets_at) };
}

function toWindowSnapshot(body: OauthUsageResponse): WindowSnapshot {
  return {
    kind: "window",
    fiveHour: toWindowQuota(body.five_hour),
    weekly: toWindowQuota(body.seven_day),
    modelWindows: buildModelWindows(body.limits),
    usageCredits: buildUsageCredits(body),
    extra: {
      rawLimits: body.limits ?? null,
    },
  };
}

/** claude-code/<version> is required or requests land in an aggressively rate-limited bucket. */
function claudeCodeUserAgent(): string {
  return `claude-code/${process.env.QUOTA_SERVICE_CLAUDE_CODE_VERSION ?? "2.1.206"}`;
}

export async function collectAnthropic(
  dependencies: AnthropicCollectorDependencies = {},
): Promise<CollectorResult> {
  const request = dependencies.request ?? globalThis.fetch;
  const capturedAt = (dependencies.now ?? Date.now)();
  const creds = await (dependencies.readCredentials ?? readClaudeCodeCredentials)();
  if (!creds.ok) {
    return {
      provider: "anthropic",
      status: "unavailable",
      source: "anthropic_api",
      dataAsOf: null,
      capturedAt,
      snapshot: null,
      error: creds.denied
        ? "keychain access denied (grant access to the quota-service binary and retry)"
        : creds.error,
    };
  }
  try {
    const res = await request(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": claudeCodeUserAgent(),
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401) {
      return {
        provider: "anthropic",
        status: "stale",
        source: "anthropic_api",
        dataAsOf: null,
        capturedAt,
        snapshot: null,
        error: "401 from oauth/usage — access token stale; will self-heal on next Claude Code use (no self-refresh by design)",
      };
    }
    if (!res.ok) {
      return {
        provider: "anthropic",
        status: "unavailable",
        source: "anthropic_api",
        dataAsOf: null,
        capturedAt,
        snapshot: null,
        error: `oauth/usage HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as OauthUsageResponse;
    const snapshot = toWindowSnapshot(body);
    // Only after a successful usage read: a rejected or rate-limited token
    // gains nothing from a second request.
    const profile = await cachedOauthProfile(
      creds.oauth.accessToken,
      request,
      dependencies.profileCache ?? profileCache,
      capturedAt,
    );
    return {
      provider: "anthropic",
      status: "ok",
      source: "anthropic_api",
      dataAsOf: capturedAt, // server-authoritative live call
      capturedAt,
      snapshot: {
        ...snapshot,
        extra: {
          ...snapshot.extra,
          ...(profile?.planType
            ? { planType: profile.planType, planSource: "oauth_profile" }
            : {}),
          rateLimitTier: profile?.rateLimitTier ?? null,
          subscriptionType: creds.oauth.subscriptionType ?? null,
        },
      },
    };
  } catch (err) {
    return {
      provider: "anthropic",
      status: "unavailable",
      source: "anthropic_api",
      dataAsOf: null,
      capturedAt,
      snapshot: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
