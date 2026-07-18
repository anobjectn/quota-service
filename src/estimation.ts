// Phase 4 — token/cost estimation + recommend_model.
//
// Honest framing carried over from the plan doc: precise pre-estimation is
// impossible. This is a coarse heuristic, not a token-accurate predictor.
//
// ---------------------------------------------------------------------------
// CALIBRATION PROVENANCE (v1.5 — heuristic buckets, empirically-bounded range)
// ---------------------------------------------------------------------------
// The TASK_PROFILE_TOKEN_RANGES below are not pure guesses: the outer bounds
// were sanity-checked against a real distribution of per-session token totals
// pulled from 119 Claude Code sessions in ~/.claude/projects/**/*.jsonl
// (summed input_tokens + output_tokens + max cache_read_input_tokens per
// session, as a proxy for "tokens moved" over a session). That one-off
// analysis (2026-07-13) found:
//   p10=20,507  p25=25,950  p50=73,399  p75=120,258  p90=229,201
//   p95=293,455  max=761,626
// Those percentiles anchor the low/typical/high bounds below, but the
// task-profile LABELS (small_fix vs feature vs large_refactor vs research)
// are still hand-assigned — the transcripts carry no ground-truth task-type
// field, so there was no way to bucket sessions by profile automatically in
// the time available. This is why it's "v1.5" rather than a full v2:
// the range envelope is data-informed, the bucket assignment is not.
//
// TODO (real v2, deferred — not attempted, more than the ~1h budget):
//   - Add a lightweight task-profile label captured at plan-review-execute
//     time (Plan C's gate already classifies a profile per plan/phase) and
//     correlate it with the session's actual token total after the fact,
//     to replace the hand-assigned buckets with real per-profile stats.
//   - Cross-reference Codex equivalents: ~/.codex/sessions/**/*.jsonl
//     (rollout format — token accounting lives in a different shape than
//     Claude Code's `usage` blocks; the Codex collector at
//     src/collectors/codex.ts already knows how to tail these for its 5h-
//     window fallback and would be the natural place to reuse that parsing).
//   - Re-run the same percentile analysis periodically as more sessions
//     accumulate; the one-off numbers above will go stale.
// ---------------------------------------------------------------------------

import type { Provider } from "./types";
import type { UsageReport, ProviderReport } from "./present";

export type TaskProfile = "small_fix" | "feature" | "large_refactor" | "research";

export type ModelTier = "light" | "mid" | "frontier";

export interface TokenRange {
  low: number;
  typical: number;
  high: number;
}

export const TASK_PROFILES: TaskProfile[] = ["small_fix", "feature", "large_refactor", "research"];

/** v1.5 hand-tuned constants — see calibration note above for provenance. */
export const TASK_PROFILE_TOKEN_RANGES: Record<TaskProfile, TokenRange> = {
  small_fix: { low: 8_000, typical: 20_000, high: 40_000 },
  feature: { low: 30_000, typical: 75_000, high: 130_000 },
  large_refactor: { low: 100_000, typical: 200_000, high: 350_000 },
  research: { low: 15_000, typical: 60_000, high: 150_000 },
};

export const TASK_PROFILE_DESCRIPTIONS: Record<TaskProfile, string> = {
  small_fix: "Small fix — single file, low ambiguity, mechanical change.",
  feature: "Standard feature work — moderate ambiguity, several files.",
  large_refactor: "Large refactor / architecture — high blast radius, many files.",
  research: "Research / investigation — read-heavy, exploratory, output-light.",
};

/** Maps each task profile to model-rubric.md's tiering vocabulary, so this
 * estimator and Plan C's pre-flight gate agree on terms. */
export const TASK_PROFILE_RUBRIC_TIER: Record<TaskProfile, ModelTier> = {
  small_fix: "light",
  feature: "mid",
  large_refactor: "frontier",
  // Research is read-heavy but ambiguity-sensitive; defaults to mid, callers
  // should escalate to frontier if the research itself is architecturally
  // risky (matches model-rubric.md's "straddles two tiers" guidance).
  research: "mid",
};

/** Hand-tuned, NOT data-derived: relative token-hungriness of a tier's
 * typical model relative to "mid" as baseline (frontier models tend to
 * think/write more per turn; light models are terser). */
const MODEL_TIER_MULTIPLIER: Record<ModelTier, number> = {
  light: 0.7,
  mid: 1.0,
  frontier: 1.3,
};

export interface CostEstimate {
  taskProfile: TaskProfile;
  description: string;
  rubricTier: ModelTier;
  tokenRangeByTier: Record<ModelTier, TokenRange>;
  calibration: {
    method: "v1.5-heuristic-bucket-empirical-bound";
    note: string;
    sourcePaths: string[];
  };
}

function scaleRange(range: TokenRange, multiplier: number): TokenRange {
  return {
    low: Math.round(range.low * multiplier),
    typical: Math.round(range.typical * multiplier),
    high: Math.round(range.high * multiplier),
  };
}

export function estimateCost(taskProfile: TaskProfile): CostEstimate {
  const base = TASK_PROFILE_TOKEN_RANGES[taskProfile];
  const tokenRangeByTier: Record<ModelTier, TokenRange> = {
    light: scaleRange(base, MODEL_TIER_MULTIPLIER.light),
    mid: scaleRange(base, MODEL_TIER_MULTIPLIER.mid),
    frontier: scaleRange(base, MODEL_TIER_MULTIPLIER.frontier),
  };
  return {
    taskProfile,
    description: TASK_PROFILE_DESCRIPTIONS[taskProfile],
    rubricTier: TASK_PROFILE_RUBRIC_TIER[taskProfile],
    tokenRangeByTier,
    calibration: {
      method: "v1.5-heuristic-bucket-empirical-bound",
      note:
        "Range envelope sanity-checked against real per-session token totals from 119 Claude Code transcripts (2026-07-13); task-profile labels are hand-assigned, not derived. See comment block in src/estimation.ts for full methodology and the real v2 TODO.",
      sourcePaths: ["~/.claude/projects/**/*.jsonl", "~/.codex/sessions/**/*.jsonl (not yet cross-referenced)"],
    },
  };
}

export function isValidTaskProfile(v: unknown): v is TaskProfile {
  return typeof v === "string" && (TASK_PROFILES as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// recommend_model
// ---------------------------------------------------------------------------

interface ModelOption {
  provider: Provider;
  tier: ModelTier;
  model: string;
}

/** Model roster per the handoff's instructions. Names are the harness-facing
 * labels, not API model IDs — this tool recommends "who/what to use", the
 * caller maps that to an actual invocation. */
const ROSTER: ModelOption[] = [
  { provider: "anthropic", tier: "light", model: "Haiku" },
  { provider: "anthropic", tier: "mid", model: "Sonnet 5" },
  { provider: "anthropic", tier: "frontier", model: "Fable 5 / Opus 4.8" },
  { provider: "codex", tier: "light", model: "GPT-5.x low/mini tier" },
  { provider: "codex", tier: "mid", model: "GPT-5.x standard tier" },
  { provider: "codex", tier: "frontier", model: "GPT-5.x high tier" },
  { provider: "warp", tier: "light", model: "Luna" },
  { provider: "warp", tier: "mid", model: "Terra" },
  { provider: "warp", tier: "frontier", model: "Sol (high)" },
];

const TIER_ORDER: ModelTier[] = ["light", "mid", "frontier"];

interface ProviderHeadroom {
  provider: Provider;
  /** 0-100, null if unknown (stale/unavailable/no data) */
  headroomPercent: number | null;
  status: ProviderReport["status"];
  constraint: string | null;
  flagged: boolean;
  flagReason: string | null;
}

/** For Anthropic's frontier tier (Fable 5), the binding constraint is the
 * MINIMUM headroom across 5h, all-models weekly, AND any per-model weekly
 * window Anthropic happens to be reporting right now (e.g. a "Fable" bucket
 * — generic by construction, not hardcoded: whatever keys show up in
 * `modelWindows` are considered). A fresh per-model bucket can make the
 * frontier tier cheaper to recommend even when the all-models weekly window
 * is tight, which is exactly the scenario this exists to catch. */
function computeAnthropicFrontierHeadroom(report: ProviderReport): ProviderHeadroom {
  const base = computeHeadroom(report);
  if (report.status === "unavailable" || !report.snapshot || report.snapshot.kind !== "window") {
    return base;
  }
  const modelWindows = report.snapshot.modelWindows;
  if (!modelWindows || Object.keys(modelWindows).length === 0) {
    return base;
  }
  let minHeadroom = base.headroomPercent;
  let constraint = base.constraint;
  for (const [name, w] of Object.entries(modelWindows)) {
    const headroom = 100 - w.usedPercent;
    if (minHeadroom === null || headroom < minHeadroom) {
      minHeadroom = headroom;
      constraint = `${name} weekly window`;
    }
  }
  return { ...base, headroomPercent: minHeadroom, constraint };
}

/** The binding constraint for a provider is whichever tracked window/pool is
 * closest to exhaustion — that's what will actually block further work. */
function computeHeadroom(report: ProviderReport): ProviderHeadroom {
  const base = {
    provider: report.provider,
    status: report.status,
    flagged: false,
    flagReason: null as string | null,
  };
  if (report.status === "unavailable") {
    return { ...base, headroomPercent: null, constraint: null, flagged: true, flagReason: report.error ?? "collector unavailable" };
  }
  if (!report.snapshot) {
    return { ...base, headroomPercent: null, constraint: null, flagged: true, flagReason: "no data collected yet" };
  }
  let minHeadroom: number | null = null;
  let constraint: string | null = null;
  if (report.snapshot.kind === "window") {
    for (const [label, w] of [
      ["5h", report.snapshot.fiveHour],
      ["weekly", report.snapshot.weekly],
    ] as const) {
      if (!w) continue;
      const headroom = 100 - w.usedPercent;
      if (minHeadroom === null || headroom < minHeadroom) {
        minHeadroom = headroom;
        constraint = `${label} window`;
      }
    }
  } else if (report.snapshot.kind === "pool") {
    minHeadroom = 100 - report.snapshot.pool.usedPercent;
    constraint = "pool";
  }
  const flagged = report.status === "stale";
  return {
    ...base,
    headroomPercent: minHeadroom,
    constraint,
    flagged,
    flagReason: flagged ? (report.error ?? "data marked stale") : null,
  };
}

export interface RecommendationCandidate {
  provider: Provider;
  tier: ModelTier;
  model: string;
  headroomPercent: number | null;
  constraint: string | null;
  dataStatus: ProviderReport["status"];
  flagged: boolean;
  flagReason: string | null;
}

export interface RecommendModelResult {
  taskProfile: TaskProfile;
  estimate: CostEstimate;
  headroomByProvider: ProviderHeadroom[];
  recommendation: RecommendationCandidate | null;
  reason: string;
  alternates: RecommendationCandidate[];
  warnings: string[];
  /** Enabled usage-credits balance with remaining headroom, surfaced as a
   * manual-fallback note (same spirit as Warp's manual add-on-credit entry)
   * — never factored into automated ranking/spending. */
  usageCreditsNote: string | null;
}

export function recommendModel(taskProfile: TaskProfile, usage: UsageReport): RecommendModelResult {
  const estimate = estimateCost(taskProfile);
  const requiredTier = estimate.rubricTier;
  const headroomByProvider = usage.providers.map(computeHeadroom);
  const warnings: string[] = [];

  for (const h of headroomByProvider) {
    if (h.flagged) {
      warnings.push(`${h.provider}: ${h.status} (${h.flagReason}) — excluded from ranking unless no alternative has headroom data.`);
    }
  }

  function candidatesForTier(tier: ModelTier): RecommendationCandidate[] {
    return ROSTER.filter(
      (r) => r.tier === tier && usage.providers.some((provider) => provider.provider === r.provider),
    ).flatMap((r) => {
      const report = usage.providers.find((provider) => provider.provider === r.provider);
      const h = r.provider === "anthropic" && tier === "frontier" && report
        ? computeAnthropicFrontierHeadroom(report)
        : headroomByProvider.find((candidate) => candidate.provider === r.provider);
      if (!h) return [];
      return {
        provider: r.provider,
        tier: r.tier,
        model: r.model,
        headroomPercent: h.headroomPercent,
        constraint: h.constraint,
        dataStatus: h.status,
        flagged: h.flagged,
        flagReason: h.flagReason,
      };
    });
  }

  function rank(candidates: RecommendationCandidate[]): RecommendationCandidate[] {
    return [...candidates].sort((a, b) => {
      // Unflagged-with-data candidates first, ranked by headroom desc.
      const aUsable = !a.flagged && a.headroomPercent != null;
      const bUsable = !b.flagged && b.headroomPercent != null;
      if (aUsable !== bUsable) return aUsable ? -1 : 1;
      // Budget rule from model-rubric.md: keep bulk work off Warp when tied.
      if (a.provider === "warp" && b.provider !== "warp" && (a.headroomPercent ?? 0) - (b.headroomPercent ?? 0) < 15) return 1;
      if (b.provider === "warp" && a.provider !== "warp" && (b.headroomPercent ?? 0) - (a.headroomPercent ?? 0) < 15) return -1;
      return (b.headroomPercent ?? -1) - (a.headroomPercent ?? -1);
    });
  }

  let candidates = rank(candidatesForTier(requiredTier));
  let effectiveTier = requiredTier;

  // If the required tier has no usable headroom anywhere, fall back to an
  // adjacent tier rather than recommending a provider we know is exhausted.
  const usable = (c: RecommendationCandidate) => !c.flagged && c.headroomPercent != null && c.headroomPercent > 5;
  if (!candidates.some(usable)) {
    const tierIdx = TIER_ORDER.indexOf(requiredTier);
    for (const idx of [tierIdx - 1, tierIdx + 1].filter((i) => i >= 0 && i < TIER_ORDER.length)) {
      const fallback = rank(candidatesForTier(TIER_ORDER[idx]!));
      if (fallback.some(usable)) {
        candidates = fallback;
        effectiveTier = TIER_ORDER[idx]!;
        warnings.push(
          `No provider at required tier "${requiredTier}" has usable headroom; falling back to adjacent tier "${effectiveTier}".`,
        );
        break;
      }
    }
  }

  const top = candidates[0] ?? null;
  const alternates = candidates.slice(1, 3);

  let reason: string;
  if (!top || top.headroomPercent == null) {
    reason = `No provider currently has usable headroom data for the "${effectiveTier}" tier; all candidates are stale/unavailable/exhausted. Check ${warnings.join("; ") || "provider status"}.`;
  } else {
    const tierNote = effectiveTier !== requiredTier ? ` (fell back from "${requiredTier}")` : "";
    reason = `Task profile "${taskProfile}" maps to rubric tier "${effectiveTier}"${tierNote}. ${top.provider} has the most headroom (${top.headroomPercent.toFixed(1)}% remaining on its ${top.constraint ?? "tracked resource"}) among ${effectiveTier}-tier options — recommend ${top.model}.`;
  }

  const usageCreditsNote = buildUsageCreditsNote(usage);

  return {
    taskProfile,
    estimate,
    headroomByProvider,
    recommendation: top,
    reason,
    alternates,
    warnings,
    usageCreditsNote,
  };
}

/** Flags an enabled, non-exhausted usage-credits balance as a manual fallback
 * note — mirrors how Warp's manual add-on credits show up as informational
 * only. Never used to influence ranking or trigger any spend. */
function buildUsageCreditsNote(usage: UsageReport): string | null {
  for (const p of usage.providers) {
    const snapshot = p.snapshot;
    if (!snapshot || snapshot.kind !== "window") continue;
    const credits = snapshot.usageCredits;
    if (!credits || !credits.enabled) continue;
    const remaining = credits.limitAmount != null ? credits.limitAmount - credits.spentAmount : null;
    if (remaining == null || remaining <= 0) continue;
    const limitStr = credits.limitAmount != null ? credits.limitAmount.toFixed(2) : "?";
    return (
      `${p.provider} usage credits enabled: $${credits.spentAmount.toFixed(2)} spent of $${limitStr} ${credits.currency}` +
      ` ($${remaining.toFixed(2)} remaining) — manual fallback only, never auto-spent.`
    );
  }
  return null;
}
