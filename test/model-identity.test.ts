import { describe, expect, test } from "bun:test";
import {
  ALL_GEMINI_IDENTITY,
  IMAGE_GENERATION_IDENTITY,
  NO_MODEL_IDENTITY,
  canonicalModelId,
  coerceModelIdentity,
  identityConstrainsModel,
  modelIdIdentity,
  poolNameIdentity,
  widenUnknownGeminiModel,
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
    // Image-generation models.
    ["models/imagen-4.0-generate-001", "imagen-4.0-generate"],
    ["gemini-3-pro-image-preview", "gemini-3-pro-image-preview"],
    // Not model IDs: display names, opaque enum names, bucket and group IDs.
    ["Gemini 4 Argon", null],
    ["MODEL_PLACEHOLDER_M532", null],
    ["gemini", null],
    ["3p-weekly", null],
    // Suffix stripping that leaves only the prefix.
    ["gemini-high", null],
    // Only a whole resource path loses its prefix.
    ["All models/imagen-4", null],
    ["Gemini models/claude-opus-5-5", null],
    ["gemini_models/imagen-4", null],
    ["Gemini/models/imagen-4", null],
    ["projects/p/locations/global/publishers/google/models/gemini-4-argon", "gemini-4-argon"],
    ["imagen-001", null],
    // A second suffix left after one strip means the value is not a model ID.
    ["gemini-4-neon-high-high", null],
    ["gemini-4-neon-high-001", null],
    ["gemini-4-neon-001-high", null],
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
  test("image-generation IDs are image models, not Gemini text models", () => {
    expect(modelIdIdentity("imagen-4.0-generate")).toEqual({ model: "imagen-4.0-generate", family: "image" });
    expect(modelIdIdentity("gemini-3-pro-image-preview")).toEqual({ model: "gemini-3-pro-image-preview", family: "image" });
    // "image" must end the ID (optionally "-preview"); a mid-ID segment is not an image model.
    expect(modelIdIdentity("gemini-4-imagery")).toEqual({ model: "gemini-4-imagery", family: "gemini" });
    expect(modelIdIdentity("gemini-2.5-flash-image")).toEqual({ model: "gemini-2.5-flash-image", family: "image" });
    expect(modelIdIdentity("gemini-text-and-image-pool")).toEqual({ model: "gemini-text-and-image-pool", family: "gemini" });
  });
});

describe("poolNameIdentity", () => {
  test.each([
    // Whole pool names seen in real payloads (case and spacing ignored).
    ["Claude and GPT models", NO_MODEL_IDENTITY],
    ["  claude AND gpt   Models ", NO_MODEL_IDENTITY],
    ["Image generation", IMAGE_GENERATION_IDENTITY],
    // Every other name fails closed to every Gemini text model, including
    // names that contain the partner or image words.
    ["Image generation and text", ALL_GEMINI_IDENTITY],
    ["Text & image generation", ALL_GEMINI_IDENTITY],
    ["Gemini + Imagen", ALL_GEMINI_IDENTITY],
    ["Gemini image generation", ALL_GEMINI_IDENTITY],
    ["All models (including image generation)", ALL_GEMINI_IDENTITY],
    ["All models including Claude and GPT", ALL_GEMINI_IDENTITY],
    ["Claude and Flash", ALL_GEMINI_IDENTITY],
    ["1P and 3P models", ALL_GEMINI_IDENTITY],
    ["Sonnet / Opus", ALL_GEMINI_IDENTITY],
    ["3p-weekly", ALL_GEMINI_IDENTITY],
    ["Gemini Models", ALL_GEMINI_IDENTITY],
    [null, ALL_GEMINI_IDENTITY],
  ])("%s", (text, expected) => {
    expect(poolNameIdentity(text)).toEqual(expected);
  });
});

describe("widenUnknownGeminiModel", () => {
  const roster = new Set(["gemini-4-argon"]);
  test("a Gemini model ID outside the roster limits every Gemini text model", () => {
    expect(widenUnknownGeminiModel(modelIdIdentity("gemini-4-argon-preview"), roster)).toEqual(ALL_GEMINI_IDENTITY);
    expect(widenUnknownGeminiModel(modelIdIdentity("gemini-4-argon"), roster)).toEqual(modelIdIdentity("gemini-4-argon"));
  });
  test("image, partner, and pool identities are unchanged", () => {
    for (const identity of [modelIdIdentity("imagen-4"), modelIdIdentity("claude-opus-5-5"), IMAGE_GENERATION_IDENTITY, NO_MODEL_IDENTITY]) {
      expect(widenUnknownGeminiModel(identity, roster)).toEqual(identity);
    }
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
  test("image pools limit image models and no Gemini text model", () => {
    expect(identityConstrainsModel(IMAGE_GENERATION_IDENTITY, argon)).toBe(false);
    expect(identityConstrainsModel(IMAGE_GENERATION_IDENTITY, modelIdIdentity("imagen-4.0-generate"))).toBe(true);
    expect(identityConstrainsModel(ALL_GEMINI_IDENTITY, modelIdIdentity("imagen-4.0-generate"))).toBe(false);
  });
});

describe("coerceModelIdentity", () => {
  test("stored family scopes from older snapshots widen to every Gemini model", () => {
    expect(coerceModelIdentity({ model: null, family: "gemini-4" })).toEqual(ALL_GEMINI_IDENTITY);
    expect(coerceModelIdentity({ model: "gemini-4-argon", family: "gemini-4" })).toEqual({ model: "gemini-4-argon", family: "gemini" });
    expect(coerceModelIdentity({ model: null, family: null })).toEqual(NO_MODEL_IDENTITY);
    // A stored ID is read back only when it is already canonical.
    expect(coerceModelIdentity({ model: "gemini-4-neon-high", family: "gemini" })).toEqual(ALL_GEMINI_IDENTITY);
    // Malformed or unrecognized values limit every Gemini text model.
    for (const raw of ["junk", null, undefined, [], {}, { family: "google" }, { model: "Gemini 4 Argon" }, { model: null, family: "gemini" }]) {
      expect(coerceModelIdentity(raw)).toEqual(ALL_GEMINI_IDENTITY);
    }
    expect(coerceModelIdentity({ model: null, family: "image" })).toEqual(IMAGE_GENERATION_IDENTITY);
    expect(coerceModelIdentity({ model: "imagen-4.0-generate", family: "image" })).toEqual({ model: "imagen-4.0-generate", family: "image" });
  });
});
