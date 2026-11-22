/**
 * One model identity per quota window.
 *
 * The Antigravity collector stores one `ModelIdentity` per window in
 * `snapshot.extra.modelWindowIdentity`; the recommender matches candidates
 * against that record only. Both sides use this module.
 *
 * The rule is deliberately small, and it never reads free-text labels:
 * - A window is model-specific only when the API gives it an exact model ID
 *   (a per-model entry's `modelId`, or a summary group that the same server's
 *   model list names). It then limits only that model.
 * - A pool is recognized by name only when the whole name is one seen in a
 *   real payload: the partner pool "Claude and GPT models" limits no Gemini
 *   model, and the image pool "Image generation" limits only image generation.
 *   An image model ID ("imagen-4", "gemini-3-pro-image-preview") also limits
 *   only image generation.
 * - Every other window is a Gemini quota of unknown scope and limits every
 *   Gemini text model (fails closed).
 */

export interface ModelIdentity {
  /** Exact canonical model ID, e.g. "gemini-4-argon" or "claude-opus-5-5". */
  model: string | null;
  /** "gemini" for Gemini text models and windows; "image" for image-generation
   * models and pools; null for partner models and pools. */
  family: string | null;
}

/** Names no Gemini model: a partner pool, or nothing recognizable. */
export const NO_MODEL_IDENTITY: ModelIdentity = Object.freeze({ model: null, family: null });

/** Every Gemini model: a shared quota, or a window of unknown scope. */
export const ALL_GEMINI_IDENTITY: ModelIdentity = Object.freeze({ model: null, family: "gemini" });

/** Every image-generation model: an image pool. It limits no Gemini text model. */
export const IMAGE_GENERATION_IDENTITY: ModelIdentity = Object.freeze({ model: null, family: "image" });

const MODEL_ID_RE = /^(?:gemini|imagen|claude|gpt)-[a-z0-9][a-z0-9.-]*$/;
/** Image-generation model IDs: "imagen-4", or an "image" segment ("gemini-3-pro-image-preview"). */
const IMAGE_MODEL_ID_RE = /^imagen-|-image(?:-|$)/;
/** A resource-path prefix made only of path segments, ending in "models/". */
const RESOURCE_PREFIX_RE = /^(?:[a-z0-9._-]+\/)*?models\//;
/** Thinking-effort suffixes on Antigravity model IDs ("gemini-4-neon-high"). */
const EFFORT_SUFFIX_RE = /-(?:minimal|low|medium|high|xhigh)$/;
/** Numbered releases ("models/gemini-4-argon-001"). */
const RELEASE_SUFFIX_RE = /-\d{3}$/;
/** Whole pool names, normalized (lowercase, single spaces). "Claude and GPT
 * models" is the partner pool in real Antigravity 2.34 payloads. "Image
 * generation" is provisional: no captured payload has shown an image quota
 * group yet (2.34 reports none), so replace or extend it from the first
 * capture that does. */
const PARTNER_POOL_NAMES: ReadonlySet<string> = new Set(["claude and gpt models"]);
const IMAGE_POOL_NAMES: ReadonlySet<string> = new Set(["image generation"]);

/** Returns the canonical form of an API model ID, or null when the value is not
 * one: lowercased, any resource prefix ("models/", "projects/x/models/") and
 * one effort or release suffix removed. Display names ("Gemini 4 Argon") and
 * opaque IDs ("MODEL_PLACEHOLDER_M532") are not model IDs. */
export function canonicalModelId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  // Only a whole resource path ("models/x", "projects/p/models/x") loses its
  // prefix; "All models/imagen-4" is a name, not a path.
  const id = value.trim().toLowerCase().replace(RESOURCE_PREFIX_RE, "");
  if (!MODEL_ID_RE.test(id)) return null;
  const stripped = id.replace(EFFORT_SUFFIX_RE, "").replace(RELEASE_SUFFIX_RE, "");
  // "gemini-high" or "imagen-001" leave only the prefix: not a model ID.
  return MODEL_ID_RE.test(stripped) ? stripped : null;
}

/** The identity of an exact API model ID; `NO_MODEL_IDENTITY` when the value is
 * not a model ID. */
export function modelIdIdentity(value: string | null | undefined): ModelIdentity {
  const id = canonicalModelId(value);
  if (id === null) return NO_MODEL_IDENTITY;
  return { model: id, family: modelIdFamily(id) };
}

function modelIdFamily(id: string): string | null {
  if (IMAGE_MODEL_ID_RE.test(id)) return "image";
  return id.startsWith("gemini-") ? "gemini" : null;
}

/** The identity of a pool known only by its whole name: the partner pool
 * "Claude and GPT models" limits no Gemini model, the image pool "Image
 * generation" limits only image generation, and any other name (including
 * names that merely contain those words) limits every Gemini text model. */
export function poolNameIdentity(name: string | null | undefined): ModelIdentity {
  if (typeof name !== "string") return ALL_GEMINI_IDENTITY;
  const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (PARTNER_POOL_NAMES.has(normalized)) return NO_MODEL_IDENTITY;
  if (IMAGE_POOL_NAMES.has(normalized)) return IMAGE_GENERATION_IDENTITY;
  return ALL_GEMINI_IDENTITY;
}

/** Widens a Gemini text-model identity whose exact ID is not in `knownIds` to
 * every Gemini text model, so a renamed or unknown model ID
 * ("gemini-4-argon-preview") never stops an exhausted window from limiting the
 * candidates. Image and partner identities are unchanged. */
export function widenUnknownGeminiModel(identity: ModelIdentity, knownIds: ReadonlySet<string>): ModelIdentity {
  if (identity.model !== null && identity.family === ALL_GEMINI_IDENTITY.family && !knownIds.has(identity.model)) {
    return ALL_GEMINI_IDENTITY;
  }
  return identity;
}

/** True when a window with identity `window` limits the candidate model `candidate`.
 * A model window limits only that exact model; an all-Gemini window limits every
 * Gemini text model; an image pool limits every image model; a window with no
 * identity limits nothing. */
export function identityConstrainsModel(window: ModelIdentity, candidate: ModelIdentity): boolean {
  if (window.model !== null) return window.model === candidate.model;
  return window.family !== null && window.family === candidate.family;
}

/** Reads a stored identity record value. The explicit "no identity" record
 * `{model: null, family: null}` (a partner pool) is kept; a stored model is
 * read as a model ID (display strings are not IDs); a stored "image" family
 * is an image pool; anything else, malformed or unrecognized (including old
 * family scopes such as "gemini-4"), limits every Gemini text model. */
export function coerceModelIdentity(raw: unknown): ModelIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ALL_GEMINI_IDENTITY;
  const { model, family } = raw as { model?: unknown; family?: unknown };
  if (model === null && family === null) return NO_MODEL_IDENTITY;
  if (typeof model === "string") {
    const identity = modelIdIdentity(model);
    return identity.model !== null ? identity : ALL_GEMINI_IDENTITY;
  }
  if (model === null && family === IMAGE_GENERATION_IDENTITY.family) return IMAGE_GENERATION_IDENTITY;
  return ALL_GEMINI_IDENTITY;
}
