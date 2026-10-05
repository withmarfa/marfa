import { maxStringLength } from "@withmarfa/shared";
/**
 * Reusable Zod schemas shared across route files. Centralized so each wire
 * shape is declared once.
 *
 * The consumers are not listed here on purpose: a header naming its
 * importers is a second place to update whenever one is added, and nothing
 * fails when it is not. What holds the claim is
 * `wire-shape-declarations.test.ts`, which fails if a route file declares a
 * shape this file already exports.
 *
 * Nothing here imports from a route file, so any of them can import this.
 *
 * **Sharing a name with another route file is not by itself a reason to move
 * a shape here.** `IdParam` is declared in four of them, each a bare string
 * with the description its own door needs: consolidating it would be a
 * choice to give every one of those doors one description, not a move, and
 * the descriptions are what a reader of the reference sees.
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
import { MAX_TAG_LENGTH } from "../tag-limits.js";

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
  .describe(
    "A permission a credential can hold. `schema.write` replaces and deletes types and edge types, `keys.mint` creates and manages keys, `items.purge` purges trashed items, `webhooks.manage` manages webhooks, `config.manage` reads and replaces `/config`, `audit.read` reads the audit log, and `grants.manage` lists and revokes other apps' access.",
  )
  .openapi("Permission");

/** What a credential may do with one type: read it, write it, or neither. */
export const TypePermissionLevelEnum = z
  .enum(["read", "write", "none"])
  .describe(
    "What a key may do with a type: `read` it, `write` it (which includes reading), or `none`, which denies a type a wildcard entry would reach.",
  )
  .openapi("TypePermissionLevel");

/**
 * What a credential may do with one extension, edge type, metadata family or
 * profile. Absence is the refusal on these, so there is no `none` member.
 */
export const PermissionLevelEnum = z
  .enum(["read", "write"])
  .describe(
    "What a key may do with an entry: `read` it, or `write` it (which includes reading). A name no entry covers is denied.",
  )
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

/** The three fields that name an edge, worded once for every door that
 *  takes or returns them. */
export const edgeTripleFields = {
  source_id: z.string().describe("The ID of the item the edge starts from."),
  target_id: z.string().describe("The ID of the item the edge points to."),
  edge_type: z
    .string()
    .describe("The identifier of the edge type, such as `parent-of`."),
};

export const EdgeSchema = z
  .object({
    id: z.string().describe("Unique identifier for the edge."),
    ...edgeTripleFields,
    properties: z
      .record(z.string(), z.unknown())
      .describe("The edge's properties, by name."),
    created_at: z.string().describe("When the edge was created, in UTC."),
    updated_at: z.string().describe("When the edge last changed, in UTC."),
    version: z
      .number()
      .describe(
        "The edge's version. It goes up by one on every update, including one that changes nothing.",
      ),
  })
  .describe(
    "An edge is a typed, directed relationship from a source item to a target item.",
  )
  .openapi("Edge");

/**
 * One page of rows, the shape of every list and search: the rows, and the
 * cursor that continues past them, `null` on the last page. Registered under
 * its own name so each list's page is one component a generated client
 * names, and every page is the same two keys.
 */
export function pageOf<T extends z.ZodType>(
  row: T,
  name: string,
  text?: { page: string; data: string },
) {
  return z
    .object({
      data: text ? z.array(row).describe(text.data) : z.array(row),
      next_cursor: NextCursorSchema,
    })
    .openapi(name, text ? { description: text.page } : {});
}

/**
 * A page that never continues, answered whole, so its cursor says so rather
 * than inviting a walk. `extra` carries a field the list answers beside its
 * rows.
 */
export function wholeListOf<T extends z.ZodType>(
  row: T,
  name: string,
  noun: string,
  extra: z.ZodRawShape = {},
) {
  return z
    .object({
      data: z.array(row).describe(`Every ${noun}.`),
      next_cursor: NextCursorSchema.describe(
        `Always \`null\`: Marfa returns every ${noun} in one page.`,
      ),
      ...extra,
    })
    .openapi(name, { description: `A page holding every ${noun}.` });
}

/** The continuation every page carries: a cursor to the next page, `null`
 *  on the last. Declared once so a page that carries a sibling beside it,
 *  as the stores and occurrences doors do, carries the same field. */
export const NextCursorSchema = z
  .string()
  .nullable()
  .describe(
    "Pass as `cursor` for the next page; `null` on the last. A page can be short, or empty, with a cursor still to follow, so a walk stops on `null` and never on a short page.",
  );

/**
 * A page of edges. Also a single edge type's hydrated block on an item
 * response, which is the first page of that type's edges, cut at 50 by
 * default, that `GET /items/{id}/edges?edge_type=X&cursor=...` continues.
 */
export const EdgePageSchema = pageOf(EdgeSchema, "EdgePage");

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
    trashed_by_cascade: z
      .boolean()
      .optional()
      .describe(
        "Always `true` where present: on an item a trash took into the bin through a cascading edge such as `parent-of`, for as long as the item stays in the bin, even once the item that trash named is purged, to any caller that may read the item. Absent on a row trashed on its own and on every row out of the bin. A connector reads it to tell a trash the person made from one a cascade made.",
      ),
    trashed_with: z
      .string()
      .optional()
      .describe(
        "The item whose trash took this one into the bin, beside `trashed_by_cascade`, whatever became of that item since. Answered only to a caller that may read that item's type.",
      ),
    /**
     * Hydrated outbound edges per type. Always populated on single-item GETs;
     * opt-in on list GETs via ?include=edges. An empty object means no edges
     * or hydration was skipped.
     */
    edges: z.record(z.string(), EdgePageSchema).optional(),
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
    extensions: z.record(z.string(), z.record(z.string(), z.unknown())),
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

export const ItemReadWithMetadataSchema = ItemWithMetadataSchema.extend({
  listed: z
    .boolean()
    .optional()
    .describe(
      "Required on conditional copy reads. Whether this item belongs to the effective source-filtered item set, before local type and tier selection.",
    ),
}).openapi("ItemReadWithMetadata");

/**
 * How a collision on one field is resolved.
 *
 * Shared because a type declares the policy and an item write reports what
 * it applied: two doors describing one vocabulary, which is what belongs
 * here.
 */
export const MergeStrategyEnum = z
  .enum(["last_writer_wins", "keep_both_copies"])
  .describe(
    "How Marfa resolves a conflict on one field. `last_writer_wins` takes the later write. `keep_both_copies` keeps the losing value in a new item tagged `conflicted-copy`.",
  )
  .openapi("MergeStrategy");

/** A type's merge policy: a strategy per field, and one for the rest. */
export const MergePolicySchema = z
  .looseObject({
    fields: z
      .record(z.string(), MergeStrategyEnum)
      .optional()
      .describe("The strategy for each field the policy names."),
    default: MergeStrategyEnum.optional().describe(
      "The strategy for a field `fields` doesn't name. Leave it out for `last_writer_wins`.",
    ),
  })
  .describe(
    "How Marfa merges conflicting edits to the items of a type: a strategy for each named field, and a default for the rest.",
  )
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
 * A per-entry refusal or unconfirmed commit inside a bulk page.
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

/** An item's metadata document, as the five metadata doors answer it. */
export const MetadataResponseSchema = z
  .object({ metadata: MetadataSchema })
  .openapi("MetadataResponse");

/** One edge, as the three single-edge doors answer it. */
export const EdgeResponseSchema = z
  .object({ edge: EdgeSchema.describe("The edge.") })
  .describe("One edge.")
  .openapi("EdgeResponse");

/** Why a bulk entry was skipped, across both bulk doors. */
export const BULK_SKIP_REASONS = [
  "duplicate_edge",
  "duplicate_id",
  "duplicate_source",
  "trashed",
] as const;

export type BulkSkipReason = (typeof BULK_SKIP_REASONS)[number];

/** What one entry of a bulk page came out as, on either bulk door. */
export const BulkResultEntrySchema = z
  .object({
    index: z.number().int(),
    outcome: BulkResultOutcomeEnum,
    id: z
      .string()
      .optional()
      .describe(
        "The id of what the entry wrote or resolved. Absent where an item entry's natural key resolved a row of a type the credential may not read: the entry learns that its key is taken and nothing of the row.",
      ),
    reason: z
      .enum(BULK_SKIP_REASONS)
      .optional()
      .describe(
        "Why a `skipped` entry wrote nothing. `duplicate_source`: under `create_only`, an item with this `source` and `source_id` exists. `duplicate_id`: under `create_only`, an item with this `id` exists. `duplicate_edge`: under `create_only`, an edge with this `source_id`, `target_id` and `edge_type` exists. `trashed`: under `upsert`, the `source` and `source_id` match an item in the trash, which stays there.",
      ),
    error: BulkEntryErrorSchema.optional(),
  })
  .openapi("BulkResultEntry");

/** How a bulk page's entries came out, counted by outcome. */
export const BulkCountsSchema = z
  .object({
    created: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    errored: z.number().int(),
  })
  .openapi("BulkCounts");

/** `atomic` on both bulk doors. */
export const BulkAtomicSchema = z
  .boolean()
  .optional()
  .describe(
    "Whether one failed entry rolls back the whole batch. Defaults to `true`. With `false`, that entry is `errored` and the rest are written.",
  );

/** `enable_fanout` on both bulk doors. */
export const BulkEnableFanoutSchema = z
  .boolean()
  .optional()
  .describe(
    "Whether each write also calls outbound webhooks. Defaults to `false`. Marfa logs the events either way.",
  );

/** What a bulk page did, on either bulk door. */
export const BulkResponseSchema = z
  .object({
    counts: BulkCountsSchema,
    results: z.array(BulkResultEntrySchema),
  })
  .openapi("BulkResponse");

/**
 * `null` at one position, without widening the shape that admits it.
 *
 * `.nullable()` on a registered shape mutates the registered component:
 * the null is folded into the component and every door referencing it
 * inherits a null it cannot answer. A union carries the null at the
 * position that has one.
 */
export function nullableRef<T extends z.ZodType>(schema: T) {
  return z.union([schema, z.null()]);
}

export const VersionSchema = z
  .object({
    id: z.string(),
    item_id: z.string(),
    version: z.number(),
    properties: z.record(z.string(), z.unknown()),
    type: z
      .string()
      .describe(
        "The type the row had at this version, which a row moved since no longer has. A snapshot is answered only to a credential that may read it.",
      ),
    tier: TierEnum,
    occurred_at: z.string(),
    source_id: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Version");

/** A page of an item's history, oldest first, holding only the snapshots
 *  the credential may read. */
export const VersionPageSchema = pageOf(VersionSchema, "VersionPage");

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
 *   per-type edge block's `next_cursor` does not cover a combined-set overflow.
 *   Consumers must page the per-type edge/backref endpoints when it is set.
 * - `neighbors_omitted` — how many of the item's neighbors were left out
 *   because the caller may not read them. Distinct from `neighbors_truncated`,
 *   which is about a bound; this is about permission. Without it a partial
 *   neighborhood reads as a complete one, and a caller missing an edge scope
 *   renders an item with none of its relations as though it had none.
 * - `versions` — the first page of the item's version snapshots, oldest
 *   first, as `GET /items/{id}/versions` answers it, which its `next_cursor`
 *   continues. Opt in with `include=versions`.
 */
export const ItemDetailSchema = z
  .object({
    item: ItemSchema,
    metadata: MetadataSchema,
    backrefs: z.record(z.string(), EdgePageSchema).optional(),
    listed: z
      .boolean()
      .optional()
      .describe(
        "Required on conditional copy reads; direct authority is independent of this item-set membership.",
      ),
    neighbors: z.array(ItemReadWithMetadataSchema).optional(),
    neighbors_truncated: z.boolean().optional(),
    neighbors_omitted: z.number().int().optional(),
    versions: VersionPageSchema.optional(),
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
const enforcementSchema = (strict: boolean) => {
  const obj = strict ? z.strictObject : z.object;
  const typeList = z
    .array(z.string())
    .describe("The types the lever applies to.");
  const typesAndSources = {
    types: typeList,
    sources: z
      .array(z.string())
      .describe("The sources the lever lets through on those types."),
  };
  // The component names carry the strictness, because the two shapes are not
  // the same shape: the strict one refuses a key the permissive one keeps,
  // and one name over both would publish whichever was registered first as
  // the meaning of the other. The allowlist and the filter share one name
  // for the opposite reason: they are the same shape, and which lever a
  // block sits under is the property's job to say.
  const suffix = strict ? "Strict" : "";
  const typesOnly = obj({ types: typeList })
    .describe("A lever that applies to the types it names.")
    .openapi(`TypeLever${suffix}`);
  const typesAndSourcesLever = obj(typesAndSources)
    .describe(
      "A lever that applies to the types it names, and lets through the sources it names.",
    )
    .openapi(`TypeAndSourceLever${suffix}`);
  const block = obj({
    strict_mode: typesOnly
      .describe(
        "Types on which a write may not set a property the type doesn't declare.",
      )
      .optional(),
    source_allowlist: typesAndSourcesLever
      .describe("Types that take new items only from the listed sources.")
      .optional(),
    source_filter: typesAndSourcesLever
      .describe(
        "Types whose listings, searches and exports show only items from the listed sources. A read by ID isn't narrowed.",
      )
      .optional(),
  });
  return {
    block,
    levers: {
      [`TypeLever${suffix}`]: typesOnly,
      [`TypeAndSourceLever${suffix}`]: typesAndSourcesLever,
    },
  };
};

/**
 * The permissive block, built once.
 *
 * Every door that reads the levers, and the key override, share this one
 * object: building a second from the same factory registers a second
 * schema under the same component names, and the registry keeps whichever
 * reached it first without saying so.
 */
const enforcementRead = enforcementSchema(false);
export const EnforcementReadSchema = enforcementRead.block;

/** The strict block the instance config's write takes, built once. */
const enforcementWrite = enforcementSchema(true);
export const EnforcementWriteSchema = enforcementWrite.block;

/** A key's per-credential override: the same levers, permissive. */
export const EnforcementOverrideSchema = EnforcementReadSchema.describe(
  "A key's own enforcement levers, in the shape `/config` uses. Each lever set here replaces the instance's for this key, looser or stricter; a lever left out stays the instance's.",
).openapi("EnforcementOverride");

/**
 * The named schemas that every field naming them describes in its own words,
 * registered once on the app.
 *
 * The generator takes a component's description from the first schema it
 * meets under the component's name, and registered schemas ahead of every
 * route. Without the registration, the first field's text would become the
 * component's.
 */
export const DESCRIBED_ONLY_BY_REFERENCE: Readonly<Record<string, z.ZodType>> =
  {
    ...enforcementRead.levers,
    ...enforcementWrite.levers,
    EnforcementOverride: EnforcementOverrideSchema,
  };

/**
 * Field text every key answer shares, and the bodies that write the same
 * fields where the words hold for both.
 */
export const KEY_FIELD_TEXT = {
  id: "Unique identifier for the key.",
  label: "A name for the key, to tell it apart from your other keys.",
  source:
    "The key's own source, stamped on the rows it writes unless a write names a source it claims. No other unrevoked key has it as its own, and it can't change.",
  sources:
    "Sources the key may also write under, besides its own `source`. Several keys may claim one source, so their writes share natural keys. Empty if the key claims none.",
  permissions:
    "The permissions the key holds, such as `audit.read`. Empty if it holds none.",
  oauth_client_id:
    "The `client_id` of the app whose sign-in token created this key. Absent on every other key.",
  default_tier:
    "The tier an item this key creates goes to when the write names none.",
  is_operator:
    "`true` if this is an operator key. An operator key opens the routes that run the instance, such as `/housekeeping`, and holds no permissions, so it reads and writes no items.",
  type_permissions:
    "Item types the key may `read` or `write`, by type ID or a wildcard such as `core.*` or `*`. `none` denies a type a wildcard covers.",
  extension_permissions:
    "Extension namespaces the key may `read` or `write`, by namespace or `*`. A key can always read and write the namespace named by its own `label`.",
  edge_permissions:
    "Edge types the key may `read` or `write`, by edge type, a namespace wildcard such as `user.*`, or `*`.",
  metadata_permissions:
    "Registrations the key may make: `types` to register types and `edge_types` to register edge types, at `write`. `*` covers both.",
  profile_permissions:
    "What the key may `read` or `write` of the owner's profile: `name`, `email` or `avatar`, or `*` for all of it.",
  enforcement_override:
    "The key's own enforcement levers. Absent if the key sets none, so it follows the instance's.",
  created_at: "When the key was created, in UTC.",
  last_used_at:
    "When the key was last used, in UTC, or `null` if never. Marfa updates it at most once an hour.",
} as const;

/**
 * An API key as a create route answers it, on both doors that mint one.
 *
 * No `expires_at`: `CreateKeyInput` cannot carry an expiry and neither door
 * sets one, so every key either mints has none, and declaring the field
 * would promise a generated client a property that cannot arrive. It is
 * real on the read side, where `GET /keys` returns stored rows and a
 * stamped expiry does reach the caller, so the list schema keeps it.
 */
export const KeyResponseSchema = z
  .object({
    id: z.string().describe(KEY_FIELD_TEXT.id),
    key: z
      .string()
      .describe(
        "The plaintext key, which you send as a bearer token. Save it: no other response shows it.",
      ),
    label: z.string().describe(KEY_FIELD_TEXT.label),
    source: z.string().describe(KEY_FIELD_TEXT.source),
    sources: z.array(z.string()).describe(KEY_FIELD_TEXT.sources),
    permissions: z.array(PermissionEnum).describe(KEY_FIELD_TEXT.permissions),
    oauth_client_id: z
      .string()
      .optional()
      .describe(KEY_FIELD_TEXT.oauth_client_id),
    default_tier: TierEnum.describe(KEY_FIELD_TEXT.default_tier),
    is_operator: z.boolean().describe(KEY_FIELD_TEXT.is_operator),
    type_permissions: z
      .record(z.string(), TypePermissionLevelEnum)
      .describe(KEY_FIELD_TEXT.type_permissions),
    extension_permissions: z
      .record(z.string(), PermissionLevelEnum)
      .describe(KEY_FIELD_TEXT.extension_permissions),
    edge_permissions: z
      .record(z.string(), PermissionLevelEnum)
      .describe(KEY_FIELD_TEXT.edge_permissions),
    metadata_permissions: z
      .record(z.string(), PermissionLevelEnum)
      .describe(KEY_FIELD_TEXT.metadata_permissions),
    // Declared because the handler sends it: a field every mint returns and
    // the published shape omits is one a generated client cannot read.
    profile_permissions: z
      .record(z.string(), PermissionLevelEnum)
      .describe(KEY_FIELD_TEXT.profile_permissions),
    enforcement_override: EnforcementOverrideSchema.describe(
      KEY_FIELD_TEXT.enforcement_override,
    ).optional(),
    created_at: z.string().describe(KEY_FIELD_TEXT.created_at),
    last_used_at: z.string().nullable().describe(KEY_FIELD_TEXT.last_used_at),
  })
  .describe("A new API key, with its plaintext `key`.")
  .openapi("KeyResponse");

/** A tag a write may carry: not empty, not blank, and short enough to name
 *  in a URL path. */
export const TagSchema = maxStringLength(
  z.string().min(1),
  MAX_TAG_LENGTH,
).refine((tag) => tag.trim().length > 0, "A tag must not be blank");

export const WrittenPropertiesSchema = z.record(z.string().min(1), z.unknown());
