import { describe, expect, test } from "bun:test";
import {
  ALL_GEMINI_IDENTITY,
  identityConstrainsModel,
  isQualifierOnlyText,
  mergeModelIdentities,
  parseModelIdentity,
  resolveLabelIdentity,
} from "../src/model-identity";

describe("parseModelIdentity", () => {
  test.each([
    // Models: family + version + a known name; every other word is ignored.
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
    // Version spellings normalize.
    ["Gemini 4.0 Argon", "gemini-4-argon", "gemini-4"],
    ["gemini-4.0-argon-weekly", "gemini-4-argon", "gemini-4"],
    ["gemini-2-5-flash", "gemini-2.5-flash", "gemini-2.5"],
    ["Gemini 4 5 hour", null, "gemini-4"],
    // Prefixed resource names and repeated family words keep the narrowest agreeing identity.
    ["projects/gemini-prod/models/gemini-4-argon", "gemini-4-argon", "gemini-4"],
    ["Gemini: Gemini 4 Argon", "gemini-4-argon", "gemini-4"],
    ["gemini_quota_gemini-4-argon", "gemini-4-argon", "gemini-4"],
    ["Gemini 4 Argon (Gemini Weekly)", "gemini-4-argon", "gemini-4"],
    // Variants are distinct models.
    ["Gemini 4 Argon (Lite)", "gemini-4-argon-lite", "gemini-4"],
    ["gemini-4-argon-lite", "gemini-4-argon-lite", "gemini-4"],
    ["Gemini 3.8 Flash Lite", "gemini-3.8-flash-lite", "gemini-3.8"],
    // Families: no known name, or two names (a pool over both).
    ["Gemini 4", null, "gemini-4"],
    ["Gemini 4 Models", null, "gemini-4"],
    ["gemini-4-weekly", null, "gemini-4"],
    ["gemini-4-7days", null, "gemini-4"],
    ["Gemini 4 Interactive", null, "gemini-4"],
    ["Gemini 4 Family", null, "gemini-4"],
    ["Gemini 4 Agent Mode", null, "gemini-4"],
    ["Gemini 4 requests per day", null, "gemini-4"],
    ["Gemini 4 Argon and Neon", null, "gemini-4"],
    ["Gemini 4 (Argon + Neon)", null, "gemini-4"],
    ["Gemini 4 Argon / Neon", null, "gemini-4"],
    ["Gemini 4 Argon, Gemini 4 Neon", null, "gemini-4"],
    ["Gemini 4 Argon, Gemini 3.8 Flash", null, "gemini"],
    // All Gemini: Gemini without a version is a shared or account-level quota.
    ["Gemini", null, "gemini"],
    ["Gemini Weekly", null, "gemini"],
    ["Gemini (5 hours)", null, "gemini"],
    ["Gemini Neon", null, "gemini"],
    ["gemini-free-tier-weekly", null, "gemini"],
    ["gemini_code_assist_weekly", null, "gemini"],
    ["prod_gemini_quota_1", null, "gemini"],
    // No identity: no model family at all, or only partner families.
    ["prod_quota_1", null, null],
    ["Weekly requests", null, null],
    ["Claude / GPT", null, null],
    ["Claude / GPT (5h)", null, null],
    // Partner models never carry a Gemini family.
    ["claude-sonnet-4-5", "claude-sonnet-4-5", null],
    ["gpt-oss-120b", "gpt-oss-120b", null],
  ])("%s", (text, model, family) => {
    expect(parseModelIdentity(text)).toEqual({ model, family });
  });
});

describe("mergeModelIdentities", () => {
  const p = parseModelIdentity;
  test("agreeing sources keep the narrowest identity", () => {
    expect(mergeModelIdentities([p("gemini-4"), p("Gemini 4 Neon")]).model).toBe("gemini-4-neon");
    expect(mergeModelIdentities([p("gemini-4-argon-lite"), p("Gemini 4 Argon")]).model).toBe("gemini-4-argon-lite");
    expect(mergeModelIdentities([ALL_GEMINI_IDENTITY, p("gemini-4-argon")]).model).toBe("gemini-4-argon");
  });
  test("conflicting sources widen to their common scope", () => {
    expect(mergeModelIdentities([p("gemini-4-argon"), p("gemini-4-neon")])).toEqual({ model: null, family: "gemini-4" });
    expect(mergeModelIdentities([p("gemini-4-argon"), p("gemini-3.8-flash")])).toEqual(ALL_GEMINI_IDENTITY);
    expect(mergeModelIdentities([p("gemini-4-argon"), p("claude-sonnet-4-5")])).toEqual(ALL_GEMINI_IDENTITY);
  });
});

describe("resolveLabelIdentity", () => {
  const argon = parseModelIdentity("gemini-4-argon");
  const family = parseModelIdentity("gemini-4");
  test("a short label extends a versioned context", () => {
    expect(resolveLabelIdentity("Argon", family).model).toBe("gemini-4-argon");
    expect(resolveLabelIdentity("Neon", family).model).toBe("gemini-4-neon");
    expect(resolveLabelIdentity("Gemini Neon", family).model).toBe("gemini-4-neon");
    expect(resolveLabelIdentity("(Lite)", argon).model).toBe("gemini-4-argon-lite");
    expect(resolveLabelIdentity("Gemini Lite", argon).model).toBe("gemini-4-argon-lite");
    expect(resolveLabelIdentity("Weekly", argon).model).toBe("gemini-4-argon");
    expect(resolveLabelIdentity("Interactive", family)).toEqual(family);
    expect(resolveLabelIdentity("Requests per day", family)).toEqual(family);
  });
  test("a label with its own version merges with the context", () => {
    const lite = parseModelIdentity("gemini-4-argon-lite");
    expect(resolveLabelIdentity("Gemini 4 Argon (Weekly)", lite).model).toBe("gemini-4-argon-lite");
    expect(resolveLabelIdentity("Gemini 4 Neon", argon)).toEqual(family);
  });
  test("an unversioned context is never narrowed by a short label", () => {
    expect(resolveLabelIdentity("Neon", ALL_GEMINI_IDENTITY)).toEqual(ALL_GEMINI_IDENTITY);
    expect(resolveLabelIdentity("5-hour session", ALL_GEMINI_IDENTITY)).toEqual(ALL_GEMINI_IDENTITY);
    expect(resolveLabelIdentity("Argon", { model: null, family: null })).toEqual({ model: null, family: null });
  });
});

describe("isQualifierOnlyText", () => {
  test.each([
    ["Weekly", true],
    ["Weekly (7d)", true],
    ["Free tier weekly", true],
    ["5-hour session", true],
    ["5hr", true],
    ["Weekly requests", true],
    ["Gemini Weekly", false],
    ["Interactive", false],
    ["rpm", false],
  ])("%s", (text, expected) => {
    expect(isQualifierOnlyText(text)).toBe(expected);
  });
});

describe("identityConstrainsModel", () => {
  const argon = parseModelIdentity("gemini-4-argon");
  test("model windows limit only the same model", () => {
    expect(identityConstrainsModel(parseModelIdentity("Gemini 4 Argon (weekly)"), argon)).toBe(true);
    expect(identityConstrainsModel(parseModelIdentity("gemini-4-argon-lite"), argon)).toBe(false);
    expect(identityConstrainsModel(parseModelIdentity("gemini-4-neon"), argon)).toBe(false);
  });
  test("family windows limit every model in their scope, and no identity limits nothing", () => {
    expect(identityConstrainsModel(parseModelIdentity("Gemini 4"), argon)).toBe(true);
    expect(identityConstrainsModel(parseModelIdentity("Gemini 3"), parseModelIdentity("gemini-3.8-flash"))).toBe(true);
    expect(identityConstrainsModel(parseModelIdentity("Gemini 3"), argon)).toBe(false);
    expect(identityConstrainsModel(parseModelIdentity("Gemini"), argon)).toBe(true);
    expect(identityConstrainsModel(parseModelIdentity("Claude / GPT"), argon)).toBe(false);
  });
});
