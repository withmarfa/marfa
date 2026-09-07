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
 * The two space shapes differ outright, the administrative one carrying a
 * status the user-facing one does not, so folding them is a surface change in
 * one direction or a regression in the other.
 *
 * What belongs here is a shape two doors are trying to describe identically
 * and failing to.
 */
import { z } from "@hono/zod-openapi";
import { RoleResponseSchema } from "./role-schema.js";
import { ITEM_STATES, MarfaError, ErrorCode } from "@withmarfa/shared";
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
export const ItemStateEnum = z.enum(
  ITEM_STATES as unknown as [ItemState, ...ItemState[]],
);

/**
 * The `?state=` value that means "every state, trashed included".
 *
 * Deliberately not a member of the lifecycle vocabulary: it is a widening
 * of the default rather than a state a row can be in, and nothing may
 * compare it against the column.
 */
export const ALL_STATES = "any";

/**
 * Resolve a `?state=` parameter into the pair the storage filter takes.
 *
 * One implementation for every door that reads items, because the doors
 * disagreed: the item listing gained the sentinel and `GET /export` did
 * not, so the one read whose whole purpose is a complete copy was the one
 * that could not ask for every state and quietly returned the space minus
 * its bin. The archive an export writes is what a restore reads back, so
 * that omission is silently lossy in the place it matters most.
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

export const EdgeSchema = z.object({
  id: z.string(),
  space_id: z.string().nullable().optional(),
  source_id: z.string(),
  target_id: z.string(),
  edge_type: z.string(),
  properties: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number(),
});

/**
 * A single edge type's hydrated block on an item response. Per-type cap is
 * 50 by default; has_more + next_cursor signal that more edges exist and the
 * caller should paginate via GET /items/:id/edges?edge_type=X&cursor=...
 */
export const ItemEdgesBlockSchema = z.object({
  edges: z.array(EdgeSchema),
  has_more: z.boolean(),
  next_cursor: z.string().optional(),
});

export const ItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  properties: z.record(z.string(), z.unknown()),
  state: ItemStateEnum,
  /** Optional — `system.*` items have no tier. */
  tier: z.enum(["library", "feed"]).optional(),
  /**
   * Space scope. Storage queries are space-scoped at the SQL layer, so
   * for ordinary callers this always matches the caller's own space. The
   * field is informational; cross-space infrastructure (the reactive-run
   * bridge) reads this off the row to gate fanout. Mirrors the
   * `Edge.space_id` shape.
   */
  space_id: z.string().nullable().optional(),
  version: z.number(),
  schema_version: z.number().int(),
  source: z.string(),
  source_id: z.string().optional(),
  /**
   * Derived per read, never stored: whether the integration named in
   * `source` still has a live connection in this space. Present only on an
   * item an integration wrote — for anything else the question does not
   * arise, so absence means "not applicable" rather than "no". See
   * `_orphaned.ts` for why this is a second axis rather than a fourth
   * `state`.
   *
   * **Scope of that reading: REST responses carrying an item.** The `GET
   * /events` stream does not carry this field, because it cannot carry the
   * change it describes — removing a connection publishes no item events, so
   * an item never becomes orphaned *on the stream*. A client merging stream
   * frames over a read must therefore keep the value it read rather than
   * treating its absence in a frame as `false` or as "no integration wrote
   * this", and must re-read to refresh it.
   */
  orphaned: z.boolean().optional(),
  device: z.string().optional(),
  capture_latitude: z.number().optional(),
  capture_longitude: z.number().optional(),
  timestamp: z.string(),
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
});

// MetadataSchema does not include `about` — entity references are carried
// as first-class `about` edges.
export const MetadataSchema = z.object({
  item_id: z.string(),
  tags: z.array(z.string()),
  extensions: z.record(z.string(), z.unknown()),
});

export const ItemWithMetadataSchema = z.object({
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
});

export const VersionSchema = z.object({
  id: z.string(),
  item_id: z.string(),
  version: z.number(),
  properties: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  device: z.string().optional(),
});

/**
 * A space's quota row. Answered by the space's own quota route and by the
 * admin view of the same row, which is why it is here: the two are one
 * shape, and declaring it twice let them describe the same row differently.
 */
export const QuotaSchema = z.object({
  space_id: z.string(),
  items_limit: z.number().int().nullable(),
  webhooks_limit: z.number().int().nullable(),
  blobs_limit: z.number().int().nullable(),
  storage_bytes_limit: z.number().int().nullable(),
  rate_per_minute_limit: z.number().int().nullable(),
  updated_at: z.string().nullable(),
});

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
 * - `neighbors_omitted` — how many of the item's neighbours were left out
 *   because the caller may not read them. Distinct from `neighbors_truncated`,
 *   which is about a bound; this is about permission. Omitting silently made
 *   a partial neighbourhood indistinguishable from a complete one, so an app
 *   missing an edge scope rendered a ticket with none of its relations and
 *   looked correct doing it.
 * - `versions` — the item's version snapshots, newest-first. Opt in with
 *   `include=versions`.
 */
export const ItemDetailSchema = z.object({
  item: ItemSchema,
  metadata: MetadataSchema,
  backrefs: z.record(z.string(), ItemEdgesBlockSchema).optional(),
  neighbors: z.array(ItemWithMetadataSchema).optional(),
  neighbors_truncated: z.boolean().optional(),
  neighbors_omitted: z.number().int().optional(),
  versions: z.array(VersionSchema).optional(),
});

/**
 * An API key as a create route answers it.
 *
 * Two doors mint a key — the space caller's own and the platform-admin one
 * that binds a key to a space — and they answered with two declarations that
 * had drifted apart. One carried `expires_at` and the other did not.
 *
 * **The one without it was right.** An expiry is settable only through
 * `createRuntimeCredential`, which the storage interface documents as
 * requiring one and which the integration runtime calls in process. No route
 * reaches it, and `CreateKeyInput` cannot carry an expiry, so every key either
 * door can mint has none. Declaring the field on a create response promised
 * generated clients a property that could never arrive.
 *
 * It stays real on the read side: `GET /keys` returns stored rows, so a
 * runtime credential's stamp does reach a caller listing keys, and the list
 * schema keeps the field. The expiry belongs to the read, not to the creates.
 */
export const KeyResponseSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  source: z.string(),
  role: RoleResponseSchema,
  default_tier: z.enum(["library", "feed"]),
  is_platform: z.boolean(),
  scope_enforced: z
    .boolean()
    .optional()
    .describe(
      "Read-only. True when the key was minted through a signed-in app rather than from another key: its permission maps decide what it reaches, and its role does not override them. Set by the server at mint time and never settable through this API.",
    ),
  type_permissions: z.record(z.string(), z.enum(["read", "write", "none"])),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: z.record(z.string(), z.enum(["read", "write"])).optional(),
  metadata_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});
