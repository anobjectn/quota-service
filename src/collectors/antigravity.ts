// Strictly read-only collector for Google Antigravity (`antigravity`).
//
// Two tactics, tried in order:
//   A. Local Antigravity `language_server` / `agy` Connect-RPC over loopback
//      (127.0.0.1), discovered via `ps` + `lsof` with bounded timeouts.
//   B. Read-only Cloud Code OAuth endpoints using existing local credentials
//      (env vars or well-known local files). Never writes or refreshes tokens,
//      never calls `onboardUser`, and never consumes credits.

import { homedir } from "node:os";
import { join } from "node:path";
import { finiteNumber, parseInstant } from "../lib/time";
import type { CollectorResult, WindowQuota, WindowSnapshot } from "../types";

export const ANTIGRAVITY_POLL_FLOOR_MS = 60_000;

const FETCH_TIMEOUT_MS = 10_000;
const SUBPROCESS_TIMEOUT_MS = 5_000;
/** Loopback RPCs answer in milliseconds; a port that holds the connection open
 * (e.g. a raw LSP socket) must not eat the collect-on-query budget. */
const LOCAL_FETCH_TIMEOUT_MS = 2_000;
/** Total time for local discovery and probing, leaving room inside collect.ts's
 * 12s attempt ceiling for the Cloud Code OAuth fallback. */
const LOCAL_PROBE_BUDGET_MS = 5_000;

const FIVE_HOUR_MAX_MS = 6 * 3600 * 1000;
const WEEKLY_MIN_MS = 3 * 24 * 3600 * 1000;
const FIVE_HOUR_MAX_SECONDS = 6 * 3600;
const WEEKLY_MIN_SECONDS = 3 * 24 * 3600;

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
}

interface QuotaSummaryRemainingPayload {
  remainingFraction?: number | null;
  case?: string | null;
  value?: number | null;
}

interface QuotaSummaryWindowPayload {
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
    if (!Number.isFinite(value)) return null;
    return value > 0 && value < 1e12 ? Math.round(value * 1000) : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return null;
      return numeric > 0 && numeric < 1e12 ? Math.round(numeric * 1000) : numeric;
    }
    return parseInstant(trimmed);
  }
  if (typeof value === "object") {
    const seconds = (value as { seconds?: unknown }).seconds;
    const nanos = (value as { nanos?: unknown }).nanos;
    const secNum = typeof seconds === "number" ? seconds : typeof seconds === "string" ? Number(seconds) : NaN;
    if (Number.isFinite(secNum)) {
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

/** Normalizes recognized Google / Antigravity plan or tier names to stable short IDs,
 * preserving unrecognized non-empty names trimmed as-is. */
export function normalizeAntigravityPlanType(raw: string | null | undefined): string | null {
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
  return trimmed;
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
  const tierIdPlanType = normalizeAntigravityPlanType(tierId);
  const recognizedTierId = tierIdPlanType !== tierId ? tierIdPlanType : null;
  const rawPlanName = tierName ?? planInfoName ?? tierId;
  const planType =
    normalizeAntigravityPlanType(tierName) ??
    recognizedTierId ??
    normalizeAntigravityPlanType(planInfoName) ??
    tierIdPlanType;
  return {
    planType,
    rawPlanName,
    tierId,
    planSource: planType || rawPlanName ? "get_user_status" : null,
  };
}

function extractPlanFromLoadCodeAssist(body: LoadCodeAssistResponse | null | undefined): PlanMetadata {
  const rawPlanName =
    nonEmptyString(body?.paidTier?.name) ??
    nonEmptyString(body?.planInfo?.planDisplayName) ??
    nonEmptyString(body?.planInfo?.planName) ??
    nonEmptyString(body?.planInfo?.planType) ??
    nonEmptyString(body?.paidTier?.id) ??
    nonEmptyString(body?.currentTier?.name) ??
    nonEmptyString(body?.currentTier?.id);
  const tierId = nonEmptyString(body?.paidTier?.id) ?? nonEmptyString(body?.currentTier?.id);
  const planType = normalizeAntigravityPlanType(rawPlanName) ?? normalizeAntigravityPlanType(tierId);
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
  const pattern = new RegExp(`(?:^|\\s)--${flagName}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|(\\S+))`);
  const match = command.match(pattern);
  if (!match) return null;
  return nonEmptyString(match[1] ?? match[2] ?? match[3]);
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

    const firstToken = extractFirstToken(command);
    const isLanguageServer =
      /(?:^|\/|\s)language_server(?:_[a-z0-9_]+)?(?:\s|$)/i.test(command) &&
      /antigravity/i.test(command);
    const isAgy = /(?:^|\/)agy$/i.test(firstToken);

    if (!isLanguageServer && !isAgy) continue;
    seenPids.add(pid);

    const csrfToken = extractFlagValue(command, "csrf_token");
    const extPortRaw = extractFlagValue(command, "extension_server_port");
    const extPortNum = extPortRaw ? Number(extPortRaw) : NaN;
    const extensionServerPort =
      Number.isInteger(extPortNum) && extPortNum >= 1 && extPortNum <= 65535 ? extPortNum : null;
    const extensionServerCsrfToken = extractFlagValue(command, "extension_server_csrf_token");

    found.push({
      pid,
      kind: isLanguageServer ? "language_server" : "agy",
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

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` output for loopback/wildcard TCP listening ports. */
export function parseListeningPorts(lsofOutput: string): number[] {
  const ports: number[] = [];
  const seen = new Set<number>();
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/(?:127\.0\.0\.1|\[::1\]|localhost|\*):(\d+)\s+\(LISTEN\)/i);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && !seen.has(port)) {
      seen.add(port);
      ports.push(port);
    }
  }
  return ports;
}

function classifyCadenceFromHorizon(resetsAt: number | null, now: number): Cadence {
  if (resetsAt === null) return "unknown";
  const horizonMs = resetsAt - now;
  if (horizonMs < 0) return "unknown";
  if (horizonMs <= FIVE_HOUR_MAX_MS) return "fiveHour";
  if (horizonMs >= WEEKLY_MIN_MS) return "weekly";
  return "unknown";
}

function classifyBucketCadence(bucket: QuotaSummaryBucketPayload, resetsAt: number | null, now: number): Cadence {
  const textParts: string[] = [];
  if (typeof bucket.window === "string") {
    textParts.push(bucket.window);
  } else if (bucket.window && typeof bucket.window === "object") {
    const durRaw = bucket.window.durationSeconds ?? bucket.window.seconds;
    const dur = typeof durRaw === "number" ? durRaw : typeof durRaw === "string" ? Number(durRaw) : NaN;
    if (Number.isFinite(dur) && dur > 0) {
      if (dur <= FIVE_HOUR_MAX_SECONDS) return "fiveHour";
      if (dur >= WEEKLY_MIN_SECONDS) return "weekly";
    }
    for (const field of [bucket.window.displayName, bucket.window.name, bucket.window.type]) {
      const s = nonEmptyString(field);
      if (s) textParts.push(s);
    }
  }
  for (const field of [bucket.bucketId, bucket.id, bucket.displayName, bucket.name, bucket.description]) {
    const s = nonEmptyString(field);
    if (s) textParts.push(s);
  }
  const combined = textParts.join(" ");
  if (/\b(?:5\s*h(?:our|r)?s?|five[_\s-]*hour|session|short[_\s-]*term|rolling[_\s-]*5)\b/i.test(combined)) {
    return "fiveHour";
  }
  if (/\b(?:7\s*d(?:ay)?s?|week(?:ly)?|seven[_\s-]*day)\b/i.test(combined)) {
    return "weekly";
  }
  return classifyCadenceFromHorizon(resetsAt, now);
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
  if (/^gemini(?:\s+\d+(?:\.\d+)?)?(?:\s+(?:pro|flash))?(?:\s*\([^)]*\))?$/i.test(trimmed)) {
    return 75 + cadenceBonus;
  }
  if (/\bgemini\b/i.test(trimmed)) {
    return 50 + cadenceBonus;
  }
  return -1;
}

function isGenericBucketLabel(label: string, groupLabel: string): boolean {
  const lower = label.trim().toLowerCase();
  if (!lower) return true;
  if (lower === groupLabel.trim().toLowerCase()) return true;
  return /^(?:5\s*h(?:our|r)?s?|five[_\s-]*hour|session|weekly|week|7\s*d(?:ay)?s?|seven[_\s-]*day|primary|secondary|default|quota|limit)$/.test(
    lower,
  );
}

function formatModelWindowKey(
  groupLabel: string,
  bucketLabel: string | null,
  cadence: Cadence,
  groupBucketCount: number,
): string {
  const cadenceSuffix = cadence === "fiveHour" ? "5h" : cadence === "weekly" ? "weekly" : null;
  const baseLabel =
    bucketLabel && !isGenericBucketLabel(bucketLabel, groupLabel) ? bucketLabel : groupLabel;
  if (cadenceSuffix) {
    const alreadyTagged =
      (cadence === "fiveHour" && /\b5h\b|\b5[\s-]*hour/i.test(baseLabel)) ||
      (cadence === "weekly" && /\bweekly\b|\b7d\b/i.test(baseLabel));
    if (!alreadyTagged && (groupBucketCount > 1 || baseLabel === groupLabel)) {
      return `${baseLabel} (${cadenceSuffix})`;
    }
  }
  if (groupBucketCount > 1 && bucketLabel && bucketLabel !== baseLabel) {
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
  return {
    ...(plan?.planType ? { planType: plan.planType } : {}),
    ...(plan?.planSource ? { planSource: plan.planSource } : {}),
    ...(plan?.rawPlanName ? { rawPlanName: plan.rawPlanName } : {}),
    ...(plan?.tierId ? { tierId: plan.tierId } : {}),
    endpoint,
    ...extraFields,
  };
}

/** Normalizes a structured `RetrieveUserQuotaSummary` payload into a `WindowSnapshot`. */
export function normalizeQuotaSummary(
  rawPayload: QuotaSummaryPayload,
  now: number,
  plan?: PlanMetadata | null,
  endpoint = "RetrieveUserQuotaSummary",
): WindowSnapshot | null {
  const payload = rawPayload.response ?? rawPayload.summary ?? rawPayload;
  const rawGroups = Array.isArray(payload.groups) ? payload.groups : [];
  if (rawGroups.length === 0) return null;

  interface ParsedBucket {
    quota: WindowQuota;
    cadence: Cadence;
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
    if (!group || typeof group !== "object") continue;
    const groupLabel = nonEmptyString(group.displayName) ?? nonEmptyString(group.name) ?? "";
    const parsedBuckets: ParsedBucket[] = [];
    for (const bucket of group.buckets ?? []) {
      if (!bucket || typeof bucket !== "object") continue;
      if (bucket.disabled === true) continue;
      const usedPercent = remainingFractionToUsedPercent(extractBucketRemainingFraction(bucket));
      if (usedPercent === null) continue;
      const resetsAt = parseTimestamp(bucket.resetTime);
      const cadence = classifyBucketCadence(bucket, resetsAt, now);
      const label = nonEmptyString(bucket.displayName) ?? nonEmptyString(bucket.name);
      const id = nonEmptyString(bucket.bucketId) ?? nonEmptyString(bucket.id);
      parsedBuckets.push({
        quota: { usedPercent, resetsAt },
        cadence,
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

  for (let i = 0; i < parsedGroups.length; i++) {
    const group = parsedGroups[i]!;
    const displayGroupLabel = group.label || "Antigravity";
    if (i === primaryIndex) {
      for (const bucket of group.buckets) {
        if (bucket.cadence === "fiveHour" && fiveHour === null) {
          fiveHour = bucket.quota;
        } else if (bucket.cadence === "weekly" && weekly === null) {
          weekly = bucket.quota;
        } else {
          const key = formatModelWindowKey(
            displayGroupLabel,
            bucket.label ?? (bucket.cadence === "unknown" ? bucket.id : null),
            bucket.cadence,
            group.buckets.length,
          );
          insertModelWindow(modelWindows, key, bucket.quota);
        }
      }
      continue;
    }
    for (const bucket of group.buckets) {
      const key = formatModelWindowKey(
        displayGroupLabel,
        bucket.label ?? (bucket.cadence === "unknown" && group.buckets.length > 1 ? bucket.id : null),
        bucket.cadence,
        group.buckets.length,
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
  isGemini: boolean;
  cadence: Cadence;
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

function isGeminiModel(label: string, modelId: string): boolean {
  if (/\b(?:claude|anthropic|gpt|openai|oss)\b/i.test(label)) return false;
  return /gemini/i.test(label) || /gemini/i.test(modelId);
}

function geminiRepresentativePriority(entry: NormalizedModelEntry): number {
  const text = `${entry.label} ${entry.modelId}`.toLowerCase();
  // Prefer general Gemini Pro / primary Gemini over Flash or specialized variants,
  // then tighter utilization as a conservative tie-breaker.
  let score = 0;
  if (/\bpro\b/.test(text)) score += 20;
  else if (!/\bflash\b|\blite\b/.test(text)) score += 10;
  return score * 1000 + entry.quota.usedPercent;
}

function normalizeModelEntries(
  entries: NormalizedModelEntry[],
  plan: PlanMetadata | null | undefined,
  endpoint: string,
): WindowSnapshot | null {
  if (entries.length === 0) return null;

  let fiveHourIdx = -1;
  let fiveHourPriority = -1;
  let weeklyIdx = -1;
  let weeklyPriority = -1;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry.isGemini) continue;
    const priority = geminiRepresentativePriority(entry);
    if (entry.cadence === "fiveHour" && priority > fiveHourPriority) {
      fiveHourPriority = priority;
      fiveHourIdx = i;
    } else if (entry.cadence === "weekly" && priority > weeklyPriority) {
      weeklyPriority = priority;
      weeklyIdx = i;
    }
  }

  const fiveHour = fiveHourIdx >= 0 ? entries[fiveHourIdx]!.quota : null;
  const weekly = weeklyIdx >= 0 ? entries[weeklyIdx]!.quota : null;

  // Check if any label appears with multiple distinct cadences among remaining entries.
  const remaining = entries.filter((_, idx) => idx !== fiveHourIdx && idx !== weeklyIdx);
  const labelCadences = new Map<string, Set<Cadence>>();
  for (const entry of remaining) {
    const set = labelCadences.get(entry.label) ?? new Set<Cadence>();
    set.add(entry.cadence);
    labelCadences.set(entry.label, set);
  }

  const modelWindows: Record<string, WindowQuota> = {};
  for (const entry of remaining) {
    const hasMultiCadence = (labelCadences.get(entry.label)?.size ?? 0) > 1;
    const key =
      hasMultiCadence && entry.cadence !== "unknown"
        ? `${entry.label} (${entry.cadence === "fiveHour" ? "5h" : "weekly"})`
        : entry.label;
    insertModelWindow(modelWindows, key, entry.quota);
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

/** Normalizes `GetUserStatus` / `GetCommandModelConfigs` `clientModelConfigs[]` into a `WindowSnapshot`. */
export function normalizeModelConfigs(
  configs: ClientModelConfigPayload[] | null | undefined,
  now: number,
  plan?: PlanMetadata | null,
  endpoint = "GetUserStatus",
): WindowSnapshot | null {
  const entries: NormalizedModelEntry[] = [];
  for (const cfg of configs ?? []) {
    if (!cfg || typeof cfg !== "object" || cfg.disabled === true) continue;
    const usedPercent = remainingFractionToUsedPercent(cfg.quotaInfo?.remainingFraction);
    if (usedPercent === null) continue;
    const resetsAt = parseTimestamp(cfg.quotaInfo?.resetTime);
    const modelId = nonEmptyString(cfg.modelOrAlias?.model) ?? nonEmptyString(cfg.modelOrAlias?.alias) ?? "";
    const label = nonEmptyString(cfg.label) ?? prettifyModelId(modelId);
    entries.push({
      modelId,
      label,
      isGemini: isGeminiModel(label, modelId),
      cadence: classifyCadenceFromHorizon(resetsAt, now),
      quota: { usedPercent, resetsAt },
    });
  }
  return normalizeModelEntries(entries, plan, endpoint);
}

/** Normalizes Cloud Code `fetchAvailableModels` response into a `WindowSnapshot`. */
export function normalizeAvailableModels(
  body: FetchAvailableModelsResponse | null | undefined,
  now: number,
  plan?: PlanMetadata | null,
): WindowSnapshot | null {
  const models = body?.models;
  if (!models || typeof models !== "object") return null;
  const entries: NormalizedModelEntry[] = [];
  for (const [modelId, info] of Object.entries(models)) {
    if (!info || typeof info !== "object" || info.disabled === true) continue;
    const usedPercent = remainingFractionToUsedPercent(info.quotaInfo?.remainingFraction);
    if (usedPercent === null) continue;
    const resetsAt = parseTimestamp(info.quotaInfo?.resetTime);
    const label = nonEmptyString(info.displayName) ?? nonEmptyString(info.label) ?? prettifyModelId(modelId);
    entries.push({
      modelId,
      label,
      isGemini: isGeminiModel(label, modelId),
      cadence: classifyCadenceFromHorizon(resetsAt, now),
      quota: { usedPercent, resetsAt },
    });
  }
  return normalizeModelEntries(entries, plan, "fetchAvailableModels");
}

/** Normalizes Cloud Code `retrieveUserQuota` buckets into a `WindowSnapshot`. */
export function normalizeCloudQuotaBuckets(
  body: RetrieveUserQuotaResponse | null | undefined,
  now: number,
  plan?: PlanMetadata | null,
): WindowSnapshot | null {
  const entries: NormalizedModelEntry[] = [];
  for (const bucket of body?.buckets ?? []) {
    if (!bucket || typeof bucket !== "object" || bucket.disabled === true) continue;
    const usedPercent = remainingFractionToUsedPercent(bucket.remainingFraction);
    if (usedPercent === null) continue;
    const resetsAt = parseTimestamp(bucket.resetTime);
    const modelId = nonEmptyString(bucket.modelId) ?? "";
    const label = nonEmptyString(bucket.displayName) ?? prettifyModelId(modelId);
    entries.push({
      modelId,
      label,
      isGemini: isGeminiModel(label, modelId),
      cadence: classifyCadenceFromHorizon(resetsAt, now),
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
  if (!parsed || typeof parsed !== "object") {
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
  port: number,
  method: string,
  csrfToken: string | null,
  deadline: number,
): Promise<{ ok: true; status: number; body: Record<string, unknown> } | { ok: false; transportError: boolean; error: string }> {
  const timeoutMs = Math.min(LOCAL_FETCH_TIMEOUT_MS, deadline - Date.now());
  if (timeoutMs <= 0) {
    return { ok: false, transportError: true, error: `${method}: local probe budget exhausted` };
  }
  const url = `${scheme}://127.0.0.1:${port}${LOCAL_RPC_PREFIX}/${method}`;
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
    signal: AbortSignal.timeout(timeoutMs),
  };
  // Scope self-signed TLS acceptance strictly to 127.0.0.1 loopback HTTPS.
  if (parsed.protocol === "https:" && parsed.hostname === "127.0.0.1") {
    init.tls = { rejectUnauthorized: false };
  }

  try {
    const res = await request(url, init);
    if (!res.ok) {
      return { ok: false, transportError: false, error: `${method} HTTP ${res.status}` };
    }
    const json = (await res.json()) as unknown;
    if (!json || typeof json !== "object") {
      return { ok: false, transportError: false, error: `${method} returned non-object JSON` };
    }
    return { ok: true, status: res.status, body: json as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      transportError: true,
      error: `${method}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function queryLocalTarget(
  request: typeof globalThis.fetch,
  scheme: "https" | "http",
  port: number,
  csrfToken: string | null,
  capturedAt: number,
  deadline: number,
): Promise<{ snapshot: WindowSnapshot | null; transportError: boolean; error: string | null }> {
  const summaryRes = await postLoopbackRpc(request, scheme, port, "RetrieveUserQuotaSummary", csrfToken, deadline);
  if (!summaryRes.ok && summaryRes.transportError) {
    return { snapshot: null, transportError: true, error: summaryRes.error };
  }

  if (summaryRes.ok) {
    const payload = summaryRes.body as QuotaSummaryPayload;
    if (!isRpcErrorCode(payload.code) || Array.isArray(payload.groups) || payload.response || payload.summary) {
      let plan: PlanMetadata | null = null;
      const baseSnapshot = normalizeQuotaSummary(payload, capturedAt, null, "RetrieveUserQuotaSummary");
      if (baseSnapshot) {
        // Enrich plan/tier from GetUserStatus on the same working loopback target (best-effort).
        const statusRes = await postLoopbackRpc(request, scheme, port, "GetUserStatus", csrfToken, deadline);
        if (statusRes.ok) {
          plan = extractPlanFromUserStatus(statusRes.body as GetUserStatusResponse);
        }
        return {
          snapshot: {
            ...baseSnapshot,
            extra: buildExtra(plan, "RetrieveUserQuotaSummary"),
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

  const statusRes = await postLoopbackRpc(request, scheme, port, "GetUserStatus", csrfToken, deadline);
  if (statusRes.ok) {
    const statusBody = statusRes.body as GetUserStatusResponse;
    planFromStatus = extractPlanFromUserStatus(statusBody);
    const configs = statusBody.userStatus?.cascadeModelConfigData?.clientModelConfigs;
    const snapshot = normalizeModelConfigs(configs, capturedAt, planFromStatus, "GetUserStatus");
    if (snapshot) {
      return { snapshot, transportError: false, error: null };
    }
    lastError = nonEmptyString(statusBody.message) ?? "GetUserStatus returned no usable model quotas";
  } else {
    lastError = statusRes.error;
  }

  // Fallback 2: GetCommandModelConfigs.
  const cmdRes = await postLoopbackRpc(request, scheme, port, "GetCommandModelConfigs", csrfToken, deadline);
  if (cmdRes.ok) {
    const cmdBody = cmdRes.body as GetCommandModelConfigsResponse;
    const snapshot = normalizeModelConfigs(
      cmdBody.clientModelConfigs,
      capturedAt,
      planFromStatus,
      "GetCommandModelConfigs",
    );
    if (snapshot) {
      return { snapshot, transportError: false, error: null };
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
    const lsofPorts = lsof.exitCode === 0 ? parseListeningPorts(lsof.stdout) : [];

    interface LocalTarget {
      port: number;
      schemes: Array<"https" | "http">;
      csrfToken: string | null;
    }

    const targets: LocalTarget[] = [];
    const seenPorts = new Set<number>();

    // Try non-extension listening ports first (HTTPS with self-signed loopback cert, then HTTP fallback).
    for (const port of lsofPorts) {
      if (port === proc.extensionServerPort) continue;
      seenPorts.add(port);
      targets.push({ port, schemes: ["https", "http"], csrfToken: proc.csrfToken });
    }

    // Try extension server port (HTTP first, then HTTPS fallback).
    if (proc.extensionServerPort !== null && !seenPorts.has(proc.extensionServerPort)) {
      targets.push({
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
        const outcome = await queryLocalTarget(request, scheme, target.port, target.csrfToken, capturedAt, deadline);
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
): Promise<
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string }
> {
  try {
    const res = await request(url, {
      method: "POST",
      headers: cloudCodeHeaders(accessToken, arch),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401) {
      return { kind: "unauthorized" };
    }
    if (!res.ok) {
      return { kind: "error", message: `${new URL(url).pathname} HTTP ${res.status}` };
    }
    const json = (await res.json()) as unknown;
    if (!json || typeof json !== "object") {
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

async function collectFromCloudApi(
  request: typeof globalThis.fetch,
  credential: AntigravityOauthCredential,
  capturedAt: number,
  arch: string,
): Promise<CollectorResult> {
  if (credential.expiresAt !== null && credential.expiresAt <= capturedAt) {
    return staleOauthResult(
      capturedAt,
      "Antigravity OAuth access token expired — will self-heal on next Antigravity sign-in or use (no self-refresh by design)",
    );
  }

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

  // Primary Cloud Code quota summary endpoint.
  const summaryRes = await postCloudCode(
    request,
    `${DAILY_CLOUD_CODE_BASE}/v1internal:retrieveUserQuotaSummary`,
    credential.accessToken,
    arch,
    projectPayload,
  );
  if (summaryRes.kind === "unauthorized") {
    return staleOauthResult(
      capturedAt,
      "401 from Cloud Code retrieveUserQuotaSummary — access token stale; will self-heal on next Antigravity sign-in or use (no self-refresh by design)",
    );
  }
  if (summaryRes.kind === "ok") {
    const snapshot = normalizeQuotaSummary(
      summaryRes.data as QuotaSummaryPayload,
      capturedAt,
      plan,
      "retrieveUserQuotaSummary",
    );
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
    lastError = "retrieveUserQuotaSummary returned no usable quota groups";
  } else {
    lastError = summaryRes.message;
  }

  // Fallback 1: fetchAvailableModels.
  const modelsRes = await postCloudCode(
    request,
    `${CLOUD_CODE_BASE}/v1internal:fetchAvailableModels`,
    credential.accessToken,
    arch,
    projectPayload,
  );
  if (modelsRes.kind === "unauthorized") {
    return staleOauthResult(
      capturedAt,
      "401 from Cloud Code fetchAvailableModels — access token stale; will self-heal on next Antigravity sign-in or use (no self-refresh by design)",
    );
  }
  if (modelsRes.kind === "ok") {
    const snapshot = normalizeAvailableModels(modelsRes.data as FetchAvailableModelsResponse, capturedAt, plan);
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
    lastError = "fetchAvailableModels returned no usable model quotas";
  } else {
    lastError = modelsRes.message;
  }

  // Fallback 2: retrieveUserQuota.
  const quotaRes = await postCloudCode(
    request,
    `${CLOUD_CODE_BASE}/v1internal:retrieveUserQuota`,
    credential.accessToken,
    arch,
    projectPayload,
  );
  if (quotaRes.kind === "unauthorized") {
    return staleOauthResult(
      capturedAt,
      "401 from Cloud Code retrieveUserQuota — access token stale; will self-heal on next Antigravity sign-in or use (no self-refresh by design)",
    );
  }
  if (quotaRes.kind === "ok") {
    const snapshot = normalizeCloudQuotaBuckets(quotaRes.data as RetrieveUserQuotaResponse, capturedAt, plan);
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
    lastError = "retrieveUserQuota returned no usable quota buckets";
  } else {
    lastError = quotaRes.message;
  }

  return {
    provider: "antigravity",
    status: "unavailable",
    source: "antigravity_api",
    dataAsOf: null,
    capturedAt,
    snapshot: null,
    error: lastError ?? "Cloud Code API returned no usable quota data",
  };
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

  // Tactic A: local Antigravity language_server / agy Connect-RPC.
  const local = await collectFromLocalServer(
    request,
    runCommand,
    capturedAt,
    dependencies.localProbeBudgetMs ?? LOCAL_PROBE_BUDGET_MS,
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

  return collectFromCloudApi(request, creds.credential, capturedAt, arch);
}
