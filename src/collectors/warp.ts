import { domainPlistMtimeMs, readDefaultsKeyAsJson } from "../lib/plist";
import { parseInstant } from "../lib/time";
import type { CollectorResult, PoolSnapshot } from "../types";

const WARP_DOMAIN = "dev.warp.Warp-Stable";
const WARP_KEY = "AIRequestLimitInfo";

/** If the plist hasn't updated in this long, Warp is probably not running and the pool value may be frozen. */
const STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour

interface WarpLimitInfo {
  limit: number;
  num_requests_used_since_refresh: number;
  next_refresh_time: string; // ISO 8601
  is_unlimited: boolean;
  request_limit_refresh_duration: string; // e.g. "Monthly"
  is_unlimited_voice?: boolean;
  voice_request_limit?: number;
  voice_requests_used_since_last_refresh?: number;
  is_unlimited_codebase_indices?: boolean;
  max_codebase_indices?: number;
  max_files_per_repo?: number;
}

function toPoolSnapshot(info: WarpLimitInfo): PoolSnapshot {
  const used = info.num_requests_used_since_refresh;
  const limit = info.limit;
  const usedPercent = info.is_unlimited || limit <= 0 ? 0 : Math.round((used / limit) * 1000) / 10;
  return {
    kind: "pool",
    pool: {
      used,
      limit,
      usedPercent,
      refreshesAt: parseInstant(info.next_refresh_time),
      cadence: info.request_limit_refresh_duration,
    },
    extra: {
      isUnlimited: info.is_unlimited,
      isUnlimitedVoice: info.is_unlimited_voice,
      voiceRequestLimit: info.voice_request_limit,
      voiceRequestsUsed: info.voice_requests_used_since_last_refresh,
      isUnlimitedCodebaseIndices: info.is_unlimited_codebase_indices,
      maxCodebaseIndices: info.max_codebase_indices,
      maxFilesPerRepo: info.max_files_per_repo,
    },
  };
}

/** Source A: `defaults read` of Warp's cfprefsd-backed preference domain. No credentials needed. */
export async function collectWarp(): Promise<CollectorResult> {
  const capturedAt = Date.now();
  const result = await readDefaultsKeyAsJson(WARP_DOMAIN, WARP_KEY);
  const mtimeMs = await domainPlistMtimeMs(WARP_DOMAIN);
  if (!result.ok) {
    return {
      provider: "warp",
      status: "unavailable",
      source: "warp_plist",
      dataAsOf: mtimeMs,
      capturedAt,
      snapshot: null,
      error: result.error,
    };
  }
  const info = result.value as Partial<WarpLimitInfo>;
  if (
    typeof info.limit !== "number" ||
    typeof info.num_requests_used_since_refresh !== "number" ||
    typeof info.next_refresh_time !== "string"
  ) {
    return {
      provider: "warp",
      status: "unavailable",
      source: "warp_plist",
      dataAsOf: mtimeMs,
      capturedAt,
      snapshot: null,
      error: "AIRequestLimitInfo missing expected fields (Warp preference schema may have changed)",
    };
  }
  const dataAsOf = mtimeMs ?? capturedAt;
  const isStale = Date.now() - dataAsOf > STALE_AFTER_MS;
  return {
    provider: "warp",
    status: isStale ? "stale" : "ok",
    source: "warp_plist",
    dataAsOf,
    capturedAt,
    snapshot: toPoolSnapshot(info as WarpLimitInfo),
    error: isStale
      ? `plist not updated in over an hour — Warp may not be running; value may be frozen`
      : undefined,
  };
}
