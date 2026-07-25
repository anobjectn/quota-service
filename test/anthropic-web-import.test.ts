import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { normalizeAnthropicWebImport } from "../src/anthropic-web-import";
import { setManualEntry } from "../src/db";
import { buildUsageReport } from "../src/present";
import type { AnthropicWebCredits } from "../src/types";

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

/** Full route round-trip: normalize (the POST /anthropic-web-import handler) ->
 * persist -> present, exactly as the server wires it. */
function importAndParse(body: Record<string, unknown>): AnthropicWebCredits {
  const db = testDb();
  const snapshot = normalizeAnthropicWebImport(body);
  setManualEntry(db, {
    provider: "anthropic",
    field: "claude_web_credit_snapshot",
    value: JSON.stringify(snapshot),
    note: null,
  });
  const web = buildUsageReport(db, ["anthropic"]).providers[0]!.anthropicWebCredits;
  db.close();
  expect(web).not.toBeNull();
  return web!;
}

test("promoRemaining present yields exactly one tranche with the right amounts and expiry", () => {
  const web = importAndParse({
    promoRemaining: 75.5,
    promoGranted: 100,
    promoExpiresAt: "2026-09-19",
  });
  expect(web.promotionalTranches).toHaveLength(1);
  expect(web.promotionalTranches[0]).toEqual({
    remainingAmount: 75.5,
    grantedAmount: 100,
    expiresAt: Date.parse("2026-09-19"),
    expiresOn: "2026-09-19",
  });
});

test("promoRemaining absent yields an empty tranche list", () => {
  const web = importAndParse({ currentBalance: 10 });
  expect(web.promotionalTranches).toEqual([]);
});

test("campaignId present yields a campaign object; absent yields null", () => {
  const withCampaign = importAndParse({ campaignId: "fable_transition", campaignGranted: true, campaignAmount: 100 });
  expect(withCampaign.campaign?.id).toBe("fable_transition");
  expect(withCampaign.campaign?.granted).toBe(true);
  expect(withCampaign.campaign?.amount).toBe(100);

  const withoutCampaign = importAndParse({ currentBalance: 5 });
  expect(withoutCampaign.campaign).toBeNull();
});

test("a single promoExpiresAt fans out to tranche, campaign, and nextExpiresAt (all equal, consumers dedupe)", () => {
  const web = importAndParse({
    promoRemaining: 75.5,
    promoExpiresAt: "2026-09-19",
    campaignId: "fable_transition",
  });
  const expected = Date.parse("2026-09-19");
  expect(web.promotionalTranches[0]?.expiresAt).toBe(expected);
  expect(web.campaign?.expiresAt).toBe(expected);
  expect(web.nextExpiresAt).toBe(expected);
});

test("date-only expiry keeps its UTC calendar date (2026-09-19, not the day before)", () => {
  const web = importAndParse({ promoRemaining: 1, promoExpiresAt: "2026-09-19" });
  expect(web.nextExpiresOn).toBe("2026-09-19");
  expect(web.promotionalTranches[0]?.expiresOn).toBe("2026-09-19");
});

test("currency is uppercased; omitted defaults to USD", () => {
  expect(importAndParse({ currency: "usd", currentBalance: 1 }).currency).toBe("USD");
  expect(importAndParse({ currentBalance: 1 }).currency).toBe("USD");
});

test("currentBalance and balanceCredits both round-trip from their own import keys", () => {
  const web = importAndParse({ currentBalance: 75.51, balanceCredits: 84 });
  expect(web.currentBalance).toBe(75.51);
  expect(web.balanceCredits).toBe(84);
});

test("missing numerics become null", () => {
  const web = importAndParse({ campaignId: "c" });
  expect(web.currentBalance).toBeNull();
  expect(web.balanceCredits).toBeNull();
  expect(web.nextExpiresAt).toBeNull();
  expect(web.nextExpiresOn).toBeNull();
  expect(web.campaign?.amount).toBeNull();
});

test("invalid numeric input throws the field-specific validation error at the route boundary", () => {
  expect(() => normalizeAnthropicWebImport({ currentBalance: "abc" })).toThrow("currentBalance must be a non-negative number");
  expect(() => normalizeAnthropicWebImport({ currentBalance: -5 })).toThrow("currentBalance must be a non-negative number");
  expect(() => normalizeAnthropicWebImport({ promoExpiresAt: "not-a-date" })).toThrow("promoExpiresAt must be a valid date");
});
