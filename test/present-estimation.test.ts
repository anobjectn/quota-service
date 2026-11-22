import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { saveResetCredits, saveSnapshot, setManualEntry } from "../src/db";
import { collectAntigravity, normalizeAvailableModels, normalizeQuotaSummary } from "../src/collectors/antigravity";
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

test("recommendation measures only matching Antigravity modelWindows and falls back honestly for unmeasured tiers", () => {
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
        "Gemini 4 Argon": { usedPercent: 10, resetsAt: now + 18 * 3_600_000 },
        "Claude Sonnet 4.5": { usedPercent: 90, resetsAt: now + 3_600_000 },
      },
      extra: { planType: "ultra" },
    },
    manualEntries: [],
  };

  const light = recommendModel("small_fix", { generatedAt: now, providers: [report] });
  const mid = recommendModel("feature", { generatedAt: now, providers: [report] });
  const frontier = recommendModel("large_refactor", { generatedAt: now, providers: [report] });

  // Only Gemini 4 Argon has a measured bucket; unmeasured tiers fall back to Argon
  // instead of claiming Neon or Flash has Argon's headroom.
  expect(mid.recommendation?.model).toBe("Gemini 4 Argon");
  expect(mid.recommendation?.headroomPercent).toBe(90);
  expect(mid.recommendation?.constraint).toBe("Gemini 4 Argon window");

  expect(frontier.recommendation?.model).toBe("Gemini 4 Argon");
  expect(frontier.recommendation?.headroomPercent).toBe(90);
  expect(frontier.warnings.some((w) => w.includes('falling back to adjacent tier "mid"'))).toBe(true);

  expect(light.recommendation?.model).toBe("Gemini 4 Argon");
  expect(light.warnings.some((w) => w.includes('falling back to adjacent tier "mid"'))).toBe(true);
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

test("recommendation matches canonical model IDs when display labels differ and does not conflate sibling variant names", () => {
  const now = 1_800_000_000_000;
  // Short displayName "Neon" still resolves to Gemini 4 Neon via modelWindowIds.
  const snap = normalizeAvailableModels({
    models: {
      "gemini-4-neon": {
        displayName: "Neon",
        quotaInfo: { remainingFraction: 0.0, resetTime: new Date(now + 3 * 3_600_000).toISOString() },
      },
      "gemini-4-argon": {
        displayName: "Gemini 4 Argon",
        quotaInfo: { remainingFraction: 0.9, resetTime: new Date(now + 5 * 86_400_000).toISOString() },
      },
    },
  });
  expect(snap).not.toBeNull();
  const byId = recommendModel("large_refactor", {
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
  expect(byId.recommendation?.model).toBe("Gemini 4 Argon");
  expect(byId.recommendation?.headroomPercent).toBe(90);
  expect(byId.warnings.some((w) => w.includes('falling back to adjacent tier "mid"'))).toBe(true);
  // Provider-level headroom summary also sees "Neon" as a Gemini bucket via modelWindowIds.
  expect(byId.headroomByProvider[0]?.headroomPercent).toBe(0);
  expect(byId.headroomByProvider[0]?.constraint).toBe("Neon window");

  // Colliding display names ("Gemini 4") stay separate by canonical ID.
  const collidingSnap = normalizeAvailableModels({
    models: {
      "gemini-4-argon": { displayName: "Gemini 4", quotaInfo: { remainingFraction: 0.9 } },
      "gemini-4-neon": { displayName: "Gemini 4", quotaInfo: { remainingFraction: 0.0 } },
    },
  });
  expect(collidingSnap).not.toBeNull();
  const collidingRec = recommendModel("feature", {
    generatedAt: now,
    providers: [{
      provider: "antigravity",
      status: "ok",
      source: "antigravity_api",
      dataAgeMs: 0,
      capturedAt: now,
      snapshot: collidingSnap,
      manualEntries: [],
    }],
  });
  expect(collidingRec.recommendation?.model).toBe("Gemini 4 Argon");
  expect(collidingRec.recommendation?.headroomPercent).toBe(90);

  // Exhausted "Gemini 4 Argon Lite" and parenthesized "Gemini 4 Argon (Lite)" must not constrain "Gemini 4 Argon".
  const parenthesizedSnap = normalizeAvailableModels({
    models: {
      "gemini-4-argon": { displayName: "Gemini 4 Argon", quotaInfo: { remainingFraction: 0.9 } },
      "gemini-4-argon-lite": { displayName: "Gemini 4 Argon (Lite)", quotaInfo: { remainingFraction: 0.0 } },
    },
  });
  const parenthesizedRec = recommendModel("feature", {
    generatedAt: now,
    providers: [{
      provider: "antigravity",
      status: "ok",
      source: "antigravity_api",
      dataAgeMs: 0,
      capturedAt: now,
      snapshot: parenthesizedSnap,
      manualEntries: [],
    }],
  });
  expect(parenthesizedRec.recommendation?.model).toBe("Gemini 4 Argon");
  expect(parenthesizedRec.recommendation?.headroomPercent).toBe(90);

  const variant = recommendModel("feature", {
    generatedAt: now,
    providers: [{
      provider: "antigravity",
      status: "ok",
      source: "antigravity_local",
      dataAgeMs: 0,
      capturedAt: now,
      snapshot: {
        kind: "window",
        fiveHour: null,
        weekly: null,
        modelWindows: {
          "Gemini 4 Argon Lite": { usedPercent: 100, resetsAt: now + 3_600_000 },
          "Gemini 4 Argon (Lite)": { usedPercent: 100, resetsAt: now + 3_600_000 },
          "Gemini 4 Argon": { usedPercent: 10, resetsAt: now + 3_600_000 },
        },
      },
      manualEntries: [],
    }],
  });
  expect(variant.recommendation?.model).toBe("Gemini 4 Argon");
  expect(variant.recommendation?.headroomPercent).toBe(90);

  // Non-primary group-prefixed cadence labels ("Gemini 4 Argon 5-hour", "Gemini 4 Argon - Weekly")
  // still match Gemini 4 Argon via extra.modelWindowIds and avoid recommending it when exhausted.
  for (const bucketLabel of ["Gemini 4 Argon 5-hour", "Gemini 4 Argon - Weekly", "Gemini 4 Argon Weekly Limit"]) {
    const prefixedSnap = normalizeQuotaSummary({
      groups: [
        { displayName: "Gemini", buckets: [{ displayName: "Session", remainingFraction: 0.9 }] },
        { displayName: "Gemini 4 Argon", buckets: [{ displayName: bucketLabel, remainingFraction: 0.0 }] },
      ],
    });
    expect(prefixedSnap).not.toBeNull();
    const prefixedRec = recommendModel("feature", {
      generatedAt: now,
      providers: [{
        provider: "antigravity",
        status: "ok",
        source: "antigravity_local",
        dataAgeMs: 0,
        capturedAt: now,
        snapshot: prefixedSnap,
        manualEntries: [],
      }],
    });
    expect(prefixedRec.recommendation?.model).toBe("Gemini 3.8 Flash");
    expect(prefixedRec.recommendation?.headroomPercent).toBe(90);
  }

  // Family-level group ("Gemini 4") holding per-model buckets and versioned group name ("gemini-4-argon-001")
  // still bind Gemini 4 Argon properly in recommendModel.
  const familySnap = normalizeQuotaSummary({
    groups: [
      { displayName: "Gemini", buckets: [{ displayName: "Session", remainingFraction: 0.9 }] },
      { displayName: "Gemini 4", buckets: [{ displayName: "Gemini 4 Argon", remainingFraction: 0.0 }, { displayName: "Gemini 4 Neon", remainingFraction: 0.5 }] },
    ],
  });
  expect(familySnap).not.toBeNull();
  const familyRec = recommendModel("feature", {
    generatedAt: now,
    providers: [{
      provider: "antigravity",
      status: "ok",
      source: "antigravity_local",
      dataAgeMs: 0,
      capturedAt: now,
      snapshot: familySnap,
      manualEntries: [],
    }],
  });
  expect(familyRec.recommendation?.model).toBe("Gemini 3.8 Flash");
  expect(familyRec.recommendation?.headroomPercent).toBe(90);

  const versionedSnap = normalizeQuotaSummary({
    groups: [
      { displayName: "Gemini", buckets: [{ displayName: "Session", remainingFraction: 0.9 }] },
      { name: "gemini-4-argon-001", displayName: "Gemini 4 Argon", buckets: [{ displayName: "Weekly", remainingFraction: 0.0 }] },
    ],
  });
  expect(versionedSnap).not.toBeNull();
  const versionedRec = recommendModel("feature", {
    generatedAt: now,
    providers: [{
      provider: "antigravity",
      status: "ok",
      source: "antigravity_local",
      dataAgeMs: 0,
      capturedAt: now,
      snapshot: versionedSnap,
      manualEntries: [],
    }],
  });
  expect(versionedRec.recommendation?.model).toBe("Gemini 3.8 Flash");
  expect(versionedRec.recommendation?.headroomPercent).toBe(90);

  // Non-Antigravity provider (Anthropic) with only modelWindows keeps null provider headroom
  // (unchanged from base: light/mid stay unmeasured, while frontier still uses computeAnthropicFrontierHeadroom).
  const anthUsage: UsageReport = {
    generatedAt: now,
    providers: [{
      provider: "anthropic",
      status: "ok",
      source: "anthropic_api",
      dataAgeMs: 0,
      capturedAt: now,
      snapshot: {
        kind: "window",
        fiveHour: null,
        weekly: null,
        modelWindows: { Fable: { usedPercent: 20, resetsAt: now + 86_400_000 } },
      },
      manualEntries: [],
    }],
  };
  const anthLight = recommendModel("small_fix", anthUsage);
  expect(anthLight.headroomByProvider[0]?.headroomPercent).toBeNull();
  expect(anthLight.recommendation?.headroomPercent).toBeNull();
  const anthMid = recommendModel("feature", anthUsage);
  expect(anthMid.headroomByProvider[0]?.headroomPercent).toBeNull();
  expect(anthMid.recommendation?.model).toBe("Fable 5 / Opus 4.8");
  expect(anthMid.recommendation?.headroomPercent).toBe(80);

  // Non-primary 1h and "Weekly quota" buckets preserve group identity so recommendation avoids exhausted models.
  const argonExhaustedSnap = normalizeQuotaSummary({
    groups: [
      { displayName: "Gemini", buckets: [{ window: "18000s", remainingFraction: 0.9 }] },
      { displayName: "Gemini 4 Argon", buckets: [{ window: "3600s", remainingFraction: 0.0 }] },
      { displayName: "Claude / GPT", buckets: [{ window: "3600s", remainingFraction: 0.8 }] },
    ],
  });
  expect(argonExhaustedSnap).not.toBeNull();
  const midSummary = recommendModel("feature", {
    generatedAt: now,
    providers: [{
      provider: "antigravity",
      status: "ok",
      source: "antigravity_local",
      dataAgeMs: 0,
      capturedAt: now,
      snapshot: argonExhaustedSnap,
      manualEntries: [],
    }],
  });
  expect(midSummary.recommendation?.model).toBe("Gemini 3.8 Flash");
  expect(midSummary.recommendation?.headroomPercent).toBe(90);

  const neonExhaustedSnap = normalizeQuotaSummary({
    groups: [
      { displayName: "Gemini", buckets: [{ displayName: "Weekly", remainingFraction: 0.9 }] },
      { displayName: "Gemini 4 Neon", buckets: [{ displayName: "Weekly quota", remainingFraction: 0.0 }] },
    ],
  });
  expect(neonExhaustedSnap).not.toBeNull();
  const frontierSummary = recommendModel("large_refactor", {
    generatedAt: now,
    providers: [{
      provider: "antigravity",
      status: "ok",
      source: "antigravity_local",
      dataAgeMs: 0,
      capturedAt: now,
      snapshot: neonExhaustedSnap,
      manualEntries: [],
    }],
  });
  expect(frontierSummary.recommendation?.model).toBe("Gemini 4 Argon");
  expect(frontierSummary.recommendation?.headroomPercent).toBe(90);
});

test("resets emit model:<name> windows only for Antigravity, preserving existing Anthropic output", () => {
  const db = testDb();
  const now = Date.now();
  saveSnapshot(db, {
    provider: "anthropic",
    status: "ok",
    source: "anthropic_api",
    dataAsOf: now,
    capturedAt: now,
    snapshot: {
      kind: "window",
      fiveHour: { usedPercent: 15, resetsAt: now + 3_600_000 },
      weekly: { usedPercent: 25, resetsAt: now + 86_400_000 },
      modelWindows: {
        Fable: { usedPercent: 5, resetsAt: now + 86_400_000 },
      },
    },
  });
  const resets = buildResetsReport(db, ["anthropic"]);
  expect(resets.windows.map((w) => w.window)).toEqual(["fiveHour", "weekly"]);
  db.close();
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

test("Tactic A RetrieveUserQuotaSummary plan enrichment preserves extra.modelWindowIds for recommendModel", async () => {
  const now = Date.now();
  const collected = await collectAntigravity({
    now: () => now,
    runCommand: async (argv) =>
      argv[0] === "ps"
        ? { exitCode: 0, stdout: "  950 /Applications/Antigravity.app/Contents/Resources/language_server --csrf_token tok\n", stderr: "" }
        : { exitCode: 0, stdout: "language_ 950 luis 10u IPv4 0x1 0t0 TCP 127.0.0.1:51950 (LISTEN)\n", stderr: "" },
    request: (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/RetrieveUserQuotaSummary")) {
        return Response.json({
          groups: [
            { displayName: "Gemini", buckets: [{ displayName: "Session", remainingFraction: 0.9 }] },
            { name: "gemini-4-argon", displayName: "Argon", buckets: [{ displayName: "Interactive", window: "18000s", remainingFraction: 0 }] },
          ],
        });
      }
      if (url.endsWith("/GetUserStatus")) {
        return Response.json({ userStatus: { userTier: { id: "g1-ultra-tier", name: "Google AI Ultra" } } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch,
  });

  expect(collected.status).toBe("ok");
  expect(collected.source).toBe("antigravity_local");
  expect(collected.snapshot?.kind).toBe("window");
  if (collected.snapshot?.kind === "window") {
    expect(collected.snapshot.extra?.planType).toBe("ultra");
    expect(collected.snapshot.extra?.modelWindowIds).toEqual({
      "Argon (Interactive, 5h)": "gemini-4-argon",
    });
  }

  const rec = recommendModel("feature", {
    generatedAt: now,
    providers: [{
      provider: "antigravity",
      status: "ok",
      source: collected.source,
      dataAgeMs: 0,
      capturedAt: now,
      snapshot: collected.snapshot,
      manualEntries: [],
    }],
  });
  expect(rec.recommendation?.model).toBe("Gemini 3.8 Flash");
  expect(rec.recommendation?.headroomPercent).toBe(90);
});

test("recommendation returns no candidate instead of throwing for an empty report", () => {
  const result = recommendModel("feature", { generatedAt: Date.now(), providers: [] });
  expect(result.recommendation).toBeNull();
  expect(result.reason).toContain("No provider");
});
