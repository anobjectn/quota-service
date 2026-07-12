import { readGenericPassword } from "../lib/keychain";
import type { CollectorResult, WindowSnapshot } from "../types";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// Community-reported safe interval; Claude Code's own User-Agent-gated bucket
// gets aggressively rate limited below this. Enforced by the caller (server
// poll loop / CLI collect-on-query guard), not this module, so this constant
// is exported for those call sites to share.
export const ANTHROPIC_POLL_FLOOR_MS = 180_000;

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

interface OauthUsageResponse {
  five_hour?: WindowField | null;
  seven_day?: WindowField | null;
  seven_day_opus?: WindowField | null;
  seven_day_sonnet?: WindowField | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
}

async function readClaudeCodeCredentials(): Promise<
  { ok: true; oauth: ClaudeAiOauth } | { ok: false; denied: boolean; error: string }
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
  return { ok: true, oauth: parsed.claudeAiOauth };
}

function toWindowSnapshot(body: OauthUsageResponse): WindowSnapshot {
  return {
    kind: "window",
    fiveHour: body.five_hour
      ? { usedPercent: body.five_hour.utilization, resetsAt: Date.parse(body.five_hour.resets_at) }
      : null,
    weekly: body.seven_day
      ? { usedPercent: body.seven_day.utilization, resetsAt: Date.parse(body.seven_day.resets_at) }
      : null,
    extra: {
      sevenDayOpus: body.seven_day_opus ?? null,
      sevenDaySonnet: body.seven_day_sonnet ?? null,
      extraUsage: body.extra_usage ?? null,
    },
  };
}

/** claude-code/<version> is required or requests land in an aggressively rate-limited bucket. */
function claudeCodeUserAgent(): string {
  return `claude-code/${process.env.QUOTA_SERVICE_CLAUDE_CODE_VERSION ?? "2.1.206"}`;
}

export async function collectAnthropic(): Promise<CollectorResult> {
  const capturedAt = Date.now();
  const creds = await readClaudeCodeCredentials();
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
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": claudeCodeUserAgent(),
        "Content-Type": "application/json",
      },
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
    return {
      provider: "anthropic",
      status: "ok",
      source: "anthropic_api",
      dataAsOf: capturedAt, // server-authoritative live call
      capturedAt,
      snapshot: toWindowSnapshot(body),
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
