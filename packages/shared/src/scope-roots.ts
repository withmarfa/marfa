/**
 * The first segments the platform has already given a meaning to, in one
 * place, because three copies of this list existed and a root present in one
 * and absent from another is a namespace that refuses registration in one
 * direction and admits it in the other.
 *
 * **This module imports nothing on purpose.** `scopes.ts` imports
 * `validation.ts`, so a root defined in the former and consumed by the latter
 * is a cycle. Both import this instead, and the arithmetic that used to be
 * prose in `RESERVED_ROOTS`'s docblock is now the code that produces it.
 */

/**
 * The tiers the type grammar is written in. `publisher` is deliberately not
 * among them: it is what `classifyNamespace` falls back to for a first
 * segment none of these names, so it describes the absence of a tier rather
 * than naming one, and reserving it would reserve every handle at once.
 */
export const NAMESPACE_TIER_ROOTS = [
  "core",
  "system",
  "app",
  "user",
  "marfa",
] as const;

/** The verb-less administrative scopes. */
export const CAPABILITY_ROOT = "capability";
/** The content category, `content:read` and `content:write`. */
export const CONTENT_ROOT = "content";
/** The metadata layer, `metadata:write` and `metadata.<sub>:<verb>`. */
export const METADATA_ROOT = "metadata";
/** Relationship scopes, `edge.<type>:<verb>`. */
export const EDGE_ROOT = "edge";

/**
 * Every root an OAuth scope family lives under.
 *
 * **`metadata` and `edge` belong here for exactly the reason `capability` and
 * `content` do**, and their absence was the defect: `parseScope` tries the
 * metadata and edge matchers before the type matcher, so a type registered
 * under a claimed `metadata` handle could never have its own scope literal
 * read as a type grant at all — `metadata.types:write` is taken by the
 * metadata family first, and that is the scope gating `POST /types`.
 */
export const SCOPE_FAMILY_ROOTS = [
  CAPABILITY_ROOT,
  CONTENT_ROOT,
  METADATA_ROOT,
  EDGE_ROOT,
] as const;

/**
 * The union the two questions below are asked of. Derived rather than typed
 * out, so a scope family added to `SCOPE_FAMILY_ROOTS` is protected without a
 * second edit somewhere else remembering to protect it.
 */
export const RESERVED_ROOT_NAMES: readonly string[] = [
  ...NAMESPACE_TIER_ROOTS,
  ...SCOPE_FAMILY_ROOTS,
];
