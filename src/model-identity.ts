/**
 * One model identity per quota window.
 *
 * The Antigravity collector resolves each bucket to a `ModelIdentity` once and
 * stores it in `snapshot.extra.modelWindowIdentity`; the recommender matches
 * candidates against that record only. Both sides use this parser, so the
 * collector and the recommender cannot disagree about which model a name means.
 *
 * Grammar (case-insensitive; tokens split on anything but letters, digits, dots):
 *   [prefix ...] gemini <version> [name] [variant ...]   e.g. "Gemini 4 Argon (Lite)"
 *   [prefix ...] claude|gpt|oss <words ...>              e.g. "claude-sonnet-4-5"
 * - A Gemini identity needs a version right after the family word. Without one
 *   ("Gemini", "gemini-free-tier-weekly", "prod_gemini_quota_1") the text names
 *   no model and no family: it is a shared or account-level quota.
 * - `family` is "gemini-<version>". `model` adds the first name word and any
 *   known variant word after it ("lite", "mini", ...). Cadence, release, effort,
 *   and container words ("weekly", "exp", "001", "high", "pool", "models") never
 *   change identity, so "gemini-4-argon-weekly" and "gemini-4-argon-exp" are
 *   Gemini 4 Argon while "gemini-4-argon-lite" is a different model.
 * - Other unknown words after the name are qualifiers ("Interactive"), so they
 *   bind to the base model rather than hide its quota.
 */

export interface ModelIdentity {
  /** Leaf model slug, e.g. "gemini-4-argon" or "gemini-4-argon-lite". */
  model: string | null;
  /** Versioned family slug, e.g. "gemini-4". */
  family: string | null;
}

export const NO_MODEL_IDENTITY: ModelIdentity = Object.freeze({ model: null, family: null });

const FAMILY_TOKENS = new Set(["gemini", "claude", "gpt", "oss"]);
const VERSION_RE = /^\d{1,2}(?:\.\d+)*$/;
const QUALIFIER_RE =
  /^(?:\d+(?:\.\d+)?[smhd]?|\d+(?:st|nd|rd|th)|v\d+|5h|7d|weekly|week|weeks|daily|day|days|hourly|hour|hours|hr|hrs|monthly|month|session|sessions|rolling|short|long|term|five|seven|quota|quotas|limit|limits|window|windows|bucket|buckets|pool|tier|tiered|model|models|all|default|general|shared|core|primary|secondary|standard|exp|experimental|preview|latest|stable|beta|alpha|low|medium|med|high|xhigh|thinking|free|paid|usage|requests?|rpm|tpm|rpd|cap)$/;
const VARIANT_TOKENS = new Set([
  "lite",
  "mini",
  "nano",
  "micro",
  "pro",
  "flash",
  "ultra",
  "plus",
  "max",
  "turbo",
  "image",
  "vision",
  "live",
  "audio",
  "tts",
  "embedding",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

/** True when the text contains a model family word (gemini, claude, gpt, oss). */
export function mentionsModelFamily(text: string): boolean {
  return tokenize(text).some((t) => FAMILY_TOKENS.has(t));
}

export function hasModelIdentity(identity: ModelIdentity): boolean {
  return identity.model !== null || identity.family !== null;
}

/** Parses free text or an ID into a model identity. Returns `NO_MODEL_IDENTITY`
 * when the text names neither a model nor a versioned family. */
export function parseModelIdentity(text: string | null | undefined): ModelIdentity {
  if (typeof text !== "string") return NO_MODEL_IDENTITY;
  const tokens = tokenize(text);
  const start = tokens.findIndex((t) => FAMILY_TOKENS.has(t));
  if (start < 0) return NO_MODEL_IDENTITY;
  const familyWord = tokens[start]!;
  const isIdentityWord = (t: string) => !QUALIFIER_RE.test(t) && !FAMILY_TOKENS.has(t) && !VERSION_RE.test(t);

  if (familyWord !== "gemini") {
    // Partner models ("claude-sonnet-4-5", "gpt-oss-120b"). A pool label that
    // only lists families ("Claude / GPT") names no model.
    const words = tokens.slice(start + 1).filter((t) => !QUALIFIER_RE.test(t) || /\d/.test(t));
    if (words.every((t) => FAMILY_TOKENS.has(t))) return NO_MODEL_IDENTITY;
    return { model: [familyWord, ...words].join("-"), family: null };
  }

  const version = tokens[start + 1];
  if (version === undefined || !VERSION_RE.test(version)) return NO_MODEL_IDENTITY;
  const family = `gemini-${version}`;
  const rest = tokens.slice(start + 2);
  const nameIndex = rest.findIndex(isIdentityWord);
  if (nameIndex < 0) return { model: null, family };
  const name = rest[nameIndex]!;
  const variants: string[] = [];
  for (const t of rest.slice(nameIndex + 1)) {
    if (VARIANT_TOKENS.has(t) && t !== name && !variants.includes(t)) variants.push(t);
  }
  return { model: [family, name, ...variants].join("-"), family };
}

/** Resolves a label in the context of its enclosing group: a label without a
 * family word ("Argon", "(Lite)", "Weekly") extends the group's identity. */
export function resolveLabelIdentity(label: string, groupIdentity: ModelIdentity): ModelIdentity {
  if (mentionsModelFamily(label)) return parseModelIdentity(label);
  const groupSlug = groupIdentity.model ?? groupIdentity.family;
  if (!groupSlug) return NO_MODEL_IDENTITY;
  return parseModelIdentity(`${groupSlug} ${label}`);
}

/** True when a window with identity `window` limits the candidate model `candidate`.
 * A model window limits only that exact model. A family-only window (a pool such
 * as "Gemini 4 · Weekly") limits every model in the family ("gemini-4" covers
 * "gemini-4" and "gemini-4.x"). A window with no identity limits no candidate. */
export function identityConstrainsModel(window: ModelIdentity, candidate: ModelIdentity): boolean {
  if (window.model !== null) return window.model === candidate.model;
  if (window.family !== null && candidate.family !== null) {
    return candidate.family === window.family || candidate.family.startsWith(`${window.family}.`);
  }
  return false;
}

/** Reads a stored identity record value; anything malformed means "no identity". */
export function coerceModelIdentity(raw: unknown): ModelIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NO_MODEL_IDENTITY;
  const { model, family } = raw as { model?: unknown; family?: unknown };
  return {
    model: typeof model === "string" && model.trim() ? model.trim().toLowerCase() : null,
    family: typeof family === "string" && family.trim() ? family.trim().toLowerCase() : null,
  };
}
