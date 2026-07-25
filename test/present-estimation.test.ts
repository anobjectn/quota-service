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
  for (const provider of ["codex", "anthropic", "warp"] as Provider[]) saveSnapshot(db, snapshot(provider));

  expect(buildUsageReport(db, ["warp", "codex"]).providers.map((report) => report.provider)).toEqual(["warp", "codex"]);
  const resets = buildResetsReport(db, ["warp", "codex"]);
  expect(resets.pools.map((pool) => pool.provider)).toEqual(["warp"]);
  expect(resets.windows.map((window) => window.provider)).toEqual(["codex", "codex"]);
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
  for (const provider of ["codex", "anthropic", "warp"] as Provider[]) {
    const usage: UsageReport = { generatedAt: Date.now(), providers: [providerReport(provider)] };
    const result = recommendModel("large_refactor", usage);
    expect(result.recommendation?.provider).toBe(provider);
    expect(result.alternates.every((candidate) => candidate.provider === provider)).toBeTrue();
  }
});

test("recommendation returns no candidate instead of throwing for an empty report", () => {
  const result = recommendModel("feature", { generatedAt: Date.now(), providers: [] });
  expect(result.recommendation).toBeNull();
  expect(result.reason).toContain("No provider");
});
