import { describe, expect, test } from "bun:test";
import {
  ALL_GEMINI_IDENTITY,
  NO_MODEL_IDENTITY,
  canonicalModelId,
  coerceModelIdentity,
  identityConstrainsModel,
  mentionsOnlyPartnerFamily,
  modelIdIdentity,
} from "../src/model-identity";

describe("canonicalModelId", () => {
  test.each([
    // Real Antigravity 2.34 IDs: effort suffixes are removed.
    ["gemini-4-neon-high", "gemini-4-neon"],
    ["gemini-4-argon-medium", "gemini-4-argon"],
    ["gemini-3.8-flash-low", "gemini-3.8-flash"],
    ["gemini-4-hydrogen-xhigh", "gemini-4-hydrogen"],
    ["gemini-pro-orchestrator-neon", "gemini-pro-orchestrator-neon"],
    ["claude-opus-5-5-low", "claude-opus-5-5"],
    ["gpt-oss-120b-medium", "gpt-oss-120b"],
    // Resource prefixes and numbered releases.
    ["models/gemini-4-argon-001", "gemini-4-argon"],
    ["projects/gemini-prod/models/gemini-4-argon", "gemini-4-argon"],
    ["Gemini-4-Argon", "gemini-4-argon"],
    // Variants stay distinct models.
    ["gemini-4-argon-lite", "gemini-4-argon-lite"],
    // Not model IDs: display names, opaque enum names, bucket and group IDs.
    ["Gemini 4 Argon", null],
    ["MODEL_PLACEHOLDER_M532", null],
    ["gemini", null],
    ["3p-weekly", null],
    ["", null],
  ])("%s", (raw, expected) => {
    expect(canonicalModelId(raw)).toBe(expected);
  });
});

describe("modelIdIdentity", () => {
  test("Gemini IDs are Gemini models; partner IDs are not", () => {
    expect(modelIdIdentity("gemini-4-neon-high")).toEqual({ model: "gemini-4-neon", family: "gemini" });
    expect(modelIdIdentity("claude-sonnet-5-5")).toEqual({ model: "claude-sonnet-5-5", family: null });
    expect(modelIdIdentity("Gemini 4 Neon")).toEqual(NO_MODEL_IDENTITY);
  });
});

describe("mentionsOnlyPartnerFamily", () => {
  test.each([
    ["Claude and GPT models", true],
    ["3p-weekly", true],
    ["Sonnet / Opus", true],
    ["Gemini Models", false],
    ["Gemini and Claude", false],
    ["Image generation", false],
  ])("%s", (text, expected) => {
    expect(mentionsOnlyPartnerFamily(text)).toBe(expected);
  });
});

describe("identityConstrainsModel", () => {
  const argon = modelIdIdentity("gemini-4-argon");
  test("model windows limit only the same exact model", () => {
    expect(identityConstrainsModel(modelIdIdentity("gemini-4-argon-high"), argon)).toBe(true);
    expect(identityConstrainsModel(modelIdIdentity("gemini-4-argon-lite"), argon)).toBe(false);
    expect(identityConstrainsModel(modelIdIdentity("gemini-4-neon"), argon)).toBe(false);
  });
  test("all-Gemini windows limit every Gemini model; no identity limits nothing", () => {
    expect(identityConstrainsModel(ALL_GEMINI_IDENTITY, argon)).toBe(true);
    expect(identityConstrainsModel(ALL_GEMINI_IDENTITY, modelIdIdentity("claude-opus-5-5"))).toBe(false);
    expect(identityConstrainsModel(NO_MODEL_IDENTITY, argon)).toBe(false);
  });
});

describe("coerceModelIdentity", () => {
  test("stored family scopes from older snapshots widen to every Gemini model", () => {
    expect(coerceModelIdentity({ model: null, family: "gemini-4" })).toEqual(ALL_GEMINI_IDENTITY);
    expect(coerceModelIdentity({ model: "gemini-4-argon", family: "gemini-4" })).toEqual({ model: "gemini-4-argon", family: "gemini" });
    expect(coerceModelIdentity({ model: null, family: null })).toEqual(NO_MODEL_IDENTITY);
    expect(coerceModelIdentity("junk")).toEqual(NO_MODEL_IDENTITY);
  });
});
