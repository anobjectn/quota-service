// Strictly read-only collector for Google Antigravity (`antigravity`).
//
// Two tactics, tried in order:
//   A. Local Antigravity `language_server` / `agy` Connect-RPC over loopback
//      (127.0.0.1 / [::1]), discovered via `ps` + `lsof` with bounded timeouts.
//   B. Read-only Cloud Code OAuth endpoints using existing local credentials
//      (env vars or well-known local files). Never writes or refreshes tokens,
//      never calls `onboardUser`, and never consumes credits.

import { homedir } from "node:os";
import { join } from "node:path";
import { finiteNumber, parseInstant } from "../lib/time";
import type { CollectorResult, WindowQuota, WindowSnapshot } from "../types";

export const ANTIGRAVITY_POLL_FLOOR_MS = 60_000;

const SUBPROCESS_TIMEOUT_MS = 5_000;
/** Loopback RPCs answer in milliseconds; a port that holds the connection open
 * (e.g. a raw LSP socket) must not eat the collect-on-query budget. */
const LOCAL_FETCH_TIMEOUT_MS = 2_000;
/** Shared outer wall-clock ceiling for an entire `collectAntigravity` run
 * (local probe + OAuth fallback combined), leaving comfortable margin under
 * `collect.ts`'s 12s attempt ceiling. */
const TOTAL_COLLECT_BUDGET_MS = 10_000;
/** Total time for local discovery and probing, leaving room inside
 * `TOTAL_COLLECT_BUDGET_MS` for the Cloud Code OAuth fallback. */
const LOCAL_PROBE_BUDGET_MS = 4_500;
/** Per-request timeout for Cloud Code OAuth endpoints so a single stalled
 * host (e.g. cloudcode-pa) leaves room for the daily quota endpoint. */
const CLOUD_FETCH_TIMEOUT_MS = 3_500;
/** Shared budget across all sequential Cloud Code OAuth calls. */
const CLOUD_API_BUDGET_MS = 5_000;

const FIVE_HOUR_MIN_SECONDS = 4 * 3600;
const FIVE_HOUR_TARGET_SECONDS = 5 * 3600;
const FIVE_HOUR_MAX_SECONDS = 6 * 3600;
const WEEKLY_MIN_SECONDS = 6 * 24 * 3600;
const WEEKLY_TARGET_SECONDS = 7 * 24 * 3600;
const WEEKLY_MAX_SECONDS = 8 * 24 * 3600;

const LOCAL_RPC_PREFIX = "/exa.language_server_pb.LanguageServerService";
const LOCAL_RPC_METADATA = {
  metadata: {
    ideName: "antigravity",
    extensionName: "antigravity",
    locale: "en",
  },
};

const CLOUD_CODE_BASE = "https://cloudcode-pa.googleapis.com";
const DAILY_CLOUD_CODE_BASE = "https://daily-cloudcode-pa.googleapis.com";

type BunFetchInit = RequestInit & {
  tls?: {
    rejectUnauthorized?: boolean;
  };
};

export interface AntigravityCommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AntigravityProcessInfo {
  pid: number;
  kind: "language_server" | "agy";
  command: string;
  csrfToken: string | null;
  extensionServerPort: number | null;
  extensionServerCsrfToken: string | null;
}

export interface AntigravityOauthCredential {
  accessToken: string;
  expiresAt: number | null;
  email: string | null;
  projectId: string | null;
  sourcePath: string;
}

export type AntigravityCredentialResult =
  | { ok: true; credential: AntigravityOauthCredential }
  | { ok: false; error: string };

export type LoopbackHost = "127.0.0.1" | "[::1]";

export interface ListeningEndpoint {
  host: LoopbackHost;
  port: number;
}

export interface AntigravityCollectorDependencies {
  request?: typeof globalThis.fetch;
  now?: () => number;
  runCommand?: (argv: string[], timeoutMs: number) => Promise<AntigravityCommandOutput>;
  readOauthCredentials?: () => Promise<AntigravityCredentialResult>;
  env?: Record<string, string | undefined>;
  readFileText?: (path: string) => Promise<string | null>;
  homedir?: () => string;
  arch?: string;
  localProbeBudgetMs?: number;
  cloudApiBudgetMs?: number;
}

interface QuotaSummaryRemainingPayload {
  remainingFraction?: number | null;
  case?: string | null;
  value?: number | null;
}

interface QuotaSummaryWindowPayload {
  duration?: number | string | null;
  durationSeconds?: number | string | null;
  seconds?: number | string | null;
  displayName?: string | null;
  name?: string | null;
  type?: string | null;
}

export interface QuotaSummaryBucketPayload {
  bucketId?: string | null;
  id?: string | null;
  displayName?: string | null;
  name?: string | null;
  description?: string | null;
  disabled?: boolean | null;
  remainingFraction?: number | null;
  remaining?: QuotaSummaryRemainingPayload | null;
  resetTime?: unknown;
  window?: string | QuotaSummaryWindowPayload | null;
}

export interface QuotaSummaryGroupPayload {
  displayName?: string | null;
  name?: string | null;
  description?: string | null;
  buckets?: QuotaSummaryBucketPayload[] | null;
}

export interface QuotaSummaryPayload {
  code?: string | number | null;
  message?: string | null;
  response?: QuotaSummaryPayload | null;
  summary?: QuotaSummaryPayload | null;
  description?: string | null;
  groups?: QuotaSummaryGroupPayload[] | null;
}

export interface ClientModelConfigPayload {
  label?: string | null;
  disabled?: boolean | null;
  modelOrAlias?: {
    model?: string | null;
    alias?: string | null;
  } | null;
  quotaInfo?: {
    remainingFraction?: number | null;
    resetTime?: unknown;
  } | null;
}

export interface GetUserStatusResponse {
  code?: string | number | null;
  message?: string | null;
  userStatus?: {
    email?: string | null;
    userTier?: {
      id?: string | null;
      name?: string | null;
      description?: string | null;
    } | null;
    planStatus?: {
      planInfo?: {
        planName?: string | null;
        planDisplayName?: string | null;
        displayName?: string | null;
        productName?: string | null;
        planShortName?: string | null;
      } | null;
    } | null;
    cascadeModelConfigData?: {
      clientModelConfigs?: ClientModelConfigPayload[] | null;
    } | null;
  } | null;
}

export interface GetCommandModelConfigsResponse {
  code?: string | number | null;
  message?: string | null;
  clientModelConfigs?: ClientModelConfigPayload[] | null;
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string | { id?: string | null } | null;
  paidTier?: { id?: string | null; name?: string | null } | null;
  currentTier?: { id?: string | null; name?: string | null } | null;
  planInfo?: {
    planType?: string | null;
    planName?: string | null;
    planDisplayName?: string | null;
  } | null;
}

interface FetchAvailableModelsResponse {
  models?: Record<
    string,
    {
      displayName?: string | null;
      label?: string | null;
      disabled?: boolean | null;
      quotaInfo?: {
        remainingFraction?: number | null;
        resetTime?: unknown;
      } | null;
    }
  > | null;
}

interface RetrieveUserQuotaResponse {
  buckets?: Array<{
    modelId?: string | null;
    displayName?: string | null;
    disabled?: boolean | null;
    remainingFraction?: number | null;
    resetTime?: unknown;
  }> | null;
}

interface PlanMetadata {
  planType: string | null;
  rawPlanName: string | null;
  tierId: string | null;
  planSource: string | null;
}

type Cadence = "fiveHour" | "weekly" | "unknown";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseTimestamp(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? Math.round(value * 1000) : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric) || numeric <= 0) return null;
      return numeric < 1e12 ? Math.round(numeric * 1000) : numeric;
    }
    return parseInstant(trimmed);
  }
  if (typeof value === "object") {
    const seconds = (value as { seconds?: unknown }).seconds;
    const nanos = (value as { nanos?: unknown }).nanos;
    const secNum =
      typeof seconds === "number"
        ? seconds
        : typeof seconds === "string" && seconds.trim() !== ""
          ? Number(seconds)
          : NaN;
    if (Number.isFinite(secNum) && secNum > 0) {
      const nanoNum = typeof nanos === "number" && Number.isFinite(nanos) ? nanos : 0;
      return Math.round(secNum * 1000 + nanoNum / 1e6);
    }
  }
  return null;
}

/** Converts a 0..1 remainingFraction into a clamped, finite 0..100 usedPercent rounded to 1 decimal place. */
export function remainingFractionToUsedPercent(value: unknown): number | null {
  const fraction = finiteNumber(value);
  if (fraction === null) return null;
  const clamped = Math.max(0, Math.min(1, fraction));
  const used = Math.round((1 - clamped) * 1000) / 10;
  return used === 0 ? 0 : used;
}

function recognizeAntigravityPlanType(raw: string | null | undefined): string | null {
  const trimmed = nonEmptyString(raw);
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (lower === "ultra" || lower.includes("ai ultra") || lower.includes("g1 ultra")) return "ultra";
  if (lower === "pro" || lower.includes("ai pro") || lower.includes("g1 pro") || lower.includes("ai premium")) {
    return "pro";
  }
  if (lower === "plus" || lower.includes("ai plus") || lower.includes("g1 plus")) return "plus";
  if (lower === "enterprise" || lower.includes("enterprise")) return "enterprise";
  if (lower === "standard" || lower.includes("standard tier") || lower.includes("code assist standard")) {
    return "standard";
  }
  if (lower === "free" || lower === "free tier" || lower === "legacy tier" || lower === "individual") return "free";
  return null;
}

/** Normalizes recognized Google / Antigravity plan or tier names to stable short IDs,
 * preserving unrecognized non-empty names trimmed as-is. */
export function normalizeAntigravityPlanType(raw: string | null | undefined): string | null {
  const trimmed = nonEmptyString(raw);
  if (!trimmed) return null;
  return recognizeAntigravityPlanType(trimmed) ?? trimmed;
}

function extractPlanFromUserStatus(body: GetUserStatusResponse | null | undefined): PlanMetadata {
  const userStatus = body?.userStatus;
  const planInfo = userStatus?.planStatus?.planInfo;
  const userTier = userStatus?.userTier;
  // `userTier` carries the actual subscription tier; `planInfo` can report a
  // generic "Pro" for Ultra accounts, so it is only a fallback.
  const tierName = nonEmptyString(userTier?.name);
  const tierId = nonEmptyString(userTier?.id);
  const planInfoName =
    nonEmptyString(planInfo?.planDisplayName) ??
    nonEmptyString(planInfo?.displayName) ??
    nonEmptyString(planInfo?.planName) ??
    nonEmptyString(planInfo?.productName) ??
    nonEmptyString(planInfo?.planShortName);
  const recognizedTierId = recognizeAntigravityPlanType(tierId);
  const rawPlanName = tierName ?? (recognizedTierId ? tierId : null) ?? planInfoName ?? tierId;
  const planType =
    recognizeAntigravityPlanType(tierName) ??
    recognizedTierId ??
    tierName ??
    normalizeAntigravityPlanType(planInfoName) ??
    tierId;
  return {
    planType,
    rawPlanName,
    tierId,
    planSource: planType || rawPlanName ? "get_user_status" : null,
  };
}

function extractPlanFromLoadCodeAssist(body: LoadCodeAssistResponse | null | undefined): PlanMetadata {
  const paidTierName = nonEmptyString(body?.paidTier?.name);
  const paidTierId = nonEmptyString(body?.paidTier?.id);
  const planInfoName =
    nonEmptyString(body?.planInfo?.planDisplayName) ??
    nonEmptyString(body?.planInfo?.planName) ??
    nonEmptyString(body?.planInfo?.planType);
  const currentTierName = nonEmptyString(body?.currentTier?.name);
  const currentTierId = nonEmptyString(body?.currentTier?.id);

  const recognizedPaidTierId = recognizeAntigravityPlanType(paidTierId);
  const recognizedCurrentTierId = recognizeAntigravityPlanType(currentTierId);

  const rawPlanName =
    paidTierName ??
    (recognizedPaidTierId ? paidTierId : null) ??
    planInfoName ??
    paidTierId ??
    currentTierName ??
    currentTierId;
  const tierId = paidTierId ?? currentTierId;
  const planType =
    recognizeAntigravityPlanType(paidTierName) ??
    recognizedPaidTierId ??
    paidTierName ??
    normalizeAntigravityPlanType(planInfoName) ??
    recognizeAntigravityPlanType(currentTierName) ??
    recognizedCurrentTierId ??
    currentTierName ??
    paidTierId ??
    currentTierId;
  return {
    planType,
    rawPlanName,
    tierId,
    planSource: planType || rawPlanName ? "load_code_assist" : null,
  };
}

function extractProjectId(body: LoadCodeAssistResponse | null | undefined): string | null {
  const raw = body?.cloudaicompanionProject;
  if (typeof raw === "string") return nonEmptyString(raw);
  if (raw && typeof raw === "object") return nonEmptyString(raw.id);
  return null;
}

function extractFlagValue(command: string, flagName: string): string | null {
  const pattern = new RegExp(
    `(?:^|\\s)--${flagName}(?:=(?:"([^"]+)"|'([^']+)'|(\\S+))|\\s+(?:"([^"]+)"|'([^']+)'|(?!--)(\\S+)))`,
  );
  const match = command.match(pattern);
  if (!match) return null;
  return nonEmptyString(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6]);
}

function extractFirstToken(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed;
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed;
  }
  const space = trimmed.search(/\s/);
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

/** Matches an executable basename in `ps` command output and returns the matched
 * executable path, handling quoted paths, plain paths, and unquoted paths containing
 * spaces (e.g. `/Applications/My Apps/.../agy`) without matching arguments passed to
 * unrelated binaries (e.g. `/opt/homebrew/bin/nvim notes/agy`). */
function matchExecutableBasename(command: string, basenamePattern: RegExp): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const firstToken = extractFirstToken(trimmed);
  const firstBase = firstToken.split("/").pop() ?? "";
  if (basenamePattern.test(firstBase)) return firstToken;

  // Unquoted paths with spaces from `ps` start with `/`, `./`, or `../`.
  // If `firstToken` already sits in a `bin`/`sbin` directory (e.g. `/usr/bin/vim`,
  // `/opt/homebrew/bin/nvim`, `~/.bun/bin/bun`), anything after whitespace is an
  // argument, never a spaced continuation of the executable path.
  if (
    (!trimmed.startsWith("/") && !trimmed.startsWith("./") && !trimmed.startsWith("../")) ||
    /(?:^|\/)s?bin\/[^/\s]+$/i.test(firstToken)
  ) {
    return null;
  }

  const slashSegment = /\/([^/\s]+)(?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = slashSegment.exec(trimmed)) !== null) {
    const candidate = match[1]!;
    if (!basenamePattern.test(candidate)) continue;
    const prefix = trimmed.slice(0, match.index);
    // Reject if an earlier token already started arguments (flags, another path, or shell operators).
    if (/\s+(?:-|\/|~\/|\.\.?\/|&&|\|\||[|;<>])/.test(prefix)) {
      return null;
    }
    const candidatePath = `${prefix}/${candidate}`;
    // Only treat an unquoted spaced string as an executable path when it lives in
    // an Applications/app-bundle/Antigravity path rather than an arbitrary tool + file arg.
    if (!/(?:^\/Applications\/|\/Applications\/|\.app\/|antigravity)/i.test(candidatePath)) {
      return null;
    }
    return candidatePath;
  }
  return null;
}

/** Parses `ps -ax -o pid=,command=` output and returns candidate Antigravity processes. */
export function parseAntigravityProcesses(psOutput: string): AntigravityProcessInfo[] {
  const found: AntigravityProcessInfo[] = [];
  const seenPids = new Set<number>();

  for (const rawLine of psOutput.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]!.trim();
    if (!Number.isSafeInteger(pid) || pid <= 0 || seenPids.has(pid)) continue;

    const languageServerPath = matchExecutableBasename(command, /^language_server(?:_[a-z0-9_]+)?$/i);
    const appDataDir = extractFlagValue(command, "app_data_dir");
    const ideName = extractFlagValue(command, "ide_name");
    const isAntigravityServer =
      languageServerPath !== null &&
      (/antigravity/i.test(languageServerPath) ||
        /antigravity/i.test(appDataDir ?? "") ||
        /antigravity/i.test(ideName ?? ""));
    const isAgy = matchExecutableBasename(command, /^agy$/i) !== null;

    if (!isAntigravityServer && !isAgy) continue;
    seenPids.add(pid);

    const csrfToken = extractFlagValue(command, "csrf_token");
    const extPortRaw = extractFlagValue(command, "extension_server_port");
    const extPortNum = extPortRaw ? Number(extPortRaw) : NaN;
    const extensionServerPort =
      Number.isInteger(extPortNum) && extPortNum >= 1 && extPortNum <= 65535 ? extPortNum : null;
    const extensionServerCsrfToken = extractFlagValue(command, "extension_server_csrf_token");

    found.push({
      pid,
      kind: isAntigravityServer ? "language_server" : "agy",
      command,
      csrfToken,
      extensionServerPort,
      extensionServerCsrfToken,
    });
  }

  // Prefer language_server with CSRF token first, then other language_server, then agy.
  found.sort((a, b) => {
    const score = (p: AntigravityProcessInfo) =>
      (p.kind === "language_server" ? 2 : 0) + (p.csrfToken ? 1 : 0);
    return score(b) - score(a);
  });

  return found;
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` output for loopback/wildcard TCP
 * listening endpoints, preserving `127.0.0.1` vs `[::1]` while deduplicating by port
 * (preferring `127.0.0.1` when a dual-stack process binds both on the same port). */
export function parseListeningEndpoints(lsofOutput: string): ListeningEndpoint[] {
  const endpoints: ListeningEndpoint[] = [];
  const indexByPort = new Map<number, number>();
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/(127\.0\.0\.1|\[::1\]|localhost|\*):(\d+)\s+\(LISTEN\)/i);
    if (!match) continue;
    const rawHost = match[1]!.toLowerCase();
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const host: LoopbackHost =
      rawHost === "[::1]" || (rawHost === "*" && /\bIPv6\b/i.test(line)) ? "[::1]" : "127.0.0.1";
    const existingIdx = indexByPort.get(port);
    if (existingIdx === undefined) {
      indexByPort.set(port, endpoints.length);
      endpoints.push({ host, port });
    } else if (endpoints[existingIdx]!.host === "[::1]" && host === "127.0.0.1") {
      endpoints[existingIdx] = { host, port };
    }
  }
  return endpoints;
}

function parseDurationSeconds(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)s?$/i);
    if (!match) return null;
    const numeric = Number(match[1]);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }
  return null;
}

function formatDurationLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function matchCadenceText(parts: string[]): Cadence {
  if (parts.length === 0) return "unknown";
  // Normalize underscores/hyphens to spaces so identifiers like `gemini_5h` or
  // `QUOTA_WINDOW_WEEKLY` match `\b` word boundaries cleanly.
  const combined = parts.join(" ").replace(/[_-]+/g, " ");
  const matchesFiveHour = /\b(?:5\s*h(?:our|r)?s?|five\s+hour|session|short\s+term|rolling\s+5)\b/i.test(combined);
  const matchesWeekly = /\b(?:7\s*d(?:ay)?s?|week(?:ly)?|seven\s+day)\b/i.test(combined);
  if (matchesFiveHour && !matchesWeekly) return "fiveHour";
  if (matchesWeekly && !matchesFiveHour) return "weekly";
  return "unknown";
}

function classifyBucketCadence(
  bucket: QuotaSummaryBucketPayload,
): { cadence: Cadence; durationSeconds: number | null } {
  const structuredParts: string[] = [];
  let explicitDuration: number | null = null;

  if (typeof bucket.window === "string") {
    explicitDuration = parseDurationSeconds(bucket.window);
    if (explicitDuration === null) {
      structuredParts.push(bucket.window);
    }
  } else if (bucket.window && typeof bucket.window === "object") {
    explicitDuration =
      parseDurationSeconds(bucket.window.durationSeconds) ??
      parseDurationSeconds(bucket.window.seconds) ??
      parseDurationSeconds(bucket.window.duration);
    for (const field of [bucket.window.displayName, bucket.window.name, bucket.window.type]) {
      const s = nonEmptyString(field);
      if (s) structuredParts.push(s);
    }
  }

  // When an explicit duration is reported, match strictly to supported 5h (4h-6h)
  // or weekly (6d-8d) bands so short (e.g. 60s, 3600s) or monthly (20d) buckets
  // stay honestly in `modelWindows` rather than taking the 5h/weekly slot.
  if (explicitDuration !== null) {
    if (explicitDuration >= FIVE_HOUR_MIN_SECONDS && explicitDuration <= FIVE_HOUR_MAX_SECONDS) {
      return { cadence: "fiveHour", durationSeconds: explicitDuration };
    }
    if (explicitDuration >= WEEKLY_MIN_SECONDS && explicitDuration <= WEEKLY_MAX_SECONDS) {
      return { cadence: "weekly", durationSeconds: explicitDuration };
    }
    return { cadence: "unknown", durationSeconds: explicitDuration };
  }

  for (const field of [bucket.bucketId, bucket.id, bucket.displayName, bucket.name]) {
    const s = nonEmptyString(field);
    if (s) structuredParts.push(s);
  }
  const fromStructured = matchCadenceText(structuredParts);
  if (fromStructured !== "unknown") {
    return { cadence: fromStructured, durationSeconds: null };
  }

  const description = nonEmptyString(bucket.description);
  if (description) {
    return { cadence: matchCadenceText([description]), durationSeconds: null };
  }
  return { cadence: "unknown", durationSeconds: null };
}

function extractBucketRemainingFraction(bucket: QuotaSummaryBucketPayload): number | null {
  const direct = finiteNumber(bucket.remainingFraction);
  if (direct !== null) return direct;
  const nested = finiteNumber(bucket.remaining?.remainingFraction);
  if (nested !== null) return nested;
  if (bucket.remaining?.case === "remainingFraction") {
    return finiteNumber(bucket.remaining.value);
  }
  return null;
}

function isPartnerGroupName(name: string): boolean {
  return /\b(?:claude|anthropic|gpt|openai|oss)\b/i.test(name) && !/\bgemini\b/i.test(name);
}

function primaryGeminiGroupScore(groupName: string, hasFiveHour: boolean, hasWeekly: boolean): number {
  const trimmed = groupName.trim();
  if (trimmed && isPartnerGroupName(trimmed)) return -1;
  const cadenceBonus = (hasFiveHour ? 2 : 0) + (hasWeekly ? 2 : 0);
  if (!trimmed || /^(?:default|all(?:\s+models)?|general|primary)$/i.test(trimmed)) {
    return 90 + cadenceBonus;
  }
  if (/^(?:google\s+)?gemini(?:\s+(?:models?|all|default|general|shared|core|pool|quota))?$/i.test(trimmed)) {
    return 100 + cadenceBonus;
  }
  // Versioned or model-specific groups (e.g. "Gemini 4 Argon", "Gemini 4 Neon",
  // "Gemini 3 Pro") must remain in `modelWindows` rather than populating shared
  // `fiveHour`/`weekly` slots.
  return -1;
}

function isGenericBucketLabel(label: string, groupLabel: string): boolean {
  const lower = label.trim().toLowerCase();
  if (!lower) return true;
  if (lower === groupLabel.trim().toLowerCase()) return true;
  // Bare duration tags (e.g. "60s", "1h", "20d") are qualifiers, not model names.
  if (/^\d+(?:\.\d+)?[smhd]$/.test(lower)) return true;
  // Generic cadence/quota phrases (e.g. "Weekly quota", "5-hour session",
  // "Session limit") must not drop the enclosing group's model identity.
  const normalized = lower.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return /^(?:(?:5\s*h(?:our|r)?s?|five\s+hour|session|short\s+term|rolling\s+5h?|weekly|week|7\s*d(?:ay)?s?|seven\s+day|primary|secondary|default|standard|shared|core|pool|bucket|quota|limit|window)\s*)+$/.test(
    normalized,
  );
}

function labelContainsGroup(label: string, groupLabel: string): boolean {
  const normLabel = label.toLowerCase().replace(/[-_\s]+/g, " ").trim();
  const normGroup = groupLabel.toLowerCase().replace(/[-_\s]+/g, " ").trim();
  if (!normGroup) return false;
  return normLabel === normGroup || normLabel.includes(normGroup);
}

function formatModelWindowKey(
  groupLabel: string,
  bucketLabel: string | null,
  cadence: Cadence,
  durationSeconds: number | null,
  groupBucketCount: number,
  isPrimaryGroup: boolean,
): string {
  const cadenceSuffix = cadence === "fiveHour" ? "5h" : cadence === "weekly" ? "weekly" : null;
  const durationSuffix =
    cadence === "unknown" && durationSeconds !== null ? formatDurationLabel(durationSeconds) : null;

  if (!isPrimaryGroup) {
    // Non-primary groups represent a distinct model or pool (e.g. "Gemini 4 Argon",
    // "Gemini 4 Neon", "Claude / GPT"). Never drop the group identity.
    const bucketIsSpecific = bucketLabel !== null && !isGenericBucketLabel(bucketLabel, groupLabel);
    const baseLabel =
      bucketIsSpecific && labelContainsGroup(bucketLabel, groupLabel) ? bucketLabel : groupLabel;
    const qualifier =
      cadenceSuffix ??
      (bucketIsSpecific && !labelContainsGroup(bucketLabel, groupLabel)
        ? bucketLabel
        : durationSuffix);

    if (qualifier) {
      const alreadyTagged =
        (cadence === "fiveHour" && /\b5h\b|\b5[\s-]*hour/i.test(baseLabel)) ||
        (cadence === "weekly" && /\bweekly\b|\b7d\b/i.test(baseLabel)) ||
        baseLabel.toLowerCase().includes(`(${qualifier.toLowerCase()})`);
      if (!alreadyTagged) {
        return `${baseLabel} (${qualifier})`;
      }
    }
    return baseLabel;
  }

  // Leftover buckets inside the shared primary group (e.g. "rpm", "1h",
  // "monthly_cap", "Gemini Pro", or a second 5h/weekly bucket).
  const hasSpecificLabel = bucketLabel !== null && !isGenericBucketLabel(bucketLabel, groupLabel);
  const baseLabel = hasSpecificLabel ? bucketLabel : (durationSuffix ?? groupLabel);
  if (cadenceSuffix) {
    const alreadyTagged =
      (cadence === "fiveHour" && /\b5h\b|\b5[\s-]*hour/i.test(baseLabel)) ||
      (cadence === "weekly" && /\bweekly\b|\b7d\b/i.test(baseLabel));
    if (!alreadyTagged && (groupBucketCount > 1 || baseLabel === groupLabel)) {
      return `${baseLabel} (${cadenceSuffix})`;
    }
  }
  if (
    groupBucketCount > 1 &&
    bucketLabel &&
    bucketLabel !== baseLabel &&
    !isGenericBucketLabel(bucketLabel, groupLabel)
  ) {
    return `${baseLabel} (${bucketLabel})`;
  }
  return baseLabel;
}

function insertModelWindow(
  target: Record<string, WindowQuota>,
  key: string,
  quota: WindowQuota,
): void {
  const existing = target[key];
  if (!existing) {
    target[key] = quota;
    return;
  }
  // Keep the tighter constraint when two entries collapse onto the exact same label.
  if (quota.usedPercent > existing.usedPercent) {
    target[key] = quota;
  }
}

function hasQuotaData(snapshot: WindowSnapshot): boolean {
  return (
    snapshot.fiveHour !== null ||
    snapshot.weekly !== null ||
    (snapshot.modelWindows != null && Object.keys(snapshot.modelWindows).length > 0)
  );
}

function buildExtra(
  plan: PlanMetadata | null | undefined,
  endpoint: string,
  extraFields: Record<string, unknown> = {},
): Record<string, unknown> {
  const validPlan = plan && typeof plan === "object" ? plan : null;
  return {
    ...(validPlan?.planType ? { planType: validPlan.planType } : {}),
    ...(validPlan?.planSource ? { planSource: validPlan.planSource } : {}),
    ...(validPlan?.rawPlanName ? { rawPlanName: validPlan.rawPlanName } : {}),
    ...(validPlan?.tierId ? { tierId: validPlan.tierId } : {}),
    endpoint,
    ...extraFields,
  };
}

/** Normalizes a structured `RetrieveUserQuotaSummary` payload into a `WindowSnapshot`. */
export function normalizeQuotaSummary(
  rawPayload: QuotaSummaryPayload,
  plan?: PlanMetadata | null,
  endpoint = "RetrieveUserQuotaSummary",
): WindowSnapshot | null {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return null;
  const payload = rawPayload.response ?? rawPayload.summary ?? rawPayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const rawGroups = Array.isArray(payload.groups) ? payload.groups : [];
  if (rawGroups.length === 0) return null;

  interface ParsedBucket {
    quota: WindowQuota;
    cadence: Cadence;
    durationSeconds: number | null;
    label: string | null;
    id: string | null;
  }

  interface ParsedGroup {
    label: string;
    buckets: ParsedBucket[];
    score: number;
  }

  const parsedGroups: ParsedGroup[] = [];
  for (const group of rawGroups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const rawBuckets = Array.isArray(group.buckets) ? group.buckets : [];
    const groupLabel = nonEmptyString(group.displayName) ?? nonEmptyString(group.name) ?? "";
    const parsedBuckets: ParsedBucket[] = [];
    for (const bucket of rawBuckets) {
      if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
      if (bucket.disabled === true) continue;
      const usedPercent = remainingFractionToUsedPercent(extractBucketRemainingFraction(bucket));
      if (usedPercent === null) continue;
      const resetsAt = parseTimestamp(bucket.resetTime);
      const { cadence, durationSeconds } = classifyBucketCadence(bucket);
      const label = nonEmptyString(bucket.displayName) ?? nonEmptyString(bucket.name);
      const id = nonEmptyString(bucket.bucketId) ?? nonEmptyString(bucket.id);
      parsedBuckets.push({
        quota: { usedPercent, resetsAt },
        cadence,
        durationSeconds,
        label,
        id,
      });
    }
    if (parsedBuckets.length === 0) continue;
    const hasFiveHour = parsedBuckets.some((b) => b.cadence === "fiveHour");
    const hasWeekly = parsedBuckets.some((b) => b.cadence === "weekly");
    parsedGroups.push({
      label: groupLabel,
      buckets: parsedBuckets,
      score: primaryGeminiGroupScore(groupLabel, hasFiveHour, hasWeekly),
    });
  }

  if (parsedGroups.length === 0) return null;

  // Pick the highest-scoring primary Gemini group (preserve array order on ties).
  let primaryIndex = -1;
  let bestScore = -1;
  for (let i = 0; i < parsedGroups.length; i++) {
    const group = parsedGroups[i]!;
    if (group.score > bestScore) {
      bestScore = group.score;
      primaryIndex = i;
    }
  }

  let fiveHour: WindowQuota | null = null;
  let weekly: WindowQuota | null = null;
  const modelWindows: Record<string, WindowQuota> = {};

  const pickBestBucketIndex = (
    buckets: ParsedBucket[],
    cadence: "fiveHour" | "weekly",
    targetSeconds: number,
  ): number => {
    let bestIdx = -1;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let j = 0; j < buckets.length; j++) {
      const bucket = buckets[j]!;
      if (bucket.cadence !== cadence) continue;
      const diff = bucket.durationSeconds !== null
        ? Math.abs(bucket.durationSeconds - targetSeconds)
        : Number.POSITIVE_INFINITY;
      if (bestIdx === -1 || diff < bestDiff) {
        bestIdx = j;
        bestDiff = diff;
      }
    }
    return bestIdx;
  };

  const fallbackBucketLabel = (
    bucket: ParsedBucket,
    groupBucketCount: number,
    isPrimaryGroup: boolean,
  ): string | null => {
    if (bucket.label) return bucket.label;
    if (bucket.cadence === "unknown") {
      if (isPrimaryGroup || groupBucketCount > 1) {
        return bucket.id ?? (bucket.durationSeconds !== null ? formatDurationLabel(bucket.durationSeconds) : null);
      }
      return bucket.durationSeconds !== null ? formatDurationLabel(bucket.durationSeconds) : null;
    }
    return null;
  };

  for (let i = 0; i < parsedGroups.length; i++) {
    const group = parsedGroups[i]!;
    const displayGroupLabel = group.label || "Antigravity";
    if (i === primaryIndex) {
      const bestFiveHourIdx = pickBestBucketIndex(group.buckets, "fiveHour", FIVE_HOUR_TARGET_SECONDS);
      const bestWeeklyIdx = pickBestBucketIndex(group.buckets, "weekly", WEEKLY_TARGET_SECONDS);
      if (bestFiveHourIdx >= 0) fiveHour = group.buckets[bestFiveHourIdx]!.quota;
      if (bestWeeklyIdx >= 0) weekly = group.buckets[bestWeeklyIdx]!.quota;

      for (let j = 0; j < group.buckets.length; j++) {
        if (j === bestFiveHourIdx || j === bestWeeklyIdx) continue;
        const bucket = group.buckets[j]!;
        const key = formatModelWindowKey(
          displayGroupLabel,
          fallbackBucketLabel(bucket, group.buckets.length, true),
          bucket.cadence,
          bucket.durationSeconds,
          group.buckets.length,
          true,
        );
        insertModelWindow(modelWindows, key, bucket.quota);
      }
      continue;
    }
    for (const bucket of group.buckets) {
      const key = formatModelWindowKey(
        displayGroupLabel,
        fallbackBucketLabel(bucket, group.buckets.length, false),
        bucket.cadence,
        bucket.durationSeconds,
        group.buckets.length,
        false,
      );
      insertModelWindow(modelWindows, key, bucket.quota);
    }
  }

  const snapshot: WindowSnapshot = {
    kind: "window",
    fiveHour,
    weekly,
    modelWindows,
    extra: buildExtra(plan, endpoint),
  };
  return hasQuotaData(snapshot) ? snapshot : null;
}

interface NormalizedModelEntry {
  modelId: string;
  label: string;
  quota: WindowQuota;
}

function prettifyModelId(modelId: string): string {
  const cleaned = modelId.replace(/^models\//i, "").trim();
  if (!cleaned) return "Model";
  return cleaned
    .split(/[-_]+/)
    .map((part) => {
      if (!part) return "";
      if (/^(?:gpt|oss|pro|flash|max)$/i.test(part)) {
        return part.toLowerCase() === "gpt" || part.toLowerCase() === "oss"
          ? part.toUpperCase()
          : part[0]!.toUpperCase() + part.slice(1).toLowerCase();
      }
      return part[0]!.toUpperCase() + part.slice(1);
    })
    .join(" ");
}

/** Per-model fallback endpoints (`GetUserStatus`, `GetCommandModelConfigs`,
 * `fetchAvailableModels`, `retrieveUserQuota`) carry no window-duration metadata
 * and no shared-pool distinction. Keep every model bucket stably in `modelWindows`
 * so buckets never jump between `weekly` and `modelWindows` mid-cycle and one
 * model's headroom is never mistaken for another model's account-wide quota. */
function normalizeModelEntries(
  entries: NormalizedModelEntry[],
  plan: PlanMetadata | null | undefined,
  endpoint: string,
): WindowSnapshot | null {
  if (entries.length === 0) return null;

  const modelWindows: Record<string, WindowQuota> = {};
  const modelWindowIds: Record<string, string> = {};
  for (const entry of entries) {
    const existing = modelWindows[entry.label];
    insertModelWindow(modelWindows, entry.label, entry.quota);
    if (entry.modelId && (!existing || entry.quota.usedPercent > existing.usedPercent)) {
      modelWindowIds[entry.label] = entry.modelId;
    }
  }

  const extraFields: Record<string, unknown> =
    Object.keys(modelWindowIds).length > 0 ? { modelWindowIds } : {};

  const snapshot: WindowSnapshot = {
    kind: "window",
    fiveHour: null,
    weekly: null,
    modelWindows,
    extra: buildExtra(plan, endpoint, extraFields),
  };
  return hasQuotaData(snapshot) ? snapshot : null;
}

/** Normalizes `GetUserStatus` / `GetCommandModelConfigs` `clientModelConfigs[]` into a `WindowSnapshot`. */
export function normalizeModelConfigs(
  configs: ClientModelConfigPayload[] | null | undefined,
  plan?: PlanMetadata | null,
  endpoint = "GetUserStatus",
): WindowSnapshot | null {
  if (!Array.isArray(configs)) return null;
  const entries: NormalizedModelEntry[] = [];
  for (const cfg of configs) {
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || cfg.disabled === true) continue;
    const usedPercent = remainingFractionToUsedPercent(cfg.quotaInfo?.remainingFraction);
    if (usedPercent === null) continue;
    const resetsAt = parseTimestamp(cfg.quotaInfo?.resetTime);
    const modelId = nonEmptyString(cfg.modelOrAlias?.model) ?? nonEmptyString(cfg.modelOrAlias?.alias) ?? "";
    const label = nonEmptyString(cfg.label) ?? prettifyModelId(modelId);
    entries.push({
      modelId,
      label,
      quota: { usedPercent, resetsAt },
    });
  }
  return normalizeModelEntries(entries, plan, endpoint);
}

/** Normalizes Cloud Code `fetchAvailableModels` response into a `WindowSnapshot`. */
export function normalizeAvailableModels(
  body: FetchAvailableModelsResponse | null | undefined,
  plan?: PlanMetadata | null,
): WindowSnapshot | null {
  const models = body?.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return null;
  const entries: NormalizedModelEntry[] = [];
  for (const [modelId, info] of Object.entries(models)) {
    if (!info || typeof info !== "object" || Array.isArray(info) || info.disabled === true) continue;
    const usedPercent = remainingFractionToUsedPercent(info.quotaInfo?.remainingFraction);
    if (usedPercent === null) continue;
    const resetsAt = parseTimestamp(info.quotaInfo?.resetTime);
    const label = nonEmptyString(info.displayName) ?? nonEmptyString(info.label) ?? prettifyModelId(modelId);
    entries.push({
      modelId,
      label,
      quota: { usedPercent, resetsAt },
    });
  }
  return normalizeModelEntries(entries, plan, "fetchAvailableModels");
}

/** Normalizes Cloud Code `retrieveUserQuota` buckets into a `WindowSnapshot`. */
export function normalizeCloudQuotaBuckets(
  body: RetrieveUserQuotaResponse | null | undefined,
  plan?: PlanMetadata | null,
): WindowSnapshot | null {
  if (!Array.isArray(body?.buckets)) return null;
  const entries: NormalizedModelEntry[] = [];
  for (const bucket of body.buckets) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket) || bucket.disabled === true) continue;
    const usedPercent = remainingFractionToUsedPercent(bucket.remainingFraction);
    if (usedPercent === null) continue;
    const resetsAt = parseTimestamp(bucket.resetTime);
    const modelId = nonEmptyString(bucket.modelId) ?? "";
    const label = nonEmptyString(bucket.displayName) ?? prettifyModelId(modelId);
    entries.push({
      modelId,
      label,
      quota: { usedPercent, resetsAt },
    });
  }
  return normalizeModelEntries(entries, plan, "retrieveUserQuota");
}

/** Parses OAuth credential JSON from env var or disk (read-only). */
export function parseAntigravityOauthCredentials(
  rawText: string,
  sourcePath: string,
): AntigravityCredentialResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: `Antigravity credentials at ${sourcePath} are not valid JSON` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `Antigravity credentials at ${sourcePath} must be a JSON object` };
  }
  const root = parsed as Record<string, unknown>;
  const tokenObj = root.token && typeof root.token === "object" ? (root.token as Record<string, unknown>) : null;

  const accessToken =
    nonEmptyString(tokenObj?.access_token) ??
    nonEmptyString(tokenObj?.accessToken) ??
    nonEmptyString(root.access_token) ??
    nonEmptyString(root.accessToken);

  if (!accessToken) {
    return { ok: false, error: `Antigravity credentials at ${sourcePath} have no access_token` };
  }

  const rawExpiry =
    tokenObj?.expiry ??
    tokenObj?.expiry_date ??
    tokenObj?.expiryDate ??
    tokenObj?.expires_at ??
    tokenObj?.expiresAt ??
    root.expiry ??
    root.expiry_date ??
    root.expiryDate ??
    root.expires_at ??
    root.expiresAt;

  const expiresAt = parseTimestamp(rawExpiry);
  const email = nonEmptyString(root.email) ?? nonEmptyString(tokenObj?.email);
  const projectId =
    nonEmptyString(root.project_id) ??
    nonEmptyString(root.projectId) ??
    nonEmptyString(tokenObj?.project_id) ??
    nonEmptyString(tokenObj?.projectId);

  return {
    ok: true,
    credential: {
      accessToken,
      expiresAt,
      email,
      projectId,
      sourcePath,
    },
  };
}

async function defaultReadFileText(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return await file.text();
  } catch {
    return null;
  }
}

async function readDefaultOauthCredentials(
  env: Record<string, string | undefined>,
  readFileText: (path: string) => Promise<string | null>,
  getHome: () => string,
  now: number,
): Promise<AntigravityCredentialResult> {
  const inlineJson = nonEmptyString(env.ANTIGRAVITY_OAUTH_CREDENTIALS_JSON);
  if (inlineJson) {
    return parseAntigravityOauthCredentials(inlineJson, "ANTIGRAVITY_OAUTH_CREDENTIALS_JSON");
  }

  const explicitPath = nonEmptyString(env.QUOTA_ANTIGRAVITY_AUTH_PATH);
  if (explicitPath) {
    const text = await readFileText(explicitPath);
    if (text === null) {
      return { ok: false, error: `QUOTA_ANTIGRAVITY_AUTH_PATH file not found or unreadable: ${explicitPath}` };
    }
    return parseAntigravityOauthCredentials(text, explicitPath);
  }

  const home = getHome();
  const candidatePaths = [
    join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    join(home, ".gemini", "oauth_creds.json"),
    join(home, ".codexbar", "antigravity", "oauth_creds.json"),
  ];

  let firstExpired: AntigravityCredentialResult | null = null;
  let lastParseError: string | null = null;

  for (const path of candidatePaths) {
    const text = await readFileText(path);
    if (text === null) continue;
    const parsed = parseAntigravityOauthCredentials(text, path);
    if (!parsed.ok) {
      lastParseError = parsed.error;
      continue;
    }
    const isExpired = parsed.credential.expiresAt !== null && parsed.credential.expiresAt <= now;
    if (!isExpired) return parsed;
    if (!firstExpired) firstExpired = parsed;
  }

  if (firstExpired) return firstExpired;
  if (lastParseError) return { ok: false, error: lastParseError };
  return {
    ok: false,
    error: "no Antigravity OAuth credentials found in env or local credential paths",
  };
}

async function defaultRunCommand(argv: string[], timeoutMs: number): Promise<AntigravityCommandOutput> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore kill races
        }
        resolve("timeout");
      }, timeoutMs);
    });
    const completed = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
    // Prevent an unhandled rejection if killing the process after timeout aborts stream reads.
    completed.catch(() => undefined);

    const outcome = await Promise.race([completed, timedOut]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") {
      return { exitCode: 124, stdout: "", stderr: `${argv[0]} timed out after ${timeoutMs}ms` };
    }
    return outcome;
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

function isRpcErrorCode(code: unknown): boolean {
  if (code == null || code === 0) return false;
  if (typeof code === "string") {
    const normalized = code.trim().toLowerCase();
    return normalized !== "" && normalized !== "ok" && normalized !== "0";
  }
  return true;
}

async function postLoopbackRpc(
  request: typeof globalThis.fetch,
  scheme: "https" | "http",
  host: LoopbackHost,
  port: number,
  method: string,
  csrfToken: string | null,
  deadline: number,
): Promise<{ ok: true; status: number; body: Record<string, unknown> } | { ok: false; transportError: boolean; error: string }> {
  const timeoutMs = Math.min(LOCAL_FETCH_TIMEOUT_MS, deadline - Date.now());
  if (timeoutMs <= 0) {
    return { ok: false, transportError: true, error: `${method}: local probe budget exhausted` };
  }
  const url = `${scheme}://${host}:${port}${LOCAL_RPC_PREFIX}/${method}`;
  const parsed = new URL(url);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
  };
  if (csrfToken) headers["X-Codeium-Csrf-Token"] = csrfToken;

  const init: BunFetchInit = {
    method: "POST",
    headers,
    body: JSON.stringify(LOCAL_RPC_METADATA),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  };
  // Scope self-signed TLS acceptance strictly to loopback HTTPS (127.0.0.1 / [::1]).
  const isLoopbackHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
  if (parsed.protocol === "https:" && isLoopbackHost) {
    init.tls = { rejectUnauthorized: false };
  }

  let res: Response;
  try {
    res = await request(url, init);
  } catch (err) {
    return {
      ok: false,
      transportError: true,
      error: `${method}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    // Go's net/http TLS server replies HTTP 400 ("Client sent an HTTP request to an HTTPS server")
    // when probed with plain HTTP; allow scheme fallback from HTTP to HTTPS on 400.
    const schemeMismatch = scheme === "http" && res.status === 400;
    return { ok: false, transportError: schemeMismatch, error: `${method} HTTP ${res.status}` };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    return {
      ok: false,
      transportError: false,
      error: `${method} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, transportError: false, error: `${method} returned non-object JSON` };
  }
  return { ok: true, status: res.status, body: json as Record<string, unknown> };
}

async function queryLocalTarget(
  request: typeof globalThis.fetch,
  scheme: "https" | "http",
  host: LoopbackHost,
  port: number,
  csrfToken: string | null,
  deadline: number,
): Promise<{ snapshot: WindowSnapshot | null; transportError: boolean; error: string | null }> {
  const summaryRes = await postLoopbackRpc(request, scheme, host, port, "RetrieveUserQuotaSummary", csrfToken, deadline);
  if (!summaryRes.ok && summaryRes.transportError) {
    return { snapshot: null, transportError: true, error: summaryRes.error };
  }

  if (summaryRes.ok) {
    const payload = summaryRes.body as QuotaSummaryPayload;
    if (!isRpcErrorCode(payload.code)) {
      let plan: PlanMetadata | null = null;
      const baseSnapshot = normalizeQuotaSummary(payload, null, "RetrieveUserQuotaSummary");
      if (baseSnapshot) {
        // Enrich plan/tier from GetUserStatus on the same working loopback target (best-effort).
        const statusRes = await postLoopbackRpc(request, scheme, host, port, "GetUserStatus", csrfToken, deadline);
        if (statusRes.ok && !isRpcErrorCode((statusRes.body as GetUserStatusResponse).code)) {
          plan = extractPlanFromUserStatus(statusRes.body as GetUserStatusResponse);
        }
        return {
          snapshot: {
            ...baseSnapshot,
            extra: buildExtra(plan, "RetrieveUserQuotaSummary", { loopbackHost: host }),
          },
          transportError: false,
          error: null,
        };
      }
    }
  }

  // Fallback 1: GetUserStatus (also captures plan metadata for GetCommandModelConfigs fallback).
  let planFromStatus: PlanMetadata | null = null;
  let lastError = summaryRes.ok ? "RetrieveUserQuotaSummary returned no usable quota groups" : summaryRes.error;

  const statusRes = await postLoopbackRpc(request, scheme, host, port, "GetUserStatus", csrfToken, deadline);
  if (statusRes.ok) {
    const statusBody = statusRes.body as GetUserStatusResponse;
    if (!isRpcErrorCode(statusBody.code)) {
      planFromStatus = extractPlanFromUserStatus(statusBody);
      const configs = statusBody.userStatus?.cascadeModelConfigData?.clientModelConfigs;
      const snapshot = normalizeModelConfigs(configs, planFromStatus, "GetUserStatus");
      if (snapshot) {
        return {
          snapshot: { ...snapshot, extra: { ...snapshot.extra, loopbackHost: host } },
          transportError: false,
          error: null,
        };
      }
    }
    lastError = nonEmptyString(statusBody.message) ?? "GetUserStatus returned no usable model quotas";
  } else {
    lastError = statusRes.error;
  }

  // Fallback 2: GetCommandModelConfigs.
  const cmdRes = await postLoopbackRpc(request, scheme, host, port, "GetCommandModelConfigs", csrfToken, deadline);
  if (cmdRes.ok) {
    const cmdBody = cmdRes.body as GetCommandModelConfigsResponse;
    if (!isRpcErrorCode(cmdBody.code)) {
      const snapshot = normalizeModelConfigs(
        cmdBody.clientModelConfigs,
        planFromStatus,
        "GetCommandModelConfigs",
      );
      if (snapshot) {
        return {
          snapshot: { ...snapshot, extra: { ...snapshot.extra, loopbackHost: host } },
          transportError: false,
          error: null,
        };
      }
    }
    lastError = nonEmptyString(cmdBody.message) ?? "GetCommandModelConfigs returned no usable model quotas";
  } else {
    lastError = cmdRes.error;
  }

  return { snapshot: null, transportError: false, error: lastError };
}

async function collectFromLocalServer(
  request: typeof globalThis.fetch,
  runCommand: (argv: string[], timeoutMs: number) => Promise<AntigravityCommandOutput>,
  capturedAt: number,
  budgetMs: number,
): Promise<{ found: boolean; result: CollectorResult | null; error: string | null }> {
  const deadline = Date.now() + budgetMs;
  const remainingMs = () => deadline - Date.now();
  const budgetError = `local Antigravity probe exceeded its ${budgetMs}ms budget`;
  const ps = await runCommand(["ps", "-ax", "-o", "pid=,command="], Math.min(SUBPROCESS_TIMEOUT_MS, budgetMs));
  if (ps.exitCode !== 0) {
    return { found: false, result: null, error: `ps failed: ${ps.stderr.trim() || `exit ${ps.exitCode}`}` };
  }
  const processes = parseAntigravityProcesses(ps.stdout);
  if (processes.length === 0) {
    return { found: false, result: null, error: "no running Antigravity language_server or agy process found" };
  }

  let lastError: string | null = null;
  probe: for (const proc of processes) {
    if (remainingMs() <= 0) {
      lastError = budgetError;
      break;
    }
    const lsof = await runCommand(
      ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(proc.pid)],
      Math.min(SUBPROCESS_TIMEOUT_MS, remainingMs()),
    );
    if (remainingMs() <= 0) {
      lastError = budgetError;
      break;
    }
    const lsofEndpoints = lsof.exitCode === 0 ? parseListeningEndpoints(lsof.stdout) : [];

    interface LocalTarget {
      host: LoopbackHost;
      port: number;
      schemes: Array<"https" | "http">;
      csrfToken: string | null;
    }

    const targets: LocalTarget[] = [];
    const seenPorts = new Set<number>();

    // Try non-extension listening ports first (HTTPS with self-signed loopback cert, then HTTP fallback).
    for (const endpoint of lsofEndpoints) {
      if (endpoint.port === proc.extensionServerPort) continue;
      seenPorts.add(endpoint.port);
      targets.push({
        host: endpoint.host,
        port: endpoint.port,
        schemes: ["https", "http"],
        csrfToken: proc.csrfToken,
      });
    }

    // Try extension server port (HTTP first, then HTTPS fallback), preserving IPv6 host if lsof saw it.
    if (proc.extensionServerPort !== null && !seenPorts.has(proc.extensionServerPort)) {
      const extEndpoint = lsofEndpoints.find((endpoint) => endpoint.port === proc.extensionServerPort);
      targets.push({
        host: extEndpoint?.host ?? "127.0.0.1",
        port: proc.extensionServerPort,
        schemes: ["http", "https"],
        csrfToken: proc.extensionServerCsrfToken ?? proc.csrfToken,
      });
    }

    if (targets.length === 0) {
      lastError = `Antigravity pid ${proc.pid} has no listening loopback TCP ports`;
      continue;
    }

    for (const target of targets) {
      for (const scheme of target.schemes) {
        if (remainingMs() <= 0) {
          lastError = budgetError;
          break probe;
        }
        const outcome = await queryLocalTarget(
          request,
          scheme,
          target.host,
          target.port,
          target.csrfToken,
          deadline,
        );
        if (outcome.snapshot) {
          return {
            found: true,
            result: {
              provider: "antigravity",
              status: "ok",
              source: "antigravity_local",
              dataAsOf: capturedAt,
              capturedAt,
              snapshot: outcome.snapshot,
            },
            error: null,
          };
        }
        if (outcome.error) lastError = outcome.error;
        // Only fall through to the alternate scheme on a transport/TLS failure.
        if (!outcome.transportError) break;
      }
    }
  }

  return {
    found: true,
    result: null,
    error: lastError ?? "local Antigravity server returned no quota data",
  };
}

/** Cloud Code `v1internal` endpoints require the Antigravity Hub client
 * User-Agent (alongside `ideType: "ANTIGRAVITY"` in `loadCodeAssist`) even
 * when authenticating with a shared local Gemini CLI OAuth token. */
function cloudCodeHeaders(accessToken: string, arch: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": `antigravity/hub/2.9.1 darwin/${arch}`,
  };
}

async function postCloudCode(
  request: typeof globalThis.fetch,
  url: string,
  accessToken: string,
  arch: string,
  body: Record<string, unknown>,
  deadline: number,
  perCallCapMs: number,
): Promise<
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string; budgetExhausted?: boolean }
> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return { kind: "error", message: `${new URL(url).pathname}: Cloud Code API budget exhausted`, budgetExhausted: true };
  }
  const timeoutMs = Math.min(perCallCapMs, remaining);
  try {
    const res = await request(url, {
      method: "POST",
      headers: cloudCodeHeaders(accessToken, arch),
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) {
      return { kind: "unauthorized" };
    }
    if (!res.ok) {
      return { kind: "error", message: `${new URL(url).pathname} HTTP ${res.status}` };
    }
    const json = (await res.json()) as unknown;
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return { kind: "error", message: `${new URL(url).pathname} returned non-object JSON` };
    }
    return { kind: "ok", data: json as Record<string, unknown> };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function staleOauthResult(capturedAt: number, message: string): CollectorResult {
  return {
    provider: "antigravity",
    status: "stale",
    source: "antigravity_api",
    dataAsOf: null,
    capturedAt,
    snapshot: null,
    error: message,
  };
}

function unavailableCloudResult(capturedAt: number, message: string): CollectorResult {
  return {
    provider: "antigravity",
    status: "unavailable",
    source: "antigravity_api",
    dataAsOf: null,
    capturedAt,
    snapshot: null,
    error: message,
  };
}

async function collectFromCloudApi(
  request: typeof globalThis.fetch,
  credential: AntigravityOauthCredential,
  capturedAt: number,
  arch: string,
  budgetMs: number,
): Promise<CollectorResult> {
  if (credential.expiresAt !== null && credential.expiresAt <= capturedAt) {
    return staleOauthResult(
      capturedAt,
      "Antigravity OAuth access token expired — will self-heal on next Antigravity sign-in or use (no self-refresh by design)",
    );
  }

  const deadline = Date.now() + budgetMs;
  const perCallCapMs = Math.min(CLOUD_FETCH_TIMEOUT_MS, Math.max(1, Math.ceil(budgetMs * 0.6)));
  const budgetError = `Cloud Code API exceeded its ${budgetMs}ms budget`;

  let project = credential.projectId;
  let plan: PlanMetadata | null = null;
  let lastError: string | null = null;

  // Read-only project & tier lookup — never calls onboardUser.
  const loadRes = await postCloudCode(
    request,
    `${CLOUD_CODE_BASE}/v1internal:loadCodeAssist`,
    credential.accessToken,
    arch,
    {
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    },
    deadline,
    perCallCapMs,
  );
  if (loadRes.kind === "unauthorized") {
    return staleOauthResult(
      capturedAt,
      "401 from Cloud Code loadCodeAssist — access token stale; will self-heal on next Antigravity sign-in or use (no self-refresh by design)",
    );
  }
  if (loadRes.kind === "ok") {
    const loadBody = loadRes.data as LoadCodeAssistResponse;
    project = extractProjectId(loadBody) ?? project;
    plan = extractPlanFromLoadCodeAssist(loadBody);
  } else {
    lastError = loadRes.message;
  }

  const projectPayload = project ? { project } : {};

  const endpoints: Array<{
    name: string;
    url: string;
    emptyError: string;
    normalize: (data: Record<string, unknown>) => WindowSnapshot | null;
  }> = [
    {
      name: "retrieveUserQuotaSummary",
      url: `${DAILY_CLOUD_CODE_BASE}/v1internal:retrieveUserQuotaSummary`,
      emptyError: "retrieveUserQuotaSummary returned no usable quota groups",
      normalize: (data) =>
        normalizeQuotaSummary(data as QuotaSummaryPayload, plan, "retrieveUserQuotaSummary"),
    },
    {
      name: "fetchAvailableModels",
      url: `${CLOUD_CODE_BASE}/v1internal:fetchAvailableModels`,
      emptyError: "fetchAvailableModels returned no usable model quotas",
      normalize: (data) => normalizeAvailableModels(data as FetchAvailableModelsResponse, plan),
    },
    {
      name: "retrieveUserQuota",
      url: `${CLOUD_CODE_BASE}/v1internal:retrieveUserQuota`,
      emptyError: "retrieveUserQuota returned no usable quota buckets",
      normalize: (data) => normalizeCloudQuotaBuckets(data as RetrieveUserQuotaResponse, plan),
    },
  ];

  for (const step of endpoints) {
    if (Date.now() >= deadline) {
      return unavailableCloudResult(capturedAt, budgetError);
    }
    const res = await postCloudCode(
      request,
      step.url,
      credential.accessToken,
      arch,
      projectPayload,
      deadline,
      perCallCapMs,
    );
    if (res.kind === "unauthorized") {
      return staleOauthResult(
        capturedAt,
        `401 from Cloud Code ${step.name} — access token stale; will self-heal on next Antigravity sign-in or use (no self-refresh by design)`,
      );
    }
    if (res.kind === "ok") {
      const snapshot = step.normalize(res.data);
      if (snapshot) {
        return {
          provider: "antigravity",
          status: "ok",
          source: "antigravity_api",
          dataAsOf: capturedAt,
          capturedAt,
          snapshot,
        };
      }
      lastError = step.emptyError;
    } else {
      lastError = res.message;
    }
  }

  return unavailableCloudResult(capturedAt, lastError ?? "Cloud Code API returned no usable quota data");
}

/** Public entry point: try local Antigravity language_server/agy first, then read-only Cloud Code OAuth fallback. */
export async function collectAntigravity(
  dependencies: AntigravityCollectorDependencies = {},
): Promise<CollectorResult> {
  const request = dependencies.request ?? globalThis.fetch;
  const capturedAt = (dependencies.now ?? Date.now)();
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const env = dependencies.env ?? process.env;
  const readFileText = dependencies.readFileText ?? defaultReadFileText;
  const getHome = dependencies.homedir ?? homedir;
  const arch = dependencies.arch ?? process.arch;

  const localBudgetMs = dependencies.localProbeBudgetMs ?? LOCAL_PROBE_BUDGET_MS;
  const cloudBudgetMs = dependencies.cloudApiBudgetMs ?? CLOUD_API_BUDGET_MS;
  const overallDeadline = Date.now() + Math.min(TOTAL_COLLECT_BUDGET_MS, localBudgetMs + cloudBudgetMs);

  // Tactic A: local Antigravity language_server / agy Connect-RPC.
  const local = await collectFromLocalServer(
    request,
    runCommand,
    capturedAt,
    Math.min(localBudgetMs, Math.max(1, overallDeadline - Date.now())),
  );
  if (local.result) {
    return local.result;
  }

  // Tactic B: read-only Cloud Code OAuth fallback.
  const creds = dependencies.readOauthCredentials
    ? await dependencies.readOauthCredentials()
    : await readDefaultOauthCredentials(env, readFileText, getHome, capturedAt);

  if (!creds.ok) {
    const detail = local.found && local.error
      ? `local server failed (${local.error}); OAuth fallback unavailable (${creds.error})`
      : `${local.error ?? "local server unavailable"}; ${creds.error}`;
    return {
      provider: "antigravity",
      status: "unavailable",
      source: local.found ? "antigravity_local" : "antigravity_api",
      dataAsOf: null,
      capturedAt,
      snapshot: null,
      error: detail,
    };
  }

  const remainingCloudBudgetMs = Math.min(cloudBudgetMs, Math.max(0, overallDeadline - Date.now()));
  if (remainingCloudBudgetMs <= 0) {
    return unavailableCloudResult(capturedAt, `Antigravity collector exceeded its ${TOTAL_COLLECT_BUDGET_MS}ms budget`);
  }

  return collectFromCloudApi(
    request,
    creds.credential,
    capturedAt,
    arch,
    remainingCloudBudgetMs,
  );
}
