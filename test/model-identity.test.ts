import { describe, expect, test } from "bun:test";
import {
  identityConstrainsModel,
  parseModelIdentity,
  resolveLabelIdentity,
} from "../src/model-identity";

describe("parseModelIdentity", () => {
  test.each([
    // Models: family + version + name, with cadence/release/effort/container words ignored.
    ["Gemini 4 Argon", "gemini-4-argon", "gemini-4"],
    ["models/gemini-4-argon-001", "gemini-4-argon", "gemini-4"],
    ["gemini-4-argon-exp", "gemini-4-argon", "gemini-4"],
    ["gemini-4-argon-pool", "gemini-4-argon", "gemini-4"],
    ["gemini-4-argon-weekly", "gemini-4-argon", "gemini-4"],
    ["gemini-4-neon-high", "gemini-4-neon", "gemini-4"],
    ["Gemini 4 Argon 5-hour", "gemini-4-argon", "gemini-4"],
    ["Gemini 4 Argon Interactive", "gemini-4-argon", "gemini-4"],
    ["Gemini 4 (Argon, 5h)", "gemini-4-argon", "gemini-4"],
    ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8"],
    // Variants are distinct models.
    ["Gemini 4 Argon (Lite)", "gemini-4-argon-lite", "gemini-4"],
    ["gemini-4-argon-lite", "gemini-4-argon-lite", "gemini-4"],
    ["Gemini 3.8 Flash Lite", "gemini-3.8-flash-lite", "gemini-3.8"],
    // Families without a model.
    ["Gemini 4", null, "gemini-4"],
    ["Gemini 4 Models", null, "gemini-4"],
    ["gemini-4-weekly", null, "gemini-4"],
    // No identity: an unversioned Gemini name or ID is account-level.
    ["Gemini", null, null],
    ["Gemini Weekly", null, null],
    ["gemini-free-tier-weekly", null, null],
    ["gemini_code_assist_weekly", null, null],
    ["prod_gemini_quota_1", null, null],
    ["prod_quota_1", null, null],
    ["Claude / GPT", null, null],
    // Partner models never carry a Gemini family.
    ["claude-sonnet-4-5", "claude-sonnet-4-5", null],
  ])("%s", (text, model, family) => {
    expect(parseModelIdentity(text)).toEqual({ model, family });
  });
});

describe("resolveLabelIdentity", () => {
  test("a label without a family word extends the group identity", () => {
    const argon = parseModelIdentity("gemini-4-argon");
    const family = parseModelIdentity("gemini-4");
    expect(resolveLabelIdentity("Argon", family).model).toBe("gemini-4-argon");
    expect(resolveLabelIdentity("(Lite)", argon).model).toBe("gemini-4-argon-lite");
    expect(resolveLabelIdentity("Weekly", argon).model).toBe("gemini-4-argon");
    expect(resolveLabelIdentity("Argon", { model: null, family: null })).toEqual({ model: null, family: null });
  });
});

describe("identityConstrainsModel", () => {
  const argon = parseModelIdentity("gemini-4-argon");
  test("model windows limit only the same model", () => {
    expect(identityConstrainsModel(parseModelIdentity("Gemini 4 Argon (weekly)"), argon)).toBe(true);
    expect(identityConstrainsModel(parseModelIdentity("gemini-4-argon-lite"), argon)).toBe(false);
    expect(identityConstrainsModel(parseModelIdentity("gemini-4-neon"), argon)).toBe(false);
  });
  test("family windows limit every model in the family, and no identity limits nothing", () => {
    expect(identityConstrainsModel(parseModelIdentity("Gemini 4"), argon)).toBe(true);
    expect(identityConstrainsModel(parseModelIdentity("Gemini 3"), parseModelIdentity("gemini-3.8-flash"))).toBe(true);
    expect(identityConstrainsModel(parseModelIdentity("Gemini 3"), argon)).toBe(false);
    expect(identityConstrainsModel(parseModelIdentity("Gemini"), argon)).toBe(false);
  });
});
