import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { saveResetCredits, saveSnapshot, setManualEntry } from "../src/db";
import { collectAntigravity, normalizeAvailableModels } from "../src/collectors/antigravity";
import { recommendModel } from "../src/estimation";
import { buildResetsReport, buildUsageReport, type ProviderReport, type UsageReport } from "../src/present";
import type { CollectorResult, Provider } from "../src/types";

function testDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      data_as_of INTEGER,
      captured_at INTEGER NOT NULL,
      snapshot_json TEXT,
      error TEXT
    );
    CREATE TABLE reset_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      available_count INTEGER,
      total_earned_count INTEGER,
      credits_json TEXT,
      error TEXT
    );
    CREATE TABLE manual_entries (
      provider TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      note TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, field)
    );
  `);
  return db;
}

function snapshot(provider: Provider): CollectorResult {
  const now = Date.now();
  return provider === "warp"
    ? {
        provider,
        status: "ok",
        source: "warp_test",
        dataAsOf: now,
        capturedAt: now,
        snapshot: {
          kind: "pool",
          pool: { used: 25, limit: 100, usedPercent: 25, refreshesAt: now + 86_400_000 },
        },
      }
    : {
        provider,
        status: "ok",
        source: `${provider}_test`,
        dataAsOf: now,
        capturedAt: now,
        snapshot: {
          kind: "window",
          fiveHour: { usedPercent: 20, resetsAt: now + 3_600_000 },
          weekly: { usedPercent: 30, resetsAt: now + 86_400_000 },
        },
      };
}

test("usage and resets include enabled providers in configured order", () => {
  const db = testDb();
  for (const provider of ["codex", "anthropic", "warp", "antigravity"] as Provider[]) {
    saveSnapshot(db, snapshot(provider));
  }

  expect(buildUsageReport(db, ["antigravity", "warp", "codex"]).providers.map((report) => report.provider)).toEqual([
    "antigravity",
    "warp",
    "codex",
  ]);
  const resets = buildResetsReport(db, ["antigravity", "warp", "codex"]);
  expect(resets.pools.map((pool) => pool.provider)).toEqual(["warp"]);
  expect(resets.windows.map((window) => window.provider)).toEqual([
    "antigravity",
    "antigravity",
    "codex",
    "codex",
  ]);
  db.close();
});

test("resets suppress stored Codex reset credits when Codex is disabled", () => {
  const db = testDb();
  saveSnapshot(db, snapshot("warp"));
  saveResetCredits(db, {
    provider: "codex",
    status: "ok",
    capturedAt: Date.now(),
    availableCount: 1,
    totalEarnedCount: 1,
    credits: [],
  });

  expect(buildResetsReport(db, ["warp"]).codexBankedResetCredits).toBeNull();
  db.close();
});

test("usage exposes imported Claude Web credits as structured, separately timestamped data", () => {
  const db = testDb();
  saveSnapshot(db, snapshot("anthropic"));
  setManualEntry(db, {
    provider: "anthropic",
    field: "claude_web_credit_snapshot",
    value: JSON.stringify({
      capturedAt: "2026-07-25T04:30:00Z",
      currentBalance: 84.97,
      balanceCredits: 84,
      currency: "USD",
      autoReloadEnabled: false,
      nextExpiresAt: "2026-09-19T00:00:00Z",
      promotionalTranches: [{
        remainingAmount: 84.96,
        grantedAmount: 100,
        expiresAt: "2026-09-19T00:00:00Z",
      }],
      campaign: {
        id: "fable_transition",
        granted: true,
        amount: 100,
        expiresAt: "2026-09-19T00:00:00Z",
      },
      purchases: {
        purchasedThisMonthAmount: 0,
        monthlyCapAmount: 2000,
        resetsAt: "2026-08-01T00:00:00Z",
        maxDiscountPercent: 30,
      },
    }),
    note: "Claude Web",
  });

  const web = buildUsageReport(db, ["anthropic"]).providers[0]!.anthropicWebCredits;
  expect(web?.source).toBe("claude_web_manual");
  expect(web?.currentBalance).toBe(84.97);
  expect(web?.promotionalTranches[0]).toEqual({
    remainingAmount: 84.96,
    grantedAmount: 100,
    expiresAt: Date.parse("2026-09-19T00:00:00Z"),
    expiresOn: "2026-09-19",
  });
  expect(web?.nextExpiresOn).toBe("2026-09-19");
  expect(web?.campaign?.id).toBe("fable_transition");
  expect(web?.campaign?.expiresOn).toBe("2026-09-19");
  expect(web?.purchases?.maxDiscountPercent).toBe(30);
  db.close();
});

function providerReport(provider: Provider): ProviderReport {
  const value = snapshot(provider);
  return {
    provider,
    status: value.status,
    source: value.source,
    dataAgeMs: 0,
    capturedAt: value.capturedAt,
    snapshot: value.snapshot,
    manualEntries: [],
  };
}

test("recommendation handles every single-provider configuration", () => {
  for (const provider of ["codex", "anthropic", "warp", "antigravity"] as Provider[]) {
    const usage: UsageReport = { generatedAt: Date.now(), providers: [providerReport(provider)] };
    const result = recommendModel("large_refactor", usage);
    expect(result.recommendation?.provider).toBe(provider);
    expect(result.alternates.every((candidate) => candidate.provider === provider)).toBeTrue();
  }
});

test("recommendation computes Antigravity headroom from modelWindows when fiveHour/weekly are absent", () => {
  const now = Date.now();
  const report: ProviderReport = {
    provider: "antigravity",
    status: "ok",
    source: "antigravity_local",
    dataAgeMs: 1_000,
    capturedAt: now,
    snapshot: {
      kind: "window",
      fiveHour: null,
      weekly: null,
      modelWindows: {
        "Gemini 4 Argon": { usedPercent: 35, resetsAt: now + 18 * 3_600_000 },
        "Claude Sonnet 4.5": { usedPercent: 90, resetsAt: now + 3_600_000 },
      },
      extra: { planType: "ultra" },
    },
    manualEntries: [],
  };

  const light = recommendModel("small_fix", { generatedAt: now, providers: [report] });
  const mid = recommendModel("feature", { generatedAt: now, providers: [report] });
  const frontier = recommendModel("large_refactor", { generatedAt: now, providers: [report] });

  expect(light.recommendation?.model).toBe("Gemini 3.8 Flash");
  expect(mid.recommendation?.model).toBe("Gemini 4 Argon");
  expect(frontier.recommendation?.model).toBe("Gemini 4 Neon");
  expect(mid.recommendation?.headroomPercent).toBe(65);
  expect(mid.recommendation?.constraint).toBe("Gemini 4 Argon window");
});

test("recommendation treats an exhausted Antigravity modelWindow as 0% headroom even with shared headroom", () => {
  const now = Date.now();
  const report: ProviderReport = {
    provider: "antigravity",
    status: "ok",
    source: "antigravity_local",
    dataAgeMs: 0,
    capturedAt: now,
    snapshot: {
      kind: "window",
      fiveHour: { usedPercent: 10, resetsAt: now + 3_600_000 },
      weekly: null,
      modelWindows: {
        "Gemini 4 Argon": { usedPercent: 100, resetsAt: now + 3_600_000 },
      },
    },
    manualEntries: [],
  };

  const result = recommendModel("feature", { generatedAt: now, providers: [report] });
  expect(result.recommendation?.model).not.toBe("Gemini 4 Argon");
  expect(result.recommendation?.headroomPercent).toBe(90);
  expect(result.warnings.some((w) => w.includes('falling back to adjacent tier'))).toBe(true);
});

test("recommendation never lends another Antigravity model's headroom to an exhausted candidate", () => {
  const now = 1_800_000_000_000;
  const snap = normalizeAvailableModels(
    {
      models: {
        "gemini-4-argon": {
          displayName: "Gemini 4 Argon",
          quotaInfo: { remainingFraction: 0.9, resetTime: new Date(now + 5 * 86_400_000).toISOString() },
        },
        "gemini-4-neon": {
          displayName: "Gemini 4 Neon",
          quotaInfo: { remainingFraction: 0.0, resetTime: new Date(now + 3 * 3_600_000).toISOString() },
        },
      },
    },
    now,
  );
  expect(snap).not.toBeNull();
  const result = recommendModel("large_refactor", {
    generatedAt: now,
    providers: [{
      provider: "antigravity",
      status: "ok",
      source: "antigravity_api",
      dataAgeMs: 0,
      capturedAt: now,
      snapshot: snap,
      manualEntries: [],
    }],
  });

  expect(result.recommendation?.model).toBe("Gemini 4 Argon");
  expect(result.recommendation?.headroomPercent).toBe(90);
  expect(result.warnings.some((w) => w.includes('falling back to adjacent tier "mid"'))).toBe(true);
});

test("model-only Antigravity snapshot flows from collectAntigravity into usage, resets, and stale fallback", async () => {
  const db = testDb();
  const now = Date.now();
  const goodAt = now - 5 * 60_000;
  const resetAt = now + 3 * 3_600_000;
  const collected = await collectAntigravity({
    now: () => goodAt,
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    env: { ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: JSON.stringify({ access_token: "tok", expiry_date: now + 3_600_000 }) },
    request: (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      if (url.endsWith(":loadCodeAssist")) return Response.json({ paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } });
      if (url.endsWith(":retrieveUserQuotaSummary")) return new Response("not found", { status: 404 });
      if (url.endsWith(":fetchAvailableModels")) {
        return Response.json({
          models: {
            "gemini-4-neon": { displayName: "Gemini 4 Neon", quotaInfo: { remainingFraction: 0.65, resetTime: new Date(resetAt).toISOString() } },
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch,
  });
  expect(collected.status).toBe("ok");
  saveSnapshot(db, collected);

  const resets = buildResetsReport(db, ["antigravity"]);
  expect(resets.windows).toEqual([
    {
      provider: "antigravity",
      window: "model:Gemini 4 Neon",
      usedPercent: 35,
      resetsAt: resetAt,
      capturedAt: goodAt,
    },
  ]);

  saveSnapshot(db, {
    provider: "antigravity",
    status: "stale",
    source: "antigravity_api",
    dataAsOf: null,
    capturedAt: now - 10_000,
    snapshot: null,
    error: "Antigravity OAuth access token expired",
  });

  const report = buildUsageReport(db, ["antigravity"]).providers[0]!;
  expect(report.status).toBe("stale");
  expect(report.servingLastGood).toBe(true);
  expect(report.capturedAt).toBe(goodAt);
  expect(report.error).toContain("expired");
  expect(report.snapshot?.kind === "window" && report.snapshot.modelWindows?.["Gemini 4 Neon"]?.usedPercent).toBe(35);
  db.close();
});

test("recommendation returns no candidate instead of throwing for an empty report", () => {
  const result = recommendModel("feature", { generatedAt: Date.now(), providers: [] });
  expect(result.recommendation).toBeNull();
  expect(result.reason).toContain("No provider");
});
