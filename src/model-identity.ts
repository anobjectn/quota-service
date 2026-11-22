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
 * - A partner pool ("Claude and GPT models") limits no Gemini model.
 * - An image-generation pool ("Image generation", "Imagen") or an image model
 *   ID ("imagen-4", "gemini-3-pro-image") limits only image generation, never
 *   a Gemini text model.
 * - Every other window is a Gemini quota of unknown scope and limits every
 *   Gemini model (fails closed).
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
/** Thinking-effort suffixes on Antigravity model IDs ("gemini-4-neon-high"). */
const EFFORT_SUFFIX_RE = /-(?:minimal|low|medium|high|xhigh)$/;
/** Numbered releases ("models/gemini-4-argon-001"). */
const RELEASE_SUFFIX_RE = /-\d{3}$/;
const PARTNER_WORD_RE = /\b(?:claude|gpt|oss|anthropic|openai|sonnet|opus|haiku|3p)\b/;
/** Names image generation: "Image generation", "image gen", "text-to-image", "Imagen". */
const IMAGE_GENERATION_RE = /\b(?:images? (?:gen|generation|generations|generator|creation)|text to image|imagen)\b/;
/** Names a text or code model next to the image words ("Text and image generation"). */
const TEXT_MODEL_WORD_RE = /\b(?:text and|chat|code|coding|agent|agents|reasoning)\b/;

/** Returns the canonical form of an API model ID, or null when the value is not
 * one: lowercased, any resource prefix ("models/", "projects/x/models/") and
 * one effort or release suffix removed. Display names ("Gemini 4 Argon") and
 * opaque IDs ("MODEL_PLACEHOLDER_M532") are not model IDs. */
export function canonicalModelId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  let id = value.trim().toLowerCase();
  const slash = id.lastIndexOf("models/");
  if (slash !== -1) id = id.slice(slash + "models/".length);
  if (!MODEL_ID_RE.test(id)) return null;
  return id.replace(EFFORT_SUFFIX_RE, "").replace(RELEASE_SUFFIX_RE, "");
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

/** The identity of a pool known only by its name or label: a partner pool
 * (names a partner model or vendor and not Gemini) limits no Gemini model; an
 * image-generation pool (names image generation and no text or partner model)
 * limits only image generation; anything else limits every Gemini model. */
export function poolTextIdentity(text: string | null | undefined): ModelIdentity {
  if (typeof text !== "string") return ALL_GEMINI_IDENTITY;
  const lower = text.toLowerCase().replace(/[_-]+/g, " ");
  const partner = PARTNER_WORD_RE.test(lower);
  if (partner && !/gemini/.test(lower)) return NO_MODEL_IDENTITY;
  if (!partner && IMAGE_GENERATION_RE.test(lower) && !TEXT_MODEL_WORD_RE.test(lower)) return IMAGE_GENERATION_IDENTITY;
  return ALL_GEMINI_IDENTITY;
}

/** True when a window with identity `window` limits the candidate model `candidate`.
 * A model window limits only that exact model; an all-Gemini window limits every
 * Gemini text model; an image pool limits every image model; a window with no
 * identity limits nothing. */
export function identityConstrainsModel(window: ModelIdentity, candidate: ModelIdentity): boolean {
  if (window.model !== null) return window.model === candidate.model;
  return window.family !== null && window.family === candidate.family;
}

/** Reads a stored identity record value. Anything malformed means "no identity";
 * a stored Gemini family scope ("gemini-4", from older snapshots) widens to
 * every Gemini model; a stored "image" family is an image pool. */
export function coerceModelIdentity(raw: unknown): ModelIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NO_MODEL_IDENTITY;
  const { model, family } = raw as { model?: unknown; family?: unknown };
  if (typeof model === "string" && model.trim()) {
    const id = model.trim().toLowerCase();
    return { model: id, family: modelIdFamily(id) };
  }
  if (typeof family !== "string") return NO_MODEL_IDENTITY;
  const scope = family.trim().toLowerCase();
  if (scope === IMAGE_GENERATION_IDENTITY.family) return IMAGE_GENERATION_IDENTITY;
  if (scope.startsWith("gemini")) return ALL_GEMINI_IDENTITY;
  return NO_MODEL_IDENTITY;
}
