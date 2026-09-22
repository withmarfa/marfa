/**
 * Reusable Zod schemas shared across route files. Centralized so each wire
 * shape is declared once.
 *
 * The consumers are not listed here on purpose. That list was three route
 * files and went stale without anything noticing, and a header naming its
 * importers is a second place to update whenever one is added. What holds
 * the claim is `wire-shape-declarations.test.ts`, which fails if a route
 * file declares a shape this file already exports.
 *
 * Nothing here imports from a route file, so any of them can import this.
 *
 * **Sharing a name with another route file is not by itself a reason to move
 * a shape here.** Three names are declared in more than one route file and
 * are left where they are, for two different reasons.
 *
 * The two id parameters differ in more than their names suggest. Most copies
 * are a bare string with a description written for their own route; one adds
 * `.min(1)`, which reaches the published specification as a `minLength` on
 * three operations and on no others. So consolidating them is not a move but
 * a choice — one validation and one description for every route that shares
 * the name — and that choice would silently add a constraint to some routes
 * or drop it from others. Worth doing deliberately; not worth doing as
 * tidying.
 *
 * The two key shapes differ outright, the administrative one carrying a
 * status the user-facing one does not, so folding them is a surface change in
 * one direction or a regression in the other.
 *
 * What belongs here is a shape two doors are trying to describe identically
 * and failing to.
 */
import { z } from "@hono/zod-openapi";
import {
  ITEM_STATES,
  MarfaError,
  ErrorCode,
  PERMISSIONS,
} from "@withmarfa/shared";
import type { ItemState } from "@withmarfa/shared";

/**
 * The lifecycle states an item can be in, as a Zod enum.
 *
 * Derived from the canonical list rather than restated, because restating
 * it is how the platform ended up with doors that disagreed about how many
 * states there are: the bulk-action filter enumerated three of the four and
 * so could not select the reserved namespace at all, whose types use a
 * bounded `active | revoked` lifecycle and nothing else.
 *
 * **This is the enum for naming a state, not for reaching one.** A
 * transition's *target* is a narrower set than this and is written out
 * separately on the doors that take one, because which states a type can
 * move to is the lifecycle graph's answer and differs per type.
 */
export const ItemStateEnum = z
  .enum(ITEM_STATES as unknown as [ItemState, ...ItemState[]])
  .openapi("ItemState");

/**
 * The two tiers an item can be written to, and a key's default.
 *
 * Named and shared for the same reason as the states: spelled inline it
 * reaches the document as a fresh anonymous enum on every door that takes
 * one, and a generated client then carries one type per door for one
 * vocabulary.
 */
export const TierEnum = z.enum(["library", "feed"]).openapi("Tier");

/** The instance-wide permissions a credential can hold. */
export const PermissionEnum = z
  .enum(PERMISSIONS as unknown as [string, ...string[]])
  .openapi("Permission");

/** What a credential may do with one type: read it, write it, or neither. */
export const TypePermissionLevelEnum = z
  .enum(["read", "write", "none"])
  .openapi("TypePermissionLevel");

/**
 * What a credential may do with one extension, edge type, metadata family or
 * profile. Absence is the refusal on these, so there is no `none` member.
 */
export const PermissionLevelEnum = z
  .enum(["read", "write"])
  .openapi("PermissionLevel");

/**
 * The `?state=` value that means "every state", on every door that reads
 * items.
 *
 * Deliberately not a member of the lifecycle vocabulary: it is a widening
 * of the default rather than a state a row can be in, and nothing may
 * compare it against the column.
 *
 * What it widens to is the door's own. A listing and an export reach every
 * lifecycle state; a search reaches every state the full-text index holds,
 * which leaves out the bin because a trashed row is removed from the index
 * rather than narrowed out of the query.
 */
export const ALL_STATES = "any";

/**
 * Resolve a `?state=` parameter into the pair the storage filter takes.
 *
 * One implementation for every door that reads items — the listing, the
 * search and the export — so `any` means the same thing on all of them.
 * What each door does with a caller who named nothing is the door's own,
 * and this function decides only what a named value resolves to.
 *
 * The sentinel is resolved before the membership check rather than after.
 * Cast first and it would be validated as a lifecycle value and refused
 * for not being one.
 */
export function resolveStateFilter(raw: string | undefined): {
  state: ItemState | undefined;
  all_states: boolean;
} {
  if (raw === ALL_STATES) return { state: undefined, all_states: true };
  if (raw !== undefined && !(ITEM_STATES as readonly string[]).includes(raw)) {
    throw new MarfaError(ErrorCode.VALIDATION_ERROR, `Invalid state: ${raw}`);
  }
  return { state: raw as ItemState | undefined, all_states: false };
}

export const EdgeSchema = z
  .object({
    id: z.string(),
    source_id: z.string(),
    target_id: z.string(),
    edge_type: z.string(),
    properties: z.record(z.string(), z.unknown()),
    created_at: z.string(),
    updated_at: z.string(),
    version: z.number(),
  })
  .openapi("Edge");

/**
 * A single edge type's hydrated block on an item response. Per-type cap is
 * 50 by default; has_more + next_cursor signal that more edges exist and the
 * caller should paginate via GET /items/:id/edges?edge_type=X&cursor=...
 */
export const ItemEdgesBlockSchema = z
  .object({
    edges: z.array(EdgeSchema),
    has_more: z.boolean(),
    next_cursor: z.string().optional(),
  })
  .openapi("ItemEdgesBlock");

export const ItemSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    properties: z.record(z.string(), z.unknown()),
    state: ItemStateEnum,
    /** Optional — `system.*` items have no tier. */
    tier: TierEnum.optional(),
    version: z.number(),
    schema_version: z.number().int(),
    source: z.string(),
    source_id: z.string().optional(),
    capture_latitude: z.number().optional(),
    capture_longitude: z.number().optional(),
    occurred_at: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    /**
     * Hydrated outbound edges per type. Always populated on single-item GETs;
     * opt-in on list GETs via ?include=edges. An empty object means no edges
     * or hydration was skipped.
     */
    edges: z.record(z.string(), ItemEdgesBlockSchema).optional(),
    /**
     * Hydrated extension namespaces. Opt-in on list GETs via
     * ?include=extensions; filtered by caller permissions (same rule as
     * GET /items/:id/extensions). An empty object means no extensions or
     * hydration was skipped. Absent when the caller did not opt in.
     */
    extensions: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
  })
  .openapi("Item");

// MetadataSchema does not include `about` — entity references are carried
// as first-class `about` edges.
export const MetadataSchema = z
  .object({
    item_id: z.string(),
    tags: z.array(z.string()),
    extensions: z.record(z.string(), z.unknown()),
  })
  .openapi("Metadata");

export const ItemWithMetadataSchema = z
  .object({
    item: ItemSchema,
    metadata: MetadataSchema,
    /** Present when the request was accepted and deliberately wrote
     *  nothing. Two paths produce it, and they answer the same question —
     *  a create the server has already performed, arriving again: the
     *  natural-key re-sync of an item the user has trashed, and a create
     *  repeating an `id` the caller already created. Absent everywhere
     *  else, so a caller reading it as a boolean sees the distinction
     *  rather than having to infer it from the state. */
    acknowledged: z.boolean().optional(),
  })
  .openapi("ItemWithMetadata");

/**
 * How a collision on one field is resolved.
 *
 * Shared because a type declares the policy and an item write reports what
 * it applied: two doors describing one vocabulary, which is what belongs
 * here.
 */
export const MergeStrategyEnum = z
  .enum(["last_writer_wins", "keep_both_copies"])
  .openapi("MergeStrategy");

/** A type's merge policy: a strategy per field, and one for the rest. */
export const MergePolicySchema = z
  .object({
    fields: z.record(z.string(), MergeStrategyEnum).optional(),
    default: MergeStrategyEnum.optional(),
  })
  .openapi("MergePolicy");

/**
 * The refusal block every single-write `version_conflict` carries.
 *
 * The item doors and the edge doors answer envelopes that differ in what
 * they hand back beside it — an edge has no ancestor and no field-level
 * merge — but the refusal itself is the same three fields on both, and a
 * client branches on `code` without knowing which door answered.
 */
export const VersionConflictErrorSchema = z
  .object({
    code: z.literal("version_conflict"),
    status: z.literal(409),
    /** Prose for a person. Branch on `code`, never on this. */
    message: z.string(),
  })
  .openapi("VersionConflictError");

/** What a bulk page did with one entry. */
export const BulkResultOutcomeEnum = z
  .enum(["created", "updated", "skipped", "errored"])
  .openapi("BulkResultOutcome");

/**
 * A per-entry refusal inside a bulk page.
 *
 * The same refusal a single write gives, carried per entry: `details` is
 * here because flattening it to a code and a message dropped the half a
 * caller acts on — an `id_reused` entry naming no `differs` tells a caller
 * which mistake it made and not what to do about it.
 */
export const BulkEntryErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("BulkEntryError");

/** How a bulk page's entries came out, counted by outcome. */
export const BulkCountsSchema = z
  .object({
    created: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    errored: z.number().int(),
  })
  .openapi("BulkCounts");

export const VersionSchema = z
  .object({
    id: z.string(),
    item_id: z.string(),
    version: z.number(),
    properties: z.record(z.string(), z.unknown()),
    created_at: z.string(),
  })
  .openapi("Version");

/**
 * The single-item read response. The base shape (`item` with outbound `edges`
 * hydrated, plus `metadata`) is always present; the three optional blocks are
 * opt-in via `?include=` and widen the 1-hop neighborhood the caller gets in
 * one round trip instead of a per-section fan-out:
 *
 * - `backrefs` — inbound edges grouped by type (same block shape as `edges`),
 *   capped + cursored per type. Opt in with `include=backrefs`.
 * - `neighbors` — the far-end items of the item's edges (outbound targets and,
 *   when `backrefs` is also requested, inbound sources), each with its metadata
 *   and permission-filtered. Opt in with `include=neighbors`. Paired with
 *   `neighbors_truncated`: the combined neighbor set is capped, and when the cap
 *   bites this flag is `true` — the only signal for that case, since the
 *   per-type edge-block `has_more` does not cover a combined-set overflow.
 *   Consumers must page the per-type edge/backref endpoints when it is set.
 * - `neighbors_omitted` — how many of the item's neighbors were left out
 *   because the caller may not read them. Distinct from `neighbors_truncated`,
 *   which is about a bound; this is about permission. Omitting silently made
 *   a partial neighborhood indistinguishable from a complete one, so an app
 *   missing an edge scope rendered a ticket with none of its relations and
 *   looked correct doing it.
 * - `versions` — the item's version snapshots, newest-first. Opt in with
 *   `include=versions`.
 */
export const ItemDetailSchema = z
  .object({
    item: ItemSchema,
    metadata: MetadataSchema,
    backrefs: z.record(z.string(), ItemEdgesBlockSchema).optional(),
    neighbors: z.array(ItemWithMetadataSchema).optional(),
    neighbors_truncated: z.boolean().optional(),
    neighbors_omitted: z.number().int().optional(),
    versions: z.array(VersionSchema).optional(),
  })
  .openapi("ItemDetail");

/**
 * The three schema-enforcement levers, one shape built twice: permissive for
 * every read and for a key's override, strict for the instance config's
 * write. `.strict()` does not recurse, so the outer object refusing an
 * unknown key while `enforcement` accepted one would leave a silent drop a
 * level down, on the block where a dropped key means a rule nobody is
 * enforcing; taking the strictness as a parameter is what stops the two
 * drifting.
 */
export const enforcementSchema = (strict: boolean) => {
  const obj = strict ? z.strictObject : z.object;
  const typeList = z.array(z.string());
  const typesAndSources = { types: typeList, sources: z.array(z.string()) };
  // The component names carry the strictness, because the two shapes are not
  // the same shape: the strict one refuses a key the permissive one keeps,
  // and one name over both would publish whichever was registered first as
  // the meaning of the other.
  const suffix = strict ? "Strict" : "";
  return obj({
    strict_mode: obj({ types: typeList })
      .optional()
      .openapi(`StrictModeLever${suffix}`),
    source_allowlist: obj(typesAndSources)
      .optional()
      .openapi(`SourceAllowlistLever${suffix}`),
    source_filter: obj(typesAndSources)
      .optional()
      .openapi(`SourceFilterLever${suffix}`),
  });
};

/** A key's per-credential override: the same levers, permissive. */
export const EnforcementOverrideSchema = enforcementSchema(false)
  .describe(
    "Per-credential schema-enforcement override. A lever set here wins over the instance config for this credential, lever by lever; absent, the key inherits the instance config.",
  )
  .openapi("EnforcementOverride");

/**
 * An API key as a create route answers it.
 *
 * Two doors mint a key — a working caller's own and the operator one — and
 * they answered with two declarations that had drifted apart. One carried `expires_at` and the other did not.
 *
 * **The one without it was right.** `CreateKeyInput` cannot carry an expiry
 * and nothing on either door sets one, so every key either door can mint has
 * none. Declaring the field on a create response promised generated clients a
 * property that could never arrive.
 *
 * It stays real on the read side: `GET /keys` returns stored rows, so a
 * stamped row's expiry does reach a caller listing keys, and the list schema
 * keeps the field. The expiry belongs to the read, not to the creates.
 */
export const KeyResponseSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    label: z.string(),
    source: z.string(),
    permissions: z.array(PermissionEnum).optional(),
    oauth_client_id: z.string().optional(),
    default_tier: TierEnum,
    is_operator: z.boolean(),
    type_permissions: z.record(z.string(), TypePermissionLevelEnum),
    extension_permissions: z.record(z.string(), PermissionLevelEnum).optional(),
    edge_permissions: z.record(z.string(), PermissionLevelEnum).optional(),
    metadata_permissions: z.record(z.string(), PermissionLevelEnum).optional(),
    // Declared because the handler already sends it. The fifth family arrived
    // with the permission model and this schema did not follow, so the published
    // shape was short of a field every mint returns.
    profile_permissions: z.record(z.string(), PermissionLevelEnum).optional(),
    enforcement_override: EnforcementOverrideSchema.optional(),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
  })
  .openapi("KeyResponse");
