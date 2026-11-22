import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { saveResetCredits, saveSnapshot, setManualEntry } from "../src/db";
import { collectAntigravity, normalizeAvailableModels, normalizeModelConfigs, normalizeQuotaSummary } from "../src/collectors/antigravity";
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
      extra: {
        planType: "ultra",
        modelWindowIdentity: {
          "Gemini 4 Argon": { model: "gemini-4-argon", family: "gemini" },
          "Claude Sonnet 4.5": { model: "claude-sonnet-4-5", family: null },
        },
      },
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
      extra: { modelWindowIdentity: { "Gemini 4 Argon": { model: "gemini-4-argon", family: "gemini" } } },
    },
    manualEntries: [],
  };

  const result = recommendModel("feature", { generatedAt: now, providers: [report] });
  expect(result.recommendation?.model).not.toBe("Gemini 4 Argon");
  expect(result.recommendation?.headroomPercent).toBe(90);
  expect(result.warnings.some((w) => w.includes('falling back to adjacent tier'))).toBe(true);
});

/** The server's model list (GetUserStatus groupedModels), which decides which summary groups are model-specific. */
const KNOWN_MODELS = [
  { id: "gemini-4-argon", displayName: "Gemini 4 Argon" },
  { id: "gemini-4-neon", displayName: "Gemini 4 Neon" },
  { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash" },
];

function recommendFrom(
  snapshot: ProviderReport["snapshot"],
  task: Parameters<typeof recommendModel>[0] = "feature",
): string {
  expect(snapshot).not.toBeNull();
  const now = 1_800_000_000_000;
  const rec = recommendModel(task, {
    generatedAt: now,
    providers: [{
      provider: "antigravity",
      status: "ok",
      source: "antigravity_local",
      dataAgeMs: 0,
      capturedAt: now,
      snapshot,
      manualEntries: [],
    }],
  }).recommendation;
  return `${rec?.model}@${rec?.headroomPercent}`;
}

test("per-model entries are identified only by their exact model ID", () => {
  const now = 1_800_000_000_000;
  // A short display name does not matter: the ID says Neon.
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
  const byId = recommendModel("large_refactor", {
    generatedAt: now,
    providers: [{ provider: "antigravity", status: "ok", source: "antigravity_api", dataAgeMs: 0, capturedAt: now, snapshot: snap, manualEntries: [] }],
  });
  expect(byId.recommendation?.model).toBe("Gemini 4 Argon");
  expect(byId.recommendation?.headroomPercent).toBe(90);
  expect(byId.warnings.some((w) => w.includes('falling back to adjacent tier "mid"'))).toBe(true);
  expect(byId.headroomByProvider[0]?.headroomPercent).toBe(0);
  expect(byId.headroomByProvider[0]?.constraint).toBe("Neon window");

  // Colliding display names stay separate by ID.
  expect(recommendFrom(normalizeAvailableModels({
    models: {
      "gemini-4-argon": { displayName: "Gemini 4", quotaInfo: { remainingFraction: 0.9 } },
      "gemini-4-neon": { displayName: "Gemini 4", quotaInfo: { remainingFraction: 0.0 } },
    },
  }))).toBe("Gemini 4 Argon@90");

  // A sibling ID never limits the base model, and a family-like ID limits only itself.
  for (const otherId of ["gemini-4-argon-lite", "gemini-4"]) {
    expect(recommendFrom(normalizeAvailableModels({
      models: {
        "gemini-4-argon": { displayName: "Gemini 4 Argon", quotaInfo: { remainingFraction: 0.9 } },
        [otherId]: { displayName: "Neon", quotaInfo: { remainingFraction: 0.0 } },
      },
    }))).toBe("Gemini 4 Argon@90");
  }

  // Real GetUserStatus entries: effort-suffixed IDs bind the base model; the
  // opaque modelOrAlias enum name is ignored.
  expect(recommendFrom(normalizeModelConfigs([
    { label: "Gemini 4 Argon (High)", modelId: "gemini-4-argon-high", modelOrAlias: { model: "MODEL_PLACEHOLDER_M417" }, quotaInfo: { remainingFraction: 0 } },
    { label: "Gemini 4 Argon (Low)", modelId: "gemini-4-argon-low", modelOrAlias: { model: "MODEL_PLACEHOLDER_M419" }, quotaInfo: { remainingFraction: 0 } },
    { label: "Gemini 3.8 Flash (High)", modelId: "gemini-3.8-flash-high", quotaInfo: { remainingFraction: 0.5 } },
  ]))).toBe("Gemini 3.8 Flash@50");

  // An entry without a model ID limits every Gemini model, unless it names only a partner.
  expect(recommendFrom(normalizeModelConfigs([
    { label: "Gemini 4 Argon", modelOrAlias: { model: "MODEL_PLACEHOLDER_M417" }, quotaInfo: { remainingFraction: 0.9 } },
    { label: "Mystery pool", quotaInfo: { remainingFraction: 0.2 } },
  ]))).toBe("Gemini 4 Argon@20");
  expect(recommendFrom(normalizeModelConfigs([
    { label: "Gemini 4 Argon", modelId: "gemini-4-argon", quotaInfo: { remainingFraction: 0.9 } },
    { label: "Claude Opus 5.5", quotaInfo: { remainingFraction: 0 } },
  ]))).toBe("Gemini 4 Argon@90");
  // Image-generation models and pools limit no Gemini text model.
  expect(recommendFrom(normalizeModelConfigs([
    { label: "Gemini 4 Argon", modelId: "gemini-4-argon", quotaInfo: { remainingFraction: 0.9 } },
    { label: "Gemini 3 Pro Image", modelId: "gemini-3-pro-image-preview", quotaInfo: { remainingFraction: 0 } },
    { label: "Imagen 4", modelId: "imagen-4.0-generate-001", quotaInfo: { remainingFraction: 0 } },
    { label: "Image generation", quotaInfo: { remainingFraction: 0 } },
  ]))).toBe("Gemini 4 Argon@90");

  // Non-Antigravity provider (Anthropic) with only modelWindows keeps null provider headroom.
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
});

test("a summary group is model-specific only when the server's model list names it", () => {
  const shared = { displayName: "Gemini Models", buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9 }] };
  const summary = (group: unknown, known = KNOWN_MODELS) =>
    normalizeQuotaSummary({ groups: [shared, group] as never }, null, undefined, known);

  // The group's display name or name matches a listed model: only that model is limited,
  // whatever the bucket labels, IDs, or windows say.
  for (const group of [
    { displayName: "Gemini 4 Argon", buckets: [{ bucketId: "gemini-argon-wtu-weekly", displayName: "Gemini 4 Argon Weekly Limit", window: "weekly", remainingFraction: 0 }] },
    { displayName: "Gemini 4 Argon", buckets: [{ displayName: "Session", remainingFraction: 0 }] },
    { displayName: "gemini 4  argon", buckets: [{ window: "3600s", remainingFraction: 0 }] },
    { name: "gemini-4-argon", displayName: "Argon", buckets: [{ displayName: "Neon", remainingFraction: 0 }] },
    { name: "models/gemini-4-argon-001", buckets: [{ displayName: "Weekly", remainingFraction: 0 }] },
  ]) {
    expect(recommendFrom(summary(group))).toBe("Gemini 3.8 Flash@90");
  }
  expect(recommendFrom(summary({ displayName: "Gemini 4 Neon", buckets: [{ displayName: "Weekly quota", remainingFraction: 0 }] }), "large_refactor"))
    .toBe("Gemini 4 Argon@90");

  // A partner pool limits no Gemini model.
  for (const group of [
    { displayName: "Claude and GPT models" },
    { displayName: "Claude / GPT" },
    { displayName: "Sonnet / Opus" },
    { name: "claude-gpt-pool", displayName: "Partner pool" },
  ]) {
    expect(recommendFrom(summary({ ...group, buckets: [{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0 }] })))
      .toBe("Gemini 4 Argon@90");
  }

  // An image-generation pool, or a group named by image model IDs, limits no
  // Gemini text model and never takes the shared slots.
  for (const group of [
    { displayName: "Image generation" },
    { displayName: "Gemini image generation" },
    { displayName: "Imagen" },
    { name: "imagen-4.0-generate-001" },
    { name: "gemini-3-pro-image-preview" },
  ]) {
    const snapshot = summary({ ...group, buckets: [{ bucketId: "image-daily", displayName: "Daily", remainingFraction: 0 }] });
    expect(recommendFrom(snapshot)).toBe("Gemini 4 Argon@90");
    expect(Object.values(snapshot?.extra?.modelWindowIdentity as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ family: "image" }),
    );
  }
  const imageOnly = normalizeQuotaSummary({ groups: [{ displayName: "Image generation", buckets: [{ window: "weekly", remainingFraction: 0 }] }] as never }, null, undefined, KNOWN_MODELS);
  expect(imageOnly?.weekly).toBeNull();
  expect(Object.values(imageOnly?.modelWindows ?? {})).toEqual([expect.objectContaining({ usedPercent: 100 })]);

  // Everything else limits every Gemini model (fails closed): no model list,
  // names and display names that disagree, IDs or names the server does not
  // list, and every label-only way of naming a model.
  const exhaustedEverywhere = [
    summary({ displayName: "Gemini 4 Argon", buckets: [{ displayName: "Weekly", remainingFraction: 0 }] }, []),
    summary({ name: "gemini-4-argon", displayName: "Gemini 4 Neon", buckets: [{ displayName: "Weekly", remainingFraction: 0 }] }),
    summary({ name: "gemini-4-neon", displayName: "Gemini 4 Argon", buckets: [{ displayName: "Weekly", remainingFraction: 0 }] }),
    summary({ name: "gemini-4-argon-lite", displayName: "Gemini 4 Argon", buckets: [{ displayName: "Weekly", remainingFraction: 0 }] }),
    summary({ name: "gemini-4", displayName: "Gemini 4", buckets: [{ displayName: "Gemini 4 Argon", remainingFraction: 0 }] }),
    summary({ displayName: "Gemini 4 Hydrogen", buckets: [{ displayName: "Weekly", remainingFraction: 0 }] }),
    summary({ displayName: "Gemini 4 Max", buckets: [{ displayName: "Max requests", remainingFraction: 0 }] }),
    summary({ displayName: "Google AI Ultra (Weekly)", buckets: [{ bucketId: "gemini-4-1", remainingFraction: 0 }] }),
    summary({ displayName: "Text and image generation", buckets: [{ displayName: "Weekly", remainingFraction: 0 }] }),
    summary({ name: "gemini-3-pro-image-preview", displayName: "Gemini 4 Argon", buckets: [{ displayName: "Weekly", remainingFraction: 0 }] }),
    summary({ displayName: "Partner models", buckets: [{ displayName: "Weekly", remainingFraction: 0 }] }),
  ];
  for (const snapshot of exhaustedEverywhere) {
    expect(recommendFrom(snapshot)).toEndWith("@0");
    expect(recommendFrom(snapshot, "small_fix")).toEndWith("@0");
    expect(recommendFrom(snapshot, "large_refactor")).toEndWith("@0");
  }
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

test("recommendation reads saved snapshots that predate extra.modelWindowIdentity", () => {
  const legacy = (modelWindows: Record<string, { usedPercent: number; resetsAt: null }>, extra: Record<string, unknown> = {}) => ({
    kind: "window" as const,
    fiveHour: { usedPercent: 10, resetsAt: null },
    weekly: null,
    modelWindows,
    extra,
  });
  // A recorded model ID, or a key that is a model ID (disambiguators removed), is exact.
  expect(recommendFrom(legacy({ "Gemini 4 (5h) [gemini-4-neon]": { usedPercent: 100, resetsAt: null } }, { modelWindowIds: { "Gemini 4 (5h) [gemini-4-neon]": "gemini-4-neon" } })))
    .toBe("Gemini 4 Argon@90");
  expect(recommendFrom(legacy({ "gemini-4-neon #2": { usedPercent: 100, resetsAt: null } }))).toBe("Gemini 4 Argon@90");
  expect(recommendFrom(legacy({ "gemini-4-argon": { usedPercent: 100, resetsAt: null } }))).toBe("Gemini 3.8 Flash@90");
  // A partner-only key limits no Gemini model.
  expect(recommendFrom(legacy({ "Claude / GPT (weekly)": { usedPercent: 100, resetsAt: null } }))).toBe("Gemini 4 Argon@90");
  // An image-generation key limits no Gemini text model.
  expect(recommendFrom(legacy({ "Image generation (weekly)": { usedPercent: 100, resetsAt: null } }))).toBe("Gemini 4 Argon@90");
  // Any other key limits every Gemini model, whatever the recorded endpoint spelling.
  for (const endpoint of ["RetrieveUserQuotaSummary", "retrieveUserQuotaSummary", "fetchAvailableModels", undefined]) {
    expect(recommendFrom(legacy({ "Gemini 4 Argon": { usedPercent: 100, resetsAt: null } }, { endpoint }))).toEndWith("@0");
    expect(recommendFrom(legacy({ rpm: { usedPercent: 100, resetsAt: null } }, { endpoint }))).toEndWith("@0");
  }
  // A current snapshot's identity record is authoritative, even over a model-like key,
  // and stored family scopes from older builds widen to every Gemini model.
  expect(recommendFrom(legacy({ "gemini-4-argon": { usedPercent: 100, resetsAt: null } }, { modelWindowIdentity: { "gemini-4-argon": { model: null, family: null } } })))
    .toBe("Gemini 4 Argon@90");
  expect(recommendFrom(legacy({ "Gemini 4 (weekly)": { usedPercent: 100, resetsAt: null } }, { modelWindowIdentity: { "Gemini 4 (weekly)": { model: null, family: "gemini-4" } } })))
    .toEndWith("@0");
});

test("Tactic A reads the Antigravity 2.34 CSRF token from the environment and resolves the real payload", async () => {
  const fixture = JSON.parse(await Bun.file(new URL("./fixtures/antigravity-2.34-local.json", import.meta.url)).text());
  const now = Date.parse("2026-11-22T15:00:00Z");
  const seenTokens: Array<string | undefined> = [];
  const collect = (summary: unknown) =>
    collectAntigravity({
      now: () => now,
      runCommand: async (argv) => {
        if (argv[0] === "ps" && argv[1] === "-ax") {
          return { exitCode: 0, stdout: "  950 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --app_data_dir antigravity\n", stderr: "" };
        }
        if (argv[0] === "ps") {
          return { exitCode: 0, stdout: "/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone HOME=/Users/x ANTIGRAVITY_SERVER_CSRF_TOKEN=env-token OTHER=1\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "language_ 950 luis 10u IPv4 0x1 0t0 TCP 127.0.0.1:51950 (LISTEN)\n", stderr: "" };
      },
      request: (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = String(input);
        seenTokens.push((init?.headers as Record<string, string> | undefined)?.["X-Codeium-Csrf-Token"]);
        if (url.endsWith("/RetrieveUserQuotaSummary")) return Response.json(summary);
        if (url.endsWith("/GetUserStatus")) return Response.json(fixture.GetUserStatus);
        return new Response("not found", { status: 404 });
      }) as typeof globalThis.fetch,
    });

  const collected = await collect(fixture.RetrieveUserQuotaSummary);
  expect(seenTokens[0]).toBe("env-token");
  expect(collected.status).toBe("ok");
  expect(collected.source).toBe("antigravity_local");
  expect(collected.snapshot?.kind).toBe("window");
  if (collected.snapshot?.kind !== "window") return;
  expect(collected.snapshot.fiveHour).toEqual({ usedPercent: 4.6, resetsAt: Date.parse("2026-11-22T17:53:53Z") });
  expect(collected.snapshot.weekly).toEqual({ usedPercent: 28.5, resetsAt: Date.parse("2026-11-28T18:47:31Z") });
  expect(collected.snapshot.extra?.planType).toBe("pro");
  expect(collected.snapshot.extra?.modelWindowIdentity).toEqual({
    "Claude and GPT models (weekly)": { model: null, family: null },
    "Claude and GPT models (5h)": { model: null, family: null },
    "Gemini 4 Argon Weekly Limit": { model: "gemini-4-argon", family: "gemini" },
  });
  expect(recommendFrom(collected.snapshot)).toBe("Gemini 4 Argon@71.5");

  // Exhausting each real group limits exactly what it covers.
  const exhaust = (groupName: string) => {
    const copy = structuredClone(fixture.RetrieveUserQuotaSummary);
    for (const group of copy.response.groups) {
      if (group.displayName === groupName) for (const bucket of group.buckets) bucket.remainingFraction = 0;
    }
    return copy;
  };
  const argonOut = await collect(exhaust("Gemini 4 Argon"));
  expect(recommendFrom(argonOut.snapshot)).toBe("Gemini 3.8 Flash@71.5");
  expect(recommendFrom(argonOut.snapshot, "large_refactor")).toBe("Gemini 4 Neon@71.5");
  const partnerOut = await collect(exhaust("Claude and GPT models"));
  expect(recommendFrom(partnerOut.snapshot)).toBe("Gemini 4 Argon@71.5");
  const sharedOut = await collect(exhaust("Gemini Models"));
  for (const task of ["small_fix", "feature", "large_refactor"] as const) {
    expect(recommendFrom(sharedOut.snapshot, task)).toEndWith("@0");
  }
});

test("recommendation returns no candidate instead of throwing for an empty report", () => {
  const result = recommendModel("feature", { generatedAt: Date.now(), providers: [] });
  expect(result.recommendation).toBeNull();
  expect(result.reason).toContain("No provider");
});
