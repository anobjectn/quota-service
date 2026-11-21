import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { saveResetCredits, saveSnapshot, setManualEntry } from "../src/db";
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

test("usage serves last-known Antigravity snapshot as stale when newest attempt fails", () => {
  const db = testDb();
  const now = Date.now();
  const goodAt = now - 5 * 60_000;
  saveSnapshot(db, {
    provider: "antigravity",
    status: "ok",
    source: "antigravity_local",
    dataAsOf: goodAt,
    capturedAt: goodAt,
    snapshot: {
      kind: "window",
      fiveHour: { usedPercent: 15, resetsAt: now + 3_600_000 },
      weekly: { usedPercent: 40, resetsAt: now + 5 * 86_400_000 },
      extra: { planType: "pro" },
    },
  });
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
  expect(report.snapshot?.kind === "window" && report.snapshot.fiveHour?.usedPercent).toBe(15);
  db.close();
});

test("recommendation returns no candidate instead of throwing for an empty report", () => {
  const result = recommendModel("feature", { generatedAt: Date.now(), providers: [] });
  expect(result.recommendation).toBeNull();
  expect(result.reason).toContain("No provider");
});
