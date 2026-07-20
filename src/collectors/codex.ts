import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { CollectorResult, ResetCreditsResult, WindowSnapshot } from "../types";

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const SESSIONS_DIRS = [
  join(CODEX_HOME, "sessions"),
  join(CODEX_HOME, "archived_sessions"),
];

export interface RateLimitsPayload {
  limit_id?: string;
  primary?: { used_percent: number; window_minutes: number; resets_at: number } | null;
  secondary?: { used_percent: number; window_minutes: number; resets_at: number } | null;
  credits?: unknown;
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
}

/** Recursively find *.jsonl files under a dir, newest mtime first, capped for cost. */
async function findRecentRollouts(dir: string, limit: number): Promise<{ path: string; mtimeMs: number }[]> {
  const results: { path: string; mtimeMs: number }[] = [];
  async function walk(d: string, depth: number): Promise<void> {
    if (depth > 4) return; // sessions/YYYY/MM/DD/*.jsonl
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const s = await stat(full);
          results.push({ path: full, mtimeMs: s.mtimeMs });
        } catch {
          // ignore races
        }
      }
    }
  }
  await walk(dir, 0);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, limit);
}

/** Tail a jsonl file's last N lines cheaply without reading the whole file for large logs. */
async function readLastLines(path: string, maxBytes = 200_000): Promise<string[]> {
  const file = Bun.file(path);
  const size = file.size;
  const start = Math.max(0, size - maxBytes);
  const text = await file.slice(start, size).text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  // if we truncated mid-line at the start, drop the first partial line
  if (start > 0 && lines.length > 0) lines.shift();
  return lines;
}

interface FoundRateLimits {
  rateLimits: RateLimitsPayload;
  timestamp: string;
}

const FIVE_HOUR_MAX_SECONDS = 6 * 3600; // classify windows <= 6h as the 5h window
const WEEKLY_MIN_SECONDS = 3 * 24 * 3600; // classify windows >= 3d as the weekly window

async function findLatestRateLimits(): Promise<FoundRateLimits | null> {
  // Check a handful of the most-recently-modified rollout files across both
  // dirs; the newest event with a rate_limits block wins.
  const candidates = (
    await Promise.all(SESSIONS_DIRS.map((d) => findRecentRollouts(d, 5)))
  )
    .flat()
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 5);

  let best: FoundRateLimits | null = null;
  for (const { path } of candidates) {
    const lines = await readLastLines(path);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"rate_limits"')) continue;
      try {
        const obj = JSON.parse(line);
        const rateLimits = obj?.payload?.rate_limits;
        const timestamp = obj?.timestamp;
        if (rateLimits && timestamp) {
          const candidate: FoundRateLimits = { rateLimits, timestamp };
          if (!best || new Date(candidate.timestamp).getTime() > new Date(best.timestamp).getTime()) {
            best = candidate;
          }
          break; // newest matching line in this file found
        }
      } catch {
        // malformed line, skip
      }
    }
  }
  return best;
}

function classifyFileWindows(rl: RateLimitsPayload): {
  fiveHour: NonNullable<RateLimitsPayload["primary"]> | null;
  weekly: NonNullable<RateLimitsPayload["primary"]> | null;
} {
  const windows = [rl.primary, rl.secondary].filter(
    (window): window is NonNullable<typeof window> => window != null,
  );
  let fiveHour: NonNullable<RateLimitsPayload["primary"]> | null = null;
  let weekly: NonNullable<RateLimitsPayload["primary"]> | null = null;
  for (const window of windows) {
    const durationSeconds = window.window_minutes * 60;
    if (durationSeconds <= FIVE_HOUR_MAX_SECONDS) fiveHour = window;
    else if (durationSeconds >= WEEKLY_MIN_SECONDS) weekly = window;
  }
  return { fiveHour, weekly };
}

export function toWindowSnapshotFromFile(rl: RateLimitsPayload): WindowSnapshot {
  const { fiveHour, weekly } = classifyFileWindows(rl);
  return {
    kind: "window",
    fiveHour: fiveHour
      ? { usedPercent: fiveHour.used_percent, resetsAt: fiveHour.resets_at * 1000 }
      : null,
    weekly: weekly
      ? { usedPercent: weekly.used_percent, resetsAt: weekly.resets_at * 1000 }
      : null,
    extra: {
      planType: rl.plan_type ?? null,
      credits: rl.credits ?? null,
      rateLimitReachedType: rl.rate_limit_reached_type ?? null,
    },
  };
}

/** Source A: tail newest rollout jsonl for the latest rate_limits snapshot. Zero auth, zero network. */
export async function collectCodexFromFile(): Promise<CollectorResult> {
  const capturedAt = Date.now();
  try {
    const found = await findLatestRateLimits();
    if (!found) {
      return {
        provider: "codex",
        status: "unavailable",
        source: "codex_file",
        dataAsOf: null,
        capturedAt,
        snapshot: null,
        error: "no rate_limits snapshot found in recent session rollouts",
      };
    }
    return {
      provider: "codex",
      status: "ok",
      source: "codex_file",
      dataAsOf: new Date(found.timestamp).getTime(),
      capturedAt,
      snapshot: toWindowSnapshotFromFile(found.rateLimits),
    };
  } catch (err) {
    return {
      provider: "codex",
      status: "unavailable",
      source: "codex_file",
      dataAsOf: null,
      capturedAt,
      snapshot: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface CodexAuth {
  tokens?: { access_token?: string; account_id?: string };
}

async function readCodexAuth(): Promise<CodexAuth | null> {
  try {
    const file = Bun.file(join(CODEX_HOME, "auth.json"));
    if (!(await file.exists())) return null;
    return (await file.json()) as CodexAuth;
  } catch {
    return null;
  }
}

const WHAM_BASE = "https://chatgpt.com/backend-api/wham";

// Same rationale as ANTHROPIC's FETCH_TIMEOUT_MS: a fetch with no deadline
// can hang indefinitely (observed after macOS sleep/wake), which wedges
// whatever awaits it — the poll loop, or a collect-on-query request.
const FETCH_TIMEOUT_MS = 10_000;

// Live shape observed 2026-07-12 differs from the app-server RPC shape the
// research doc anchored on: it's `rate_limit.{primary_window,secondary_window}`
// (singular, nested), each `{used_percent, limit_window_seconds, reset_after_seconds,
// reset_at}`, rather than the file tactic's flatter `rate_limits.{primary,secondary}`.
// Window naming/order isn't trustworthy across accounts/states (this account's
// live call returned only one populated window), so windows are classified by
// their duration rather than by position.
export interface WhamWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
}
export interface WhamUsageResponse {
  plan_type?: string;
  rate_limit?: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window: WhamWindow | null;
    secondary_window: WhamWindow | null;
  } | null;
  credits?: unknown;
  rate_limit_reset_credits?: { available_count: number };
  rate_limit_reached_type?: string | null;
}

function classifyWhamWindows(rl: NonNullable<WhamUsageResponse["rate_limit"]>): {
  fiveHour: WhamWindow | null;
  weekly: WhamWindow | null;
} {
  const windows = [rl.primary_window, rl.secondary_window].filter(
    (w): w is WhamWindow => w != null,
  );
  let fiveHour: WhamWindow | null = null;
  let weekly: WhamWindow | null = null;
  for (const w of windows) {
    if (w.limit_window_seconds <= FIVE_HOUR_MAX_SECONDS) fiveHour = w;
    else if (w.limit_window_seconds >= WEEKLY_MIN_SECONDS) weekly = w;
  }
  return { fiveHour, weekly };
}

export function toWindowSnapshotFromWham(body: WhamUsageResponse): WindowSnapshot {
  const rl = body.rate_limit;
  const { fiveHour, weekly } = rl
    ? classifyWhamWindows(rl)
    : { fiveHour: null, weekly: null };
  return {
    kind: "window",
    fiveHour: fiveHour
      ? { usedPercent: fiveHour.used_percent, resetsAt: fiveHour.reset_at * 1000 }
      : null,
    weekly: weekly
      ? { usedPercent: weekly.used_percent, resetsAt: weekly.reset_at * 1000 }
      : null,
    extra: {
      planType: body.plan_type ?? null,
      credits: body.credits ?? null,
      rateLimitReachedType: body.rate_limit_reached_type ?? null,
      bankedResetCreditsAvailable: body.rate_limit_reset_credits?.available_count ?? null,
    },
  };
}

/** Source B: authenticated GET for freshness. Degrades to the file tactic on any failure. */
export async function collectCodexFromApi(): Promise<CollectorResult> {
  const capturedAt = Date.now();
  const auth = await readCodexAuth();
  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  if (!accessToken) {
    return degradeToFile("no access token in ~/.codex/auth.json");
  }
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "quota-service/1.0.0 (+codex-cli-compatible)",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const res = await fetch(`${WHAM_BASE}/usage`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 401) {
      return degradeToFile("wham/usage HTTP 401 (stale credentials)");
    }
    if (!res.ok) {
      return degradeToFile(`wham/usage HTTP ${res.status}`);
    }
    const body = (await res.json()) as WhamUsageResponse;
    if (!body.rate_limit) return degradeToFile("wham/usage response missing rate_limit");
    return {
      provider: "codex",
      status: "ok",
      source: "codex_api",
      dataAsOf: capturedAt, // server-authoritative live call
      capturedAt,
      snapshot: toWindowSnapshotFromWham(body),
    };
  } catch (err) {
    return degradeToFile(err instanceof Error ? err.message : String(err));
  }
}

async function degradeToFile(reason: string): Promise<CollectorResult> {
  const fileResult = await collectCodexFromFile();
  return annotateFileFallback(fileResult, reason);
}

export function annotateFileFallback(fileResult: CollectorResult, reason: string): CollectorResult {
  return {
    ...fileResult,
    error: fileResult.error
      ? `${fileResult.error}; api tactic also failed: ${reason}`
      : `api tactic failed (${reason}), degraded to file tactic`,
  };
}

/** Codex banked reset credits — report only, never consumed. */
export async function collectCodexResetCredits(): Promise<ResetCreditsResult> {
  const capturedAt = Date.now();
  const auth = await readCodexAuth();
  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  if (!accessToken) {
    return {
      provider: "codex",
      status: "unavailable",
      capturedAt,
      availableCount: null,
      totalEarnedCount: null,
      credits: [],
      error: "no access token in ~/.codex/auth.json",
    };
  }
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "quota-service/1.0.0 (+codex-cli-compatible)",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const res = await fetch(`${WHAM_BASE}/rate-limit-reset-credits`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      return {
        provider: "codex",
        status: "unavailable",
        capturedAt,
        availableCount: null,
        totalEarnedCount: null,
        credits: [],
        error: `rate-limit-reset-credits HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as {
      credits?: Array<{
        id: string;
        reset_type?: string;
        status?: string;
        granted_at?: string;
        expires_at?: string;
        title?: string;
        description?: string;
      }>;
      available_count?: number;
      total_earned_count?: number;
    };
    return {
      provider: "codex",
      status: "ok",
      capturedAt,
      availableCount: body.available_count ?? null,
      totalEarnedCount: body.total_earned_count ?? null,
      credits: (body.credits ?? []).map((c) => ({
        id: c.id,
        resetType: c.reset_type ?? null,
        status: c.status ?? null,
        grantedAt: c.granted_at ?? null,
        expiresAt: c.expires_at ?? null,
        title: c.title ?? null,
        description: c.description ?? null,
      })),
    };
  } catch (err) {
    return {
      provider: "codex",
      status: "unavailable",
      capturedAt,
      availableCount: null,
      totalEarnedCount: null,
      credits: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Public entry point: try the network freshness upgrade, degrade to file automatically. */
export async function collectCodex(): Promise<CollectorResult> {
  return collectCodexFromApi();
}
