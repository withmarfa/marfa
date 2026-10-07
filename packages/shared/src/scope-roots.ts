/**
 * The first segments the platform has already given a meaning to, in one
 * place, because a root present in one copy and absent from another is a
 * namespace that refuses registration in one direction and admits it in the
 * other.
 *
 * **This module imports nothing on purpose.** `scopes.ts` imports
 * `validation.ts`, so a root defined in the former and consumed by the latter
 * is a cycle. Both import this instead.
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

/**
 * One root per verb-less permission, because a permission is named for
 * what it permits and there is no noun for the whole to name them after.
 *
 * **Seven words leave the publisher namespace by being here**, since
 * reserving a root refuses every registration under it. That cost is
 * the reservation working rather than a side effect of it: `items.purge`
 * could otherwise be registered as a type, putting an identifier and a
 * permission literal on one string.
 */
export const PERMISSION_FAMILY_ROOTS = [
  "schema",
  "keys",
  "items",
  "webhooks",
  "config",
  "audit",
  "grants",
] as const;

/**
 * The word `GLOSSARY.md` bans, reserved although no permission, scope
 * family or tier is named for it, so that no publisher may register types
 * beneath it. Naming it here in order to keep it unusable is not a use of it.
 */
export const BANNED_ROOT = "space";

/** The content category, `content:read` and `content:write`. */
export const CONTENT_ROOT = "content";
/** The metadata layer, `metadata:write` and `metadata.<sub>:<verb>`. */
export const METADATA_ROOT = "metadata";
/** Relationship scopes, `edge.<type>:<verb>`. */
export const EDGE_ROOT = "edge";
/** Category 2 of the permission model — your name, email and avatar. */
export const PROFILE_ROOT = "profile";

/**
 * Every root an OAuth scope family lives under.
 *
 * **`metadata` and `edge` belong here for exactly the reason the permission
 * roots and `content` do**: `parseScope`
 * tries the metadata and edge matchers before the type matcher, so a type
 * registered under a claimed `metadata` handle could never have its own scope
 * literal read as a type grant at all — `metadata.types:write` is taken by the
 * metadata family first, and that is the scope gating `POST /types`.
 */
export const SCOPE_FAMILY_ROOTS = [
  ...PERMISSION_FAMILY_ROOTS,
  CONTENT_ROOT,
  METADATA_ROOT,
  EDGE_ROOT,
  PROFILE_ROOT,
] as const;

/**
 * The union the two questions below are asked of. Derived rather than typed
 * out, so a scope family added to `SCOPE_FAMILY_ROOTS` is protected without a
 * second edit somewhere else remembering to protect it.
 *
 * `BANNED_ROOT` is appended rather than folded into `SCOPE_FAMILY_ROOTS`,
 * because it heads no family: nothing parses under it and nothing is named
 * for it. It is reserved so that nobody may claim it, and `parseScope`
 * claims its namespace whole for the separate reason recorded there.
 */
export const RESERVED_ROOT_NAMES: readonly string[] = [
  ...NAMESPACE_TIER_ROOTS,
  ...SCOPE_FAMILY_ROOTS,
  BANNED_ROOT,
];
