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
import { REFUSAL_TEXT } from "../openapi.js";

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
  .describe(
    "An item's lifecycle state. `active`: in use, and what a listing returns by default. `archived`: kept and readable by ID, but left out of a default listing. `trashed`: in the trash until restored or purged. `revoked`: retired for good, on `system.*` items only.",
  )
  .openapi("ItemState");

/**
 * The two tiers an item can be written to, and a key's default.
 *
 * Named and shared for the same reason as the states: spelled inline it
 * reaches the document as a fresh anonymous enum on every door that takes
 * one, and a generated client then carries one type per door for one
 * vocabulary.
 */
export const TierEnum = z
  .enum(["library", "feed"])
  .describe(
    "Which layer an item sits in. `library`: what a person chose to keep. `feed`: what arrives in volume from connectors and capture, as it came.",
  )
  .openapi("Tier");

/** The instance-wide permissions a credential can hold. */
export const PermissionEnum = z
  .enum(PERMISSIONS as unknown as [string, ...string[]])
  .describe(
    "A permission a credential can hold, for an operation the type, edge, extension, metadata and profile maps don't cover. `schema.write` replaces and deletes types and edge types; `keys.mint` mints keys and lists, changes and revokes those within the caller's reach; `keys.manage` lists and revokes every key and changes one without widening it; `items.purge` purges trashed items; `webhooks.manage` manages webhooks; `config.manage` reads and replaces `/config`; `audit.read` reads the audit log; `grants.manage` lists and revokes other apps' access; `instance.read` reads health, metrics, housekeeping, platform type drift, blob storage reports and every bulk job's status; `instance.maintain` runs housekeeping, resets platform type definitions and cancels bulk jobs; `connectors.manage` administers connector registrations and their endpoints, and clears their retained state; and `blobs.manage` manages every blob.",
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
export const EdgePageSchema = pageOf(EdgeSchema, "EdgePage", {
  page: "A page of edges.",
  data: "The edges on this page.",
});

/** The extension namespaces a credential may read, on every answer that
 *  carries them. */
export const READABLE_EXTENSIONS_TEXT =
  "The item's extension namespaces that you can read, each mapped to its data.";

export const ItemSchema = z
  .object({
    id: z.string().describe("Unique identifier for the item."),
    type: z
      .string()
      .describe("The item's type identifier, such as `core.note`."),
    properties: z
      .record(z.string(), z.unknown())
      .describe("The item's properties, by name."),
    state: ItemStateEnum.describe("The item's lifecycle state."),
    tier: TierEnum.optional().describe(
      "The item's tier. It doesn't apply to `system.*` items, which carry `library`.",
    ),
    version: z
      .number()
      .describe(
        "The item's version. It starts at 1 and goes up by one on each update to the item's properties, `tier`, `occurred_at`, `source_id` or type. A change to its state, tags, extensions or edges leaves it as it is.",
      ),
    schema_version: z
      .number()
      .int()
      .describe(
        "The `version` the item's type had when the item was created. Marfa never changes it, even when the item moves to another type, and doesn't act on it.",
      ),
    source: z
      .string()
      .describe(
        "The source the item was written under: the writer's own, or one its key claims. It never changes.",
      ),
    source_id: z
      .string()
      .optional()
      .describe(
        "The item's identifier at its source. With `source`, it is the item's natural key. Absent if the writer set none.",
      ),
    capture_latitude: z
      .number()
      .optional()
      .describe(
        "The latitude where the item was captured. Absent if the writer set none.",
      ),
    capture_longitude: z
      .number()
      .optional()
      .describe(
        "The longitude where the item was captured. Absent if the writer set none.",
      ),
    occurred_at: z
      .string()
      .describe(
        "When the item happened, in UTC. Defaults to when it was created.",
      ),
    created_at: z.string().describe("When the item was created, in UTC."),
    updated_at: z
      .string()
      .describe(
        "When the item was last written, in UTC. A tag or extension write moves it too.",
      ),
    trashed_by_cascade: z
      .boolean()
      .optional()
      .describe(
        "Always `true` where present: the item went to the trash with another item, through a cascading edge such as `parent-of`. Present while it stays in the trash. Absent on an item trashed on its own.",
      ),
    trashed_with: z
      .string()
      .optional()
      .describe(
        "The ID of the item whose trash took this one into the trash, beside `trashed_by_cascade`, whatever became of that item since. Present only if you can read that item's type.",
      ),
    edges: z
      .record(z.string(), EdgePageSchema)
      .optional()
      .describe(
        "The item's outbound edges you can read, by edge type. Each holds the first page of that type, which `GET /items/{id}/edges` continues. Absent where an operation doesn't return edges, such as a listing without `include=edges`.",
      ),
    extensions: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        `${READABLE_EXTENSIONS_TEXT} Present only where \`include\` names \`extensions\`.`,
      ),
  })
  .describe("An item is one record in Marfa.")
  .openapi("Item");

// MetadataSchema does not include `about` — entity references are carried
// as first-class `about` edges.
export const MetadataSchema = z
  .object({
    item_id: z.string().describe("The ID of the item the metadata belongs to."),
    tags: z.array(z.string()).describe("The item's tags."),
    extensions: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .describe(READABLE_EXTENSIONS_TEXT),
  })
  .describe("An item's metadata: its tags and its extension namespaces.")
  .openapi("Metadata");

const THE_ITEM = "The item.";

/** `listed`, on every item a conditional read returns. */
const LISTED_TEXT =
  "`true` if listings show you this item, `false` if `source_filter` leaves it out of them and you can read it only by ID. Present only when you send `X-Marfa-Read-View`.";
const THE_ITEMS_METADATA = "The item's metadata.";

export const ItemWithMetadataSchema = z
  .object({
    item: ItemSchema.describe(THE_ITEM),
    metadata: MetadataSchema.describe(THE_ITEMS_METADATA),
    acknowledged: z
      .boolean()
      .optional()
      .describe(
        "`true` when Marfa accepted a create and wrote nothing: it repeats an `id` you already created, or its natural key matches an item in the trash. Absent otherwise.",
      ),
  })
  .describe("An item with its metadata.")
  .openapi("ItemWithMetadata");

export const ItemReadWithMetadataSchema = ItemWithMetadataSchema.extend({
  listed: z.boolean().optional().describe(LISTED_TEXT),
})
  .describe("An item with its metadata, as a read returns it.")
  .openapi("ItemReadWithMetadata");

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
    "How Marfa resolves a conflict on one field. `last_writer_wins` takes the later write. `keep_both_copies` keeps the losing value in a new item tagged `conflicted-copy`, with a `derived-from` edge to the original.",
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

/** The error block of a `409` that hands back the row beside it. */
function conflictErrorOf<const C extends string>(code: C, name: string) {
  return z
    .object({
      code: z.literal(code).describe(REFUSAL_TEXT.code),
      status: z.literal(409).describe("The HTTP status, always `409`."),
      message: z.string().describe(REFUSAL_TEXT.message),
    })
    .describe(`The error block of the \`${code}\` refusal.`)
    .openapi(name);
}

/**
 * The refusal block every single-write `version_conflict` carries.
 *
 * The item doors and the edge doors answer envelopes that differ in what
 * they hand back beside it — an edge has no ancestor and no field-level
 * merge — but the refusal itself is the same three fields on both, and a
 * client branches on `code` without knowing which door answered.
 */
export const VersionConflictErrorSchema = conflictErrorOf(
  "version_conflict",
  "VersionConflictError",
);

/**
 * The refusal block of a write based on a version with no snapshot it may
 * be merged against: none is held, or the writer may not read the one that
 * is. Distinct from `version_conflict` because it cannot be resolved: there
 * is no ancestor, so no field can be shown not to have collided, and a
 * client merging against an empty one spawns siblings holding text nobody
 * typed.
 */
export const AncestorUnavailableErrorSchema = conflictErrorOf(
  "ancestor_unavailable",
  "AncestorUnavailableError",
);

/** What a bulk page did with one entry. */
export const BulkResultOutcomeEnum = z
  .enum(["created", "updated", "skipped", "errored"])
  .describe(
    "What happened to one entry of a bulk write. `created`: it made a new item or edge. `updated`: it changed an existing one. `skipped`: it wrote nothing, for the reason in `reason`. `errored`: it was refused, and `error` says why.",
  )
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
    code: z.string().describe(REFUSAL_TEXT.code),
    message: z.string().describe(REFUSAL_TEXT.message),
    details: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(REFUSAL_TEXT.details),
  })
  .describe(
    "Why one entry of a bulk write is `errored`: the error a single write would return.",
  )
  .openapi("BulkEntryError");

/** An item's metadata document, as the five metadata doors answer it. */
export const MetadataResponseSchema = z
  .object({ metadata: MetadataSchema.describe(THE_ITEMS_METADATA) })
  .describe("An item's metadata.")
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
    index: z
      .number()
      .int()
      .describe("The entry's position in the request, counting from 0."),
    outcome: BulkResultOutcomeEnum.describe("What happened to the entry."),
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
        "Why a `skipped` entry wrote nothing. Under `create_only`, a match exists: `duplicate_source` by natural key, `duplicate_id` by `id`, `duplicate_edge` by source, target and edge type. Under `upsert`, `trashed`: the natural key matches a trashed item.",
      ),
    error: BulkEntryErrorSchema.optional().describe(
      "Why the entry was refused. Present when `outcome` is `errored`.",
    ),
  })
  .describe("What happened to one entry of a bulk write.")
  .openapi("BulkResultEntry");

/** How a bulk page's entries came out, counted by outcome. */
export const BulkCountsSchema = z
  .object({
    created: z.number().int().describe("How many entries were `created`."),
    updated: z.number().int().describe("How many entries were `updated`."),
    skipped: z.number().int().describe("How many entries were `skipped`."),
    errored: z.number().int().describe("How many entries were `errored`."),
  })
  .describe("How many entries of a bulk write had each outcome.")
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
    counts: BulkCountsSchema.describe("How many entries had each outcome."),
    results: z
      .array(BulkResultEntrySchema)
      .describe("One result per entry, in the order you sent them."),
  })
  .describe("What a bulk write did with each entry.")
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

/** The fields a snapshot of an item holds as they were at its version, on
 *  the history and on a conflict's two sides alike. */
export const AT_THIS_VERSION = {
  properties: "The item's properties at this version.",
  tier: "The item's tier at this version.",
  occurred_at: "When the item happened, in UTC, at this version.",
  source_id:
    "The item's `source_id` at this version, or `null` if it had none.",
} as const;

export const VersionSchema = z
  .object({
    id: z.string().describe("Unique identifier for the snapshot."),
    item_id: z.string().describe("The ID of the item."),
    version: z.number().describe("The item version the snapshot records."),
    properties: z
      .record(z.string(), z.unknown())
      .describe(AT_THIS_VERSION.properties),
    type: z
      .string()
      .describe(
        "The type the row had at this version, which a row moved since no longer has. A snapshot is answered only to a credential that may read it.",
      ),
    tier: TierEnum.describe(AT_THIS_VERSION.tier),
    occurred_at: z.string().describe(AT_THIS_VERSION.occurred_at),
    source_id: z.string().nullable().describe(AT_THIS_VERSION.source_id),
    created_at: z
      .string()
      .describe("When Marfa recorded the snapshot, in UTC."),
  })
  .describe(
    "A snapshot of an item as it stood at one version, which Marfa records when the item is updated past it.",
  )
  .openapi("Version");

/** A page of an item's history, oldest first, holding only the snapshots
 *  the credential may read. */
export const VersionPageSchema = pageOf(VersionSchema, "VersionPage", {
  page: "A page of an item's version snapshots, oldest first.",
  data: "The snapshots on this page.",
});

/**
 * The single-item read response.
 *
 * `neighbors_truncated` is the only signal that the combined neighbor set
 * across edge types was capped: each per-type block's `next_cursor` covers
 * only its own type. `neighbors_omitted` is about permission rather than a
 * bound; without it a partial neighborhood reads as a complete one.
 */
export const ItemDetailSchema = z
  .object({
    item: ItemSchema.describe("The item, with its outbound edges."),
    metadata: MetadataSchema.describe(THE_ITEMS_METADATA),
    backrefs: z
      .record(z.string(), EdgePageSchema)
      .optional()
      .describe(
        "The item's inbound edges you can read, by edge type. Each holds the first page of that type, which `GET /items/{id}/backrefs` continues. Present with `include=backrefs`.",
      ),
    listed: z.boolean().optional().describe(LISTED_TEXT),
    neighbors: z
      .array(ItemReadWithMetadataSchema)
      .optional()
      .describe(
        "The items you can read at the far end of `item.edges`, and of `backrefs` if you asked for both, with their metadata. Leaves out `system.*` items without counting them in `neighbors_omitted`. Present with `include=neighbors`.",
      ),
    neighbors_truncated: z
      .boolean()
      .optional()
      .describe(
        "`true` if this answer's edges reach more than 100 items, so `neighbors` leaves some out. Page `GET /items/{id}/edges` and `GET /items/{id}/backrefs` for the rest. Present with `include=neighbors`.",
      ),
    neighbors_omitted: z
      .number()
      .int()
      .optional()
      .describe(
        "How many neighbors `neighbors` leaves out because you can't read their type. Present with `include=neighbors`.",
      ),
    versions: VersionPageSchema.optional().describe(
      "The first page of the item's version snapshots you can read, oldest first, which `GET /items/{id}/versions` continues. Present with `include=versions`.",
    ),
  })
  .describe(
    "An item as `GET /items/{id}` returns it: the item, its metadata, and the extras `include` asks for.",
  )
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
 * The named schemas that a field naming them describes in its own words,
 * registered once on the app. The route modules that declare such schemas
 * export their own record beside this one, and the app registers them all.
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
    // Ahead of the objects whose fields describe them, since a schema is
    // met as it is generated, in this order.
    ItemState: ItemStateEnum,
    Tier: TierEnum,
    Edge: EdgeSchema,
    Item: ItemSchema,
    Metadata: MetadataSchema,
    MergePolicy: MergePolicySchema,
    VersionConflictError: VersionConflictErrorSchema,
    AncestorUnavailableError: AncestorUnavailableErrorSchema,
    VersionPage: VersionPageSchema,
    BulkCounts: BulkCountsSchema,
    BulkResultOutcome: BulkResultOutcomeEnum,
    BulkEntryError: BulkEntryErrorSchema,
  };

/**
 * Field text every key answer shares, and the bodies that write the same
 * fields where the words hold for both.
 */
export const KEY_FIELD_TEXT = {
  id: "Unique identifier for the key.",
  label: "A name for the key, to tell it apart from your other keys.",
  source:
    "The key's own source, stamped on the rows it writes unless a write names a source it claims. No other key that hasn't been revoked or expired has it as its own, and it can't change.",
  sources:
    "Sources the key may also write under, besides its own `source`. Several keys may claim one source, so their writes share natural keys. Empty if the key claims none.",
  permissions:
    "The permissions the key holds, such as `audit.read`. Empty if it holds none.",
  oauth_client_id:
    "The app origin client ID, inherited by every descendant key. Absent when no app is in the key's origin.",
  default_tier:
    "The tier an item this key creates goes to when the write names none.",
  type_permissions:
    "Item types the key may `read` or `write`, by type ID or a wildcard such as `core.*` or `*`. `none` denies a type a wildcard covers.",
  extension_permissions:
    "Extension namespaces the key may `read` or `write`, by namespace or `*`.",
  edge_permissions:
    "Edge types the key may `read` or `write`, by edge type, a namespace wildcard such as `user.*`, or `*`.",
  metadata_permissions:
    "Registrations the key may make: `types` to register types and `edge_types` to register edge types, at `write`. `*` covers both.",
  profile_permissions:
    "What the key may `read` or `write` of the owner's profile: `name`, `email` or `avatar`, or `*` for all of it.",
  enforcement_override:
    "The key's own enforcement levers. Absent if the key sets none, so it follows the instance's.",
  created_at: "When the key was created, in UTC.",
  expires_at:
    "When the key stops working, in UTC, or `null` if it doesn't expire.",
  last_used_at:
    "When the key was last used, in UTC, or `null` if never. Marfa updates it at most once an hour.",
} as const;

/** An API key as the create route answers it. */
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
    expires_at: z.string().nullable().describe(KEY_FIELD_TEXT.expires_at),
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
