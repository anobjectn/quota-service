/**
 * One model identity per quota window.
 *
 * The Antigravity collector resolves each bucket to a `ModelIdentity` once and
 * stores it in `snapshot.extra.modelWindowIdentity`; the recommender matches
 * candidates against that record only. Both sides use this module, so the
 * collector and the recommender cannot disagree about which model a name means.
 *
 * The vocabulary is closed. Only known words name a model; any other word is
 * ignored. When the text cannot be resolved to one model, the identity widens
 * (fails closed) instead of inventing a model that limits nothing.
 *
 * Grammar (case-insensitive; tokens split on anything but letters, digits, dots):
 *   ... gemini <version> [... name ...] [variant ...]   e.g. "Gemini 4 Argon (Lite)"
 *   ... claude|gpt|oss <words ...>                      e.g. "claude-sonnet-4-5"
 * - Scopes, from widest to narrowest: "gemini" (every Gemini model), a family
 *   "gemini-<version>", a model "gemini-<version>-<name>[-<variant>...]".
 * - A Gemini segment without a version ("Gemini", "gemini-free-tier-weekly",
 *   "Gemini Neon") is the "gemini" scope: a shared or account-level quota.
 * - Versions normalize: "4.0" is "4", and "gemini-2-5-flash" is version 2.5.
 * - Names are the closed set `GEMINI_MODEL_NAMES`; variants are
 *   `GEMINI_VARIANT_NAMES`. A segment that names two models ("Argon and Neon")
 *   is the family. A segment with no name ("Gemini 4 Interactive",
 *   "Gemini 4 requests per day") is the family. Variant words make a distinct
 *   model: "gemini-4-argon-lite" is not "gemini-4-argon".
 * - Text that mentions several identities ("projects/gemini-prod/models/
 *   gemini-4-argon") keeps the narrowest one when they agree, and their widest
 *   common scope when they conflict (see `mergeModelIdentities`).
 * - Partner models (Claude, GPT, OSS) keep their words. A pool label that only
 *   lists partner families ("Claude / GPT") names no model.
 */

export interface ModelIdentity {
  /** Leaf model slug, e.g. "gemini-4-argon" or "gemini-4-argon-lite". */
  model: string | null;
  /** Family scope: "gemini-4", or "gemini" for every Gemini model. */
  family: string | null;
}

/** Names no Gemini model: a partner pool, or nothing recognizable. */
export const NO_MODEL_IDENTITY: ModelIdentity = Object.freeze({ model: null, family: null });

/** Every Gemini model: a shared quota, or Gemini text that cannot be narrowed. */
export const ALL_GEMINI_IDENTITY: ModelIdentity = Object.freeze({ model: null, family: "gemini" });

/** Known Gemini model names (closed set). */
export const GEMINI_MODEL_NAMES: readonly string[] = ["argon", "neon", "flash", "pro", "ultra", "nano"];
/** Known variant words. Each one makes a distinct model ("Lite" is not the base model). */
export const GEMINI_VARIANT_NAMES: readonly string[] = [
  "lite",
  "mini",
  "micro",
  "plus",
  "max",
  "turbo",
  "image",
  "vision",
  "live",
  "audio",
  "tts",
  "embedding",
];

const GEMINI = "gemini";
const NAME_TOKENS = new Set(GEMINI_MODEL_NAMES);
const VARIANT_TOKENS = new Set(GEMINI_VARIANT_NAMES);
const PARTNER_FAMILY_TOKENS = new Set(["claude", "gpt", "oss"]);
const PARTNER_VENDOR_TOKENS = new Set(["anthropic", "openai"]);
const VERSION_RE = /^\d{1,2}(?:\.\d+)*$/;
const UNIT_RE = /^(?:s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)$/;
const DURATION = "\\d+(?:\\.\\d+)?(?:s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)?";
/** Words that only describe a quota's cadence or container ("Weekly quota",
 * "5-hour session", "Free tier weekly", "Weekly (7d)"). A label made only of
 * these adds no key qualifier. Identity never depends on this list: words
 * outside the closed model vocabulary are ignored either way. */
const GENERIC_LABEL_RE = new RegExp(
  "^(?:" +
    [
      DURATION,
      "weekly|week|weeks|daily|day|days|hourly|hour|hours|hr|hrs|five|seven",
      "session|sessions|short|long|term|rolling",
      "primary|secondary|default|standard|shared|core|pool|bucket|buckets|quota|quotas|limit|limits|window|windows",
      "usage|request|requests|free|tier",
    ].join("|") +
    ")$",
);
/** Words dropped from partner model slugs: the generic words plus release,
 * effort, and rate words ("Claude / GPT (5h)" names no model). */
const PARTNER_NOISE_RE = new RegExp(
  "^(?:" +
    [
      DURATION,
      "\\d+(?:st|nd|rd|th)",
      "weekly|week|weeks|daily|day|days|hourly|hour|hours|hr|hrs|monthly|month|five|seven|per",
      "session|sessions|short|long|term|rolling",
      "primary|secondary|default|standard|shared|core|pool|bucket|buckets|quota|quotas|limit|limits|window|windows",
      "usage|request|requests|free|paid|tier|plan|model|models|all|general|cap|rpm|tpm|rpd",
      "exp|experimental|preview|latest|stable|beta|alpha|low|medium|med|high|xhigh|thinking",
    ].join("|") +
    ")$",
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

function normalizeVersion(version: string): string {
  return version.replace(/(?:\.0+)+$/, "");
}

/** True when the text contains a model family word (gemini, claude, gpt, oss). */
export function mentionsModelFamily(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  return tokenize(text).some((t) => t === GEMINI || PARTNER_FAMILY_TOKENS.has(t));
}

/** True when the text names a partner (non-Gemini) family or vendor and no Gemini. */
export function mentionsOnlyPartnerFamily(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const tokens = tokenize(text);
  return !tokens.includes(GEMINI) && tokens.some((t) => PARTNER_FAMILY_TOKENS.has(t) || PARTNER_VENDOR_TOKENS.has(t));
}

export function hasModelIdentity(identity: ModelIdentity): boolean {
  return identity.model !== null || identity.family !== null;
}

/** True when the family is versioned ("gemini-4"), not the all-Gemini scope. */
export function isVersionedFamily(family: string | null): boolean {
  return family !== null && family.startsWith(`${GEMINI}-`);
}

/** True when the label only describes a quota's cadence or container
 * ("Weekly", "Free tier weekly", "Weekly (7d)", "5-hour session"). */
export function isQualifierOnlyText(text: string): boolean {
  return tokenize(text).every((t) => GENERIC_LABEL_RE.test(t));
}

function parseGeminiSegment(segment: string[]): ModelIdentity {
  let version = segment[0];
  // A number followed by a unit is a duration, not a version ("Gemini 5 hour").
  if (version === undefined || !VERSION_RE.test(version) || UNIT_RE.test(segment[1] ?? "")) {
    return ALL_GEMINI_IDENTITY;
  }
  let rest = segment.slice(1);
  // "gemini-2-5-flash": a single digit right after the version is its minor
  // part, unless a unit follows it ("Gemini 4 5 hour").
  const minor = rest[0];
  if (!version.includes(".") && minor !== undefined && /^\d$/.test(minor) && !UNIT_RE.test(rest[1] ?? "")) {
    version = `${version}.${minor}`;
    rest = rest.slice(1);
  }
  const family = `${GEMINI}-${normalizeVersion(version)}`;
  const names: string[] = [];
  const variants: string[] = [];
  for (const t of rest) {
    if (NAME_TOKENS.has(t) && !names.includes(t)) names.push(t);
    else if (VARIANT_TOKENS.has(t) && !variants.includes(t)) variants.push(t);
  }
  // Two model names in one segment is a pool over both: keep the family.
  if (names.length > 1) return { model: null, family };
  if (names.length === 0 && variants.length === 0) return { model: null, family };
  return { model: [family, ...names, ...variants].join("-"), family };
}

function parsePartnerSegment(familyWord: string, segment: string[]): ModelIdentity {
  // Keep model words and version numbers; drop cadence and vendor words
  // ("Claude / GPT (5h)" names no model).
  const words = segment.filter(
    (t) => !PARTNER_VENDOR_TOKENS.has(t) && (!PARTNER_NOISE_RE.test(t) || /^\d+(?:\.\d+)?$/.test(t)),
  );
  if (words.every((t) => PARTNER_FAMILY_TOKENS.has(t))) return NO_MODEL_IDENTITY;
  return { model: [familyWord, ...words].join("-"), family: null };
}

/** Parses free text or an ID into a model identity. Returns `NO_MODEL_IDENTITY`
 * when the text mentions no model family. */
export function parseModelIdentity(text: string | null | undefined): ModelIdentity {
  if (typeof text !== "string") return NO_MODEL_IDENTITY;
  const tokens = tokenize(text);
  const found: ModelIdentity[] = [];
  let sawPartner = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === GEMINI) {
      let end = i + 1;
      while (end < tokens.length && tokens[end] !== GEMINI && !PARTNER_FAMILY_TOKENS.has(tokens[end]!)) end++;
      found.push(parseGeminiSegment(tokens.slice(i + 1, end)));
      i = end - 1;
    } else if (PARTNER_FAMILY_TOKENS.has(t)) {
      sawPartner = true;
      let end = i + 1;
      while (end < tokens.length && tokens[end] !== GEMINI) end++;
      found.push(parsePartnerSegment(t, tokens.slice(i + 1, end)));
      i = end - 1;
    }
  }
  if (found.length === 0) return NO_MODEL_IDENTITY;
  const merged = mergeModelIdentities(found);
  // Text that names both Gemini and partner models is a mixed pool.
  if (sawPartner && found.some((f) => f.family !== null)) return ALL_GEMINI_IDENTITY;
  return merged;
}

function scopeOf(identity: ModelIdentity): string | null {
  return identity.model ?? identity.family;
}

/** True when scope `outer` contains scope `inner` ("gemini" ⊇ "gemini-4" ⊇
 * "gemini-4-argon" ⊇ "gemini-4-argon-lite"; "gemini-3" ⊇ "gemini-3.8"). */
function scopeCovers(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(`${outer}-`) || inner.startsWith(`${outer}.`);
}

/** Combines identities that describe the same quota (a group name, its display
 * name, a bucket ID, a bucket label). When they agree, the narrowest wins
 * ("gemini-4" + "gemini-4-neon" is Neon; "gemini-4-argon" + "gemini-4-argon-lite"
 * is Lite). When they conflict ("gemini-4-argon" + "gemini-4-neon"), the result
 * is their widest common scope ("gemini-4", else "gemini"), so the quota limits
 * every model it might belong to. */
export function mergeModelIdentities(identities: readonly ModelIdentity[]): ModelIdentity {
  const known = identities.filter(hasModelIdentity);
  if (known.length === 0) return NO_MODEL_IDENTITY;
  const gemini = known.filter((i) => i.family !== null);
  const partner = known.filter((i) => i.family === null);
  if (gemini.length > 0 && partner.length > 0) return ALL_GEMINI_IDENTITY;
  if (gemini.length === 0) {
    const models = new Set(partner.map((i) => i.model));
    return models.size === 1 ? partner[0]! : NO_MODEL_IDENTITY;
  }
  const scopes = gemini.map((i) => scopeOf(i)!);
  let narrowest = 0;
  for (let i = 1; i < gemini.length; i++) {
    if (scopes[i]!.length > scopes[narrowest]!.length) narrowest = i;
  }
  if (scopes.every((s) => scopeCovers(s, scopes[narrowest]!))) {
    const pick = gemini[narrowest]!;
    return { model: pick.model, family: pick.family };
  }
  const families = new Set(gemini.map((i) => i.family));
  if (families.size === 1) {
    const family = gemini[0]!.family!;
    return { model: null, family };
  }
  return ALL_GEMINI_IDENTITY;
}

/** Resolves a label in the context of an enclosing identity. A label with its
 * own versioned Gemini identity merges with the context ("Gemini 4 Argon
 * (Weekly)" inside "gemini-4-argon-lite" stays Lite). Any other label extends
 * the context: "Argon" or "Gemini Neon" in "gemini-4", "(Lite)" in
 * "gemini-4-argon", "Weekly" anywhere. */
export function resolveLabelIdentity(label: string | null, context: ModelIdentity): ModelIdentity {
  if (label === null) return NO_MODEL_IDENTITY;
  const parsed = parseModelIdentity(label);
  if (mentionsOnlyPartnerFamily(label) || isVersionedFamily(parsed.family)) {
    return mergeModelIdentities([parsed, context]);
  }
  const contextScope = scopeOf(context);
  // Only a versioned context can be narrowed by a short label.
  if (!contextScope || !isVersionedFamily(context.family)) return mergeModelIdentities([parsed, context]);
  const words = tokenize(label).filter((t) => t !== GEMINI);
  return mergeModelIdentities([parseModelIdentity(`${contextScope} ${words.join(" ")}`), context]);
}

/** True when a window with identity `window` limits the candidate model `candidate`.
 * A model window limits only that exact model. A family window limits every
 * model in its scope ("gemini-4" covers "gemini-4-argon" and "gemini-4.5-flash";
 * "gemini" covers every Gemini model). A window with no identity limits nothing. */
export function identityConstrainsModel(window: ModelIdentity, candidate: ModelIdentity): boolean {
  if (window.model !== null) return window.model === candidate.model;
  if (window.family !== null && candidate.family !== null) return scopeCovers(window.family, candidate.family);
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
