import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { itemListed } from "../storage/read-view.js";
import { createRoute, z } from "@hono/zod-openapi";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  pageLimit,
  pageCursor,
} from "../page-limits.js";
import {
  MarfaError,
  ErrorCode,
  isValidId,
  isValidTimestamp,
  isValidTypeIdentifier,
  resolveEnforcement,
  malformedTypeIdentifier,
} from "@withmarfa/shared";
import type { ApiKey, Item, ItemState, Metadata } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import { credentialIdempotencyKey } from "../middleware/idempotency.js";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import { assertTypeFilter } from "./_type-filter.js";
import {
  requireWritableRow,
  checkTypeAccess,
  getTypeFilter,
  typeReader,
  requireAuth,
  requireReadableRow,
  requireTypeAccess,
  standingPermission,
  readsSomeType,
} from "../middleware/auth.js";
import type {
  Storage,
  ItemFilters,
  ItemSortField,
} from "../storage/interface.js";
import { rowOf, writeItem } from "../storage/item-write.js";
import { ITEM_EDGES_CURSOR_KEY } from "../storage/interface.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { publish } from "../pubsub.js";
import {
  excludesSystemTypes,
  SYSTEM_INCLUDE_TOKEN,
} from "./_system-type-visibility.js";
import { MAX_TAGS_PER_ITEM } from "../tag-limits.js";
import {
  hydrateEdgesForItem,
  hydrateEdgesForItems,
  hydrateBackrefsForItem,
  groupAndCap,
  HYDRATE_PER_TYPE_CAP,
} from "./_edges-hydrate.js";
import { itemAfterMetadataWrite } from "./_metadata-publish.js";
import { assertFilterEdgeTermsReadable } from "./_edge-visibility.js";
import { withCascadeMarks } from "./_cascade-marks.js";
import { hydrateExtensionsForItems } from "./_extensions-hydrate.js";
import {
  createOpenAPIRouter,
  IDEMPOTENCY_IN_FLIGHT,
  OkResponseSchema,
  REFUSAL_TEXT,
  makeErrorResponseSchema,
} from "../openapi.js";
import {
  ItemSchema,
  ItemWithMetadataSchema,
  ItemReadWithMetadataSchema,
  ItemDetailSchema,
  MetadataResponseSchema,
  MergePolicySchema,
  MergeStrategyEnum,
  TierEnum,
  VersionConflictErrorSchema,
  AncestorUnavailableErrorSchema,
  AT_THIS_VERSION,
  pageOf,
  resolveStateFilter,
  TagSchema,
  WrittenPropertiesSchema,
} from "./_schemas.js";
import { readableMetadata } from "./_extension-reach.js";
import { itemsLifecycleRoutes } from "./items-lifecycle.js";
import { itemsVersionsRoutes } from "./items-versions.js";
import { requestBlobProof } from "./_blob-reach.js";
import {
  ITEM_NOT_FOUND_ON_READ,
  ITEM_NOT_FOUND_ON_WRITE,
  READ_REFUSED,
  WRITE_REFUSED,
} from "./_item-refusals.js";
import {
  takesQueryKeysLike,
  type QueryKeyFamily,
} from "../middleware/undeclared-query-keys.js";

/**
 * The `?edge[<type>]=<id>` / `?backref[<type>]=<id>` shorthand keys.
 *
 * Declared once because two things read it: the clause builder that
 * compiles a match into the filter grammar, and the refusal of undeclared
 * query keys, which no schema can tell about a key whose type is part of its
 * name. The two doors that take them say so with `takesQueryKeysLike`.
 */
const EDGE_SHORTHAND_KEY = /^(edge|backref)\[([^\]]+)\]$/;
const EDGE_SHORTHAND_KEYS: QueryKeyFamily = {
  pattern: EDGE_SHORTHAND_KEY,
  spelling: "edge[<type>], backref[<type>]",
};

// ---------------------------------------------------------------------------
// Reusable schemas (Item / Metadata / ItemWithMetadata live in _schemas.ts;
// imported above. The conflict-response schemas are local to items.ts since
// no other route uses them.)
// ---------------------------------------------------------------------------

const ConflictSnapshotSchema = z
  .object({
    // The row, because a create names a natural key and not an id: refused
    // here, it learns which row the key resolved from this and nothing else.
    id: z.string().describe("The ID of the item."),
    version: z.number().describe("The item version this side shows."),
    properties: z
      .record(z.string(), z.unknown())
      .describe(AT_THIS_VERSION.properties),
    // The version check covers these three beside the properties, so a
    // collision can name one; without them here the refusal names a field
    // the caller has no way to read either side of.
    tier: TierEnum.describe(AT_THIS_VERSION.tier),
    occurred_at: z.string().describe(AT_THIS_VERSION.occurred_at),
    source_id: z.string().nullable().describe(AT_THIS_VERSION.source_id),
    // And the type, because a stale move onto a row moved since collides
    // on it: the refusal shows the type the row has and the one the
    // caller read.
    type: z.string().describe("The item's type identifier at this version."),
  })
  .describe("An item as it stood at one version, as a conflict shows it.")
  .openapi("ConflictSnapshot");

/** The two sides of a conflict, worded once for every conflict answer. */
const CONFLICT_SIDES = {
  error: REFUSAL_TEXT.error,
  current: "The item as it stands now.",
  ancestor: "The item at the `version` you sent.",
} as const;

export const ConflictResponseSchema = z
  .object({
    error: VersionConflictErrorSchema.describe(CONFLICT_SIDES.error),
    current: ConflictSnapshotSchema.describe(CONFLICT_SIDES.current),
    ancestor: ConflictSnapshotSchema.describe(CONFLICT_SIDES.ancestor),
    conflicting_fields: z
      .array(z.string())
      .describe(
        "The properties, and fields such as `tier`, that both your write and a write since your `version` changed.",
      ),
    merge_policy: MergePolicySchema.describe(
      "The merge policy of the item's type, which `conflict=auto` resolves by.",
    ),
  })
  .describe(
    "A stale write whose changes collide: the item now, the item at your version, and what collided.",
  )
  .openapi("ItemVersionConflict");

/**
 * The refusal for a stale write that carried nothing to merge.
 *
 * `current` and `error.status` are here because every `version_conflict`
 * carries them, whichever door answered and whatever the write held. What is
 * absent is what a merge would need and this write has none of: there is no
 * ancestor to compare against and no field that could have collided.
 */
const StaleVersionSchema = z
  .object({
    error: VersionConflictErrorSchema.describe(CONFLICT_SIDES.error),
    current: ConflictSnapshotSchema.describe(CONFLICT_SIDES.current),
  })
  .describe(
    "A stale write that carried nothing to merge: the error and the item now.",
  )
  .openapi("ItemStaleVersion");

/** The refusal for a write whose base version cannot be merged against. */
export const AncestorUnavailableSchema = z
  .object({
    error: AncestorUnavailableErrorSchema.describe(CONFLICT_SIDES.error),
    current: ConflictSnapshotSchema.describe(CONFLICT_SIDES.current),
    requested_version: z.number().describe("The `version` you sent."),
  })
  .describe(
    "A write Marfa can't merge, because it holds no snapshot you can read of the `version` you sent: the error and the item now.",
  )
  .openapi("ItemAncestorUnavailable");

/** This module's part of `DESCRIBED_ONLY_BY_REFERENCE` in `_schemas.ts`. */
export const ITEM_SCHEMAS_DESCRIBED_BY_REFERENCE: Readonly<
  Record<string, z.ZodType>
> = {
  ConflictSnapshot: ConflictSnapshotSchema,
};

/**
 * Who resolves a collision on this write.
 *
 * A closed enum rather than a free string, so a caller asking for a mode this
 * server does not implement is refused. Dropping it instead would answer 409
 * to a request that asked for a resolution, which reads as "no conflict was
 * resolvable" rather than "nobody read your parameter".
 */
const ConflictModeSchema = z
  .enum(["auto", "manual", "callback"])
  .openapi("ConflictMode");

/**
 * The 200 for an update, widened by what the server did if it resolved a
 * collision. Absent on every write that did not, which is nearly all of them.
 */
const UpdatedItemSchema = ItemWithMetadataSchema.extend({
  conflict_resolution: z
    .object({
      fields: z.array(z.string()),
      strategy: z.record(z.string(), MergeStrategyEnum),
      conflicted_copy_id: z.string().optional(),
    })
    .optional()
    .describe(
      "What Marfa did to resolve a conflict. Present only when `conflict=auto` resolved one. `conflicted_copy_id` is the ID of the sibling item that holds the losing values, which has a `derived-from` edge to this item.",
    ),
});

const IdParam = z.object({
  id: z.string().describe("The ID of the item."),
});

/**
 * Upper bound on neighbors hydrated by `GET /items/:id?include=neighbors`.
 * Outbound + inbound edges are each already capped per type
 * (`HYDRATE_PER_TYPE_CAP`), so this only bites a pathological cross-product of
 * many edge types; overflow neighbors stay reachable through the per-type
 * edge/backref endpoints. Matches the bulk-get id cap so one detail read can
 * never exceed one batched hydration.
 */
const MAX_NEIGHBOR_IDS = 100;

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createItemRoute = createRoute({
  operationId: "createItem",
  method: "post",
  path: "/",
  tags: ["Items"],
  summary: "Create an item",
  description:
    "Creates an item. If `source_id` matches an existing item under the same source, updates that item instead. Repeating an `id` you already created returns the stored item with `acknowledged: true` and writes nothing.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            type: z
              .string()
              .describe("The item's type identifier, such as `core.note`."),
            properties: WrittenPropertiesSchema.optional().describe(
              "The item's properties, checked against the type's schema. If the instance's strict mode names the type, an undeclared property is refused as `invalid_properties` with `details.code` `unknown_property`.",
            ),
            id: z
              .string()
              .optional()
              .describe(
                "A UUIDv7 you choose for the item. Leave it out and Marfa creates one. Sending an ID you already created returns the stored item, marked `acknowledged`.",
              ),
            state: z
              .string()
              .optional()
              .describe(
                "The item's first lifecycle state, one the type's lifecycle can reach. Defaults to `active`.",
              ),
            occurred_at: z
              .string()
              .optional()
              .describe(
                "When the item occurred, as an ISO 8601 time. Defaults to the creation time.",
              ),
            source: z
              .string()
              .optional()
              .describe(
                "The source to key and stamp the item with. Defaults to your credential's own; it can also name one of your key's `sources`. An item's source never changes.",
              ),
            source_id: z
              .string()
              .optional()
              .describe(
                "The item's identifier at its source, such as a vendor's row ID. With `source`, it is the item's natural key: creating with a key that exists updates that item.",
              ),
            version: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe(
                "The version you read. Used only when `source_id` matches a live item: the update then applies only if the item is still at this version. Ignored otherwise.",
              ),
            tier: TierEnum.optional().describe(
              "The item's tier. Defaults to your key's `default_tier`, else `library`. If `source_id` matches an existing item, leaving it out keeps that item's tier.",
            ),
            capture_latitude: z
              .number()
              .optional()
              .describe("The latitude where the item was captured."),
            capture_longitude: z
              .number()
              .optional()
              .describe("The longitude where the item was captured."),
            tags: z
              .array(TagSchema)
              .optional()
              .describe(
                "Tags to put on the item: at most 100, each up to 128 characters.",
              ),
            // Atomic item + edges write: for each edge type, the listed
            // item ids become targets with the new item as source. Rejects
            // all-or-nothing if any constraint violation surfaces.
            edges: z
              .record(z.string(), z.array(z.string()))
              .optional()
              .describe(
                "Edges to create with the item, as edge type to a list of target item IDs. The new item is the source. Marfa creates the item and all its edges, or none.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ItemWithMetadataSchema },
      },
      description:
        "Returns the existing item and its metadata:\n- `source_id` matched a live item: Marfa updated it.\n- `source_id` matched a trashed item: Marfa wrote nothing and set `acknowledged: true`.\n- `id` repeated a create you made: Marfa wrote nothing and set `acknowledged: true`, in any state.",
    },
    201: {
      content: {
        "application/json": { schema: ItemWithMetadataSchema },
      },
      description: "Returns the new item and its metadata.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "unknown_type",
            "invalid_id",
            "invalid_properties",
            "edge_constraint_violation",
            "edge_cycle",
          ]),
        },
      },
      description:
        "- `validation_error`: a field is invalid, such as a malformed `occurred_at` or a `state` the type can't start in.\n- `missing_required_field`: `type` is missing.\n- `unknown_type`: `type` isn't registered.\n- `invalid_id`: `id` or an edge target is not a valid ID.\n- `invalid_properties`: the properties don't fit the type.\n- `edge_constraint_violation`, `edge_cycle`: an edge breaks its type's rules.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "forbidden",
            "type_not_permitted",
            "edge_permission_denied",
          ]),
        },
      },
      description:
        "- `forbidden`: `source` is not your credential's own or one of your key's `sources` (`details.source` names it), or the source allow-list excludes it.\n- `type_not_permitted`: you don't have write on the item's type, or on the type `source_id` resolves to.\n- `edge_permission_denied`: you don't have write on an edge's type.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "item_not_found",
            "edge_type_not_found",
          ]),
        },
      },
      description:
        "- `edge_type_not_found`: an edge names an edge type that doesn't exist.\n- `item_not_found`: an edge's target doesn't exist, or its type is one you can't read.",
    },
    409: {
      content: {
        "application/json": {
          schema: z.union([
            ConflictResponseSchema,
            AncestorUnavailableSchema,
            makeErrorResponseSchema([
              "conflict",
              "id_reused",
              "link_taken",
              "type_mismatch",
            ]),
          ]),
        },
      },
      description:
        "- `id_reused`: `id` names an item of another type.\n- `conflict`: `id` names an item you can't read.\n- `link_taken`: another item of the type holds this link. `details.existing_id` names it.\n- `type_mismatch`: `source_id` matches an item of another type.\n- `version_conflict`, `ancestor_unavailable`: `version` is stale.",
    },
  },
});

/**
 * The query keys that decide which items a listing answers, apart from how
 * it orders and pages them. The stats door takes the same keys, so a count
 * is asked with exactly the filters of the listing it sizes; search takes
 * the ones that mean the same there.
 */
export const listingNarrowingKeys = {
  type: z
    .string()
    .optional()
    .describe(
      "Only return items of this type or a subtype. A wildcard such as `core.*` matches every type under that prefix.",
    ),
  state: z
    .string()
    .optional()
    .describe(
      "Only return items in this lifecycle state. Without it, you get `active` items. Send `any` to get every state.",
    ),
  source: z
    .string()
    .optional()
    .describe("Only return items stamped with this source."),
  tier: z
    .enum(["library", "feed", "all"])
    .optional()
    .describe(
      "Only return items in this tier. Omit it or send `all` for both tiers.",
    ),
  tags: z
    .string()
    .optional()
    .describe(
      "Comma-separated tags. Only return items that carry all of them.",
    ),
  filter: z
    .string()
    .optional()
    .describe(
      "A filter expression. A term naming an edge type, `edge[<type>]` or `backref[<type>]`, matches by relationship and needs read on that edge type. `edge[<type>]=<id>` also works as a query parameter of its own.",
    ),
};

const listingBoundKeys = {
  occurred_after: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Only return items whose own time (`occurred_at`, else `created_at`) is after this time. For the modification time, use `updated_after`.",
    ),
  occurred_before: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Only return items whose own time (`occurred_at`, else `created_at`) is before this time.",
    ),
  updated_after: z
    .string()
    // Non-empty, because the ordering switches on this parameter
    // rather than on `sort`: an empty value would order by
    // `(updated_at, id)` ascending and bound nothing, so a client
    // building the query before it holds a cursor would walk the
    // whole corpus under the shape of a narrow catch-up.
    .min(1)
    .optional()
    .describe(
      "Only return items changed at or after this time. Send the latest `updated_at` you hold, and deduplicate by ID, as items can share an instant. Ordered by `updated_at`, then ID, ascending, so leave out `sort` and `direction`. Purges aren't reported.",
    ),
  updated_before: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Only return items changed before this time. It doesn't change the ordering, so it works with any `sort`.",
    ),
};

type ListingFilterQuery = Partial<
  Record<
    keyof typeof listingNarrowingKeys | keyof typeof listingBoundKeys,
    string
  >
>;

const getItemStatsRoute = createRoute({
  operationId: "getItemStats",
  method: "get",
  path: "/stats",
  tags: ["Items"],
  summary: "Get item counts",
  description:
    "Returns counts of the items you can read, grouped by state or by type. It takes the filters `GET /items` takes, but without `state` it counts every state, not only active items.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    query: z.object({
      by: z
        .enum(["state", "type"])
        .optional()
        .describe("Grouping axis. Defaults to `state`."),
      ...listingNarrowingKeys,
      state: z
        .string()
        .optional()
        .describe(
          "Only count items in this lifecycle state. Without it, every state is counted, as with `any`.",
        ),
      ...listingBoundKeys,
      include: z
        .enum([SYSTEM_INCLUDE_TOKEN])
        .optional()
        .describe(
          "`system` counts `system.*` items too, which are left out by default. A `type` filter in the `system.` namespace opts in on its own.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.record(z.string(), z.number()),
        },
      },
      description:
        "Returns an object that maps each state, or each type, to its count.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error", "unknown_type"]),
        },
      },
      description:
        "- `validation_error`: a query parameter is unknown or invalid, or `by` is not `state` or `type`.\n- `unknown_type`: `type` is a concrete type that nothing registers.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "edge_permission_denied",
            "type_not_permitted",
          ]),
        },
      },
      description:
        "- `type_not_permitted`: your credential reaches no type, or `type` names a type you can't read with none readable under it.\n- `edge_permission_denied`: the filter has an `edge` or `backref` term for an edge type you can't read.",
    },
  },
});
takesQueryKeysLike(getItemStatsRoute, EDGE_SHORTHAND_KEYS);

const listItemsRoute = createRoute({
  operationId: "listItems",
  method: "get",
  path: "/",
  tags: ["Items"],
  summary: "List items",
  description:
    "Returns a page of the items you can read that match the filters. System items are left out unless you ask for them with `include=system`. Use `include` to add edges, metadata or extensions to each item.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    query: z.object({
      ...listingNarrowingKeys,
      sort: z
        .string()
        .regex(
          /^(created_at|updated_at|occurred_at|properties\.[a-z0-9_]+)$/,
          "sort must be created_at, updated_at, occurred_at, or properties.<field>",
        )
        .optional()
        .describe(
          "Field to sort by: `created_at`, `updated_at`, `occurred_at` or `properties.<field>`, such as `properties.due_at`. Properties sort by stored value, so an enum property sorts alphabetically, not by meaning.",
        ),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
      ...listingBoundKeys,
      limit: pageLimit({ max: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }),
      cursor: pageCursor(),
      include: z
        .string()
        .optional()
        .describe(
          "Comma-separated extras. `edges`, `metadata` and `extensions` add that data to each item. `system` also returns `system.*` items, which are left out by default; a `system.` type filter does the same.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(
            z
              .union([ItemSchema, ItemReadWithMetadataSchema])
              .describe(
                "An `Item`, or, when `include` names `metadata`, an `ItemReadWithMetadata`; every row of one page is the same shape.",
              )
              // `oneOf`, not the `anyOf` a union gets by default: the two
              // shapes share no required key, so a row is exactly one of
              // them, and a generator reads `anyOf` as one object holding
              // both shapes' required keys, which no row has.
              .openapi("ItemListRow", {}, { unionPreferredType: "oneOf" }),
            "ItemPage",
            { page: "A page of items.", data: "The items on this page." },
          ),
        },
      },
      description:
        "Returns a page of items. With `include=metadata`, each entry holds the item and its metadata.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "unknown_type",
          ]),
        },
      },
      description:
        "- `validation_error`: a query parameter is unknown or invalid, `updated_after` comes with a different `sort` or `direction`, `cursor` came from another ordering or listing, or `X-Marfa-Read-View` comes without `include=metadata`.\n- `unknown_type`: `type` is a concrete type that nothing registers.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "edge_permission_denied",
            "type_not_permitted",
          ]),
        },
      },
      description:
        "- `type_not_permitted`: your credential reaches no type, or `type` names a type you can't read with none readable under it.\n- `edge_permission_denied`: the filter has an `edge` or `backref` term for an edge type you can't read.",
    },
  },
});
takesQueryKeysLike(listItemsRoute, EDGE_SHORTHAND_KEYS);

const getItemRoute = createRoute({
  operationId: "getItem",
  method: "get",
  path: "/{id}",
  tags: ["Items"],
  summary: "Get an item",
  description:
    "Returns an item with its metadata and outbound edges. Use `include` to add its inbound edges, the items at the other end of its edges, or its version history in the same call.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: IdParam,
    query: z.object({
      include: z
        .string()
        .optional()
        .describe(
          "Comma-separated extras: `backrefs` adds inbound edges, `neighbors` adds the items at the other end of the edges returned, and `versions` adds the first page of version snapshots you can read, oldest first.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ItemDetailSchema },
      },
      description:
        "Returns the item and its metadata, plus any extras you asked for. If `neighbors` hits its cap of 100 items, `neighbors_truncated` is `true`; `neighbors_omitted` counts neighbors you can't read.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "- `invalid_id`: the ID is not a valid item ID.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND_ON_READ,
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
      description: READ_REFUSED,
    },
  },
});

const updateItemRoute = createRoute({
  operationId: "updateItem",
  method: "patch",
  path: "/{id}",
  tags: ["Items"],
  summary: "Update an item",
  description:
    "Updates an item's properties, tier, own time, natural key or edges. Send the `version` you read: if the item changed since, Marfa merges your changes where nothing collides. To change its type, send `type` with `retype: true`.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: IdParam,
    query: z.object({
      conflict: ConflictModeSchema.optional().describe(
        "Who resolves a version conflict. `auto` has Marfa resolve it by the type's merge policy. `manual` and `callback` return the conflict for you to resolve. Defaults to `manual`.",
      ),
    }),
    body: {
      content: {
        "application/json": {
          /** Strict, so a key this door does not declare is refused rather
           *  than dropped. A dropped key is a request half-performed and
           *  answered `200`, which is what a caller reads as the whole of
           *  it having landed; the listing grammar refuses an undeclared
           *  query key for the same reason. `.strict()` does not recurse,
           *  and `properties` is deliberately open: its keys are the
           *  type's, not this door's. */
          schema: z.strictObject({
            properties: WrittenPropertiesSchema.optional().describe(
              "The properties to write. They lay over the item's properties, or become all of them when `properties_mode` is `replace`. Strict mode refuses an undeclared property, as in `POST /items`.",
            ),
            /** The item's own type, and only that. This route does not
             *  re-type the row it addresses, so the field exists to be
             *  checked rather than applied: equal to the item's type it is
             *  accepted and ignored, anything else is refused.
             *
             *  Present in the schema at all because callers send it
             *  constantly. The fleet builds one input object and hands it
             *  to either the create or the update call, so a type rides on
             *  nearly every reactive update. Stripped in silence, a re-type
             *  could be attempted, answered with a 200, and do nothing. */
            type: z
              .string()
              .optional()
              .describe(
                "The item's type. It must match the item's current type unless `retype` is `true`.",
              ),
            /** Whether `properties` lays over the item's or becomes them.
             *  Defaults to `merge`, so a write that names no mode can never
             *  remove a property it did not mention. A `replace` says the
             *  set sent IS the caller's properties, so a field it leaves out
             *  is cleared: at the current version outright, at a stale one
             *  where nobody changed it since, and colliding where somebody
             *  did. The result is validated either way, so a replace
             *  dropping a required field is refused rather than written. */
            properties_mode: z
              .enum(["merge", "replace"])
              .optional()
              .describe(
                "How `properties` applies. `merge` (the default) lays them over the item's properties. `replace` takes them as the whole set, so a property you leave out is cleared.",
              ),
            /** Move the item to the `type` named above.
             *
             *  An explicit opt-in rather than an inference from `type`
             *  differing, because the fleet sends a type on nearly every
             *  reactive update: a route that re-typed whenever the two
             *  disagreed would move a corpus on somebody's ordinary sync
             *  bug. Without this the disagreement is refused, which stays
             *  the default and is what a caller who has not thought about
             *  it gets.
             *
             *  Exists for one job: bringing items written under one shape
             *  onto the shape a person's mapping now names. Otherwise a
             *  mapping applies only to what arrives next and everything
             *  already there is stranded under the old type. */
            retype: z
              .boolean()
              .optional()
              .describe(
                "`true` moves the item to `type`. You need write on both types, and the properties the item ends up with must fit the new type. Naming the item's current type changes nothing.",
              ),
            version: z
              .number()
              .int()
              .min(0)
              .describe(
                "The version of the item you read, which this update is based on.",
              ),
            /** Toggle the tier (`library` ↔ `feed`). Compared against the
             *  version named like a property, so a stale flip collides with
             *  one made since. */
            tier: TierEnum.optional().describe(
              "Moves the item between `library` and `feed`.",
            ),
            /** Override the item's own time (ISO 8601). Compared against
             *  the version named like `tier`. */
            occurred_at: z
              .string()
              .optional()
              .describe("When the item occurred, as an ISO 8601 time."),
            /** Repoint at a new natural-key identifier under the item's
             *  own `source`, which this door never moves. The
             *  `(source, source_id)` tuple is
             *  unique — the server returns 409 `source_id_conflict`
             *  if another item already holds the target value. Idempotent
             *  no-op when the value matches the row's current source_id.
             *  Repointing the natural key is how renames preserve item
             *  continuity without creating a new row. */
            source_id: z
              .string()
              .optional()
              .describe(
                "The item's new `source_id`. Marfa moves its natural key under the item's own `source`, which never changes.",
              ),
            // Replace-all-for-specified-types semantics: any edge_type
            // listed wipes existing outbound edges of that type from
            // this item, then creates new edges to each listed target.
            // Empty array for an edge_type deletes all of that type.
            // Unmentioned edge types are untouched.
            edges: z
              .record(z.string(), z.array(z.string()))
              .optional()
              .describe(
                "Edge types to replace, each mapped to the item IDs it should now point to. An empty list removes every edge of that type. Types you don't name are untouched.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: UpdatedItemSchema },
      },
      description:
        "Returns the updated item and its metadata. If `conflict=auto` resolved a collision, `conflict_resolution` lists the fields and strategies. A `keep_both_copies` field keeps the current value and puts yours on a new sibling tagged `conflicted-copy`, with a `derived-from` edge to this item.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_id",
            "invalid_properties",
            "unknown_type",
            "edge_constraint_violation",
            "edge_cycle",
          ]),
        },
      },
      description:
        "- `missing_required_field`: `version` is missing.\n- `validation_error`: the body is malformed, has an undeclared field, or changes nothing.\n- `invalid_id`: the ID or an edge target is not a valid ID.\n- `invalid_properties`: the resulting properties don't fit the type.\n- `unknown_type`: `type` isn't registered.\n- `edge_constraint_violation`, `edge_cycle`: an edge breaks its type's rules.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "forbidden",
            "edge_permission_denied",
            "type_not_permitted",
          ]),
        },
      },
      description:
        "- `type_not_permitted`: you can read the item's type but don't have write on it (or on the type `retype` enters), or your credential reaches no type.\n- `edge_permission_denied`: you don't have write on an edge type in `edges`.\n- `forbidden`: you changed `source_id` on an item whose source your key doesn't write under or claim. `details.source` names it.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "item_not_found",
            "edge_type_not_found",
            "edge_not_found",
          ]),
        },
      },
      description:
        "- `item_not_found`: no item has this ID, its type is one you can't read, or an edge target doesn't exist or has a type you can't read. For an item in the trash, `details.trashed` is `true` if you can read its type.\n- `edge_type_not_found`: an edge names an edge type that doesn't exist.\n- `edge_not_found`: a repeat under the `Idempotency-Key` would show an edge you can no longer read.",
    },
    409: {
      content: {
        "application/json": {
          schema: z.union([
            ConflictResponseSchema,
            StaleVersionSchema,
            AncestorUnavailableSchema,
            // No bare `version_conflict` here. Every one this route answers
            // is one of the three envelopes above, and declaring a fourth
            // shape nothing produces is a client's excuse for handling it.
            makeErrorResponseSchema([
              "link_taken",
              "source_id_conflict",
              "type_mismatch",
            ]),
          ]),
        },
      },
      description:
        "- `version_conflict`: `version` is stale and a change collides, or only edges change. `current` is the item now.\n- `ancestor_unavailable`: Marfa holds no snapshot of `version` that you can read.\n- `source_id_conflict`: another item under the source holds this `source_id`.\n- `link_taken`: another item of the type holds this link.\n- `type_mismatch`: `type` differs and `retype` isn't `true`.",
    },
  },
});

const deleteItemRoute = createRoute({
  operationId: "deleteItem",
  method: "delete",
  path: "/{id}",
  tags: ["Items"],
  summary: "Trash an item",
  description:
    "Moves the item, and every item a cascading edge such as `parent-of` reaches, to the trash. You can restore them until the retention window ends. Marfa then purges them.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: IdParam,
    query: z.object({
      version: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "The version you read. If the item has changed since, nothing is trashed. Leave it out to trash the item as it is.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: OkResponseSchema },
      },
      description:
        'Returns `{ "ok": true }`. An item that a cascading edge took into the trash has `trashed_by_cascade`, and `trashed_with` names this item if you can read its type.',
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "edge_constraint_violation",
            "invalid_id",
            "validation_error",
          ]),
        },
      },
      description:
        "- `invalid_id`: the ID is not a valid item ID.\n- `edge_constraint_violation`: an edge type on the item has `cascade_on_delete: block`, and such an edge exists.\n- `validation_error`: the item is a live `system.connection` (revoke its grant with `DELETE /auth/grants/{id}` first), or `version` is not a positive whole number.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
      description: WRITE_REFUSED,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found", "edge_not_found"]),
        },
      },
      description: `${ITEM_NOT_FOUND_ON_WRITE}\n- \`edge_not_found\`: a repeat under the \`Idempotency-Key\` would show an edge you can no longer read.`,
    },
    409: {
      content: {
        "application/json": { schema: StaleVersionSchema },
      },
      description: `- \`version_conflict\`: \`version\` is stale. \`current\` is the item now, and nothing is trashed.\n${IDEMPOTENCY_IN_FLIGHT}`,
    },
  },
});

/** The type gate every metadata and tag door runs on the item's type. */
function metadataTypeRefusal(level: "read" | "write") {
  return {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["type_not_permitted"]),
      },
    },
    description: level === "read" ? READ_REFUSED : WRITE_REFUSED,
  };
}

const getMetadataRoute = createRoute({
  operationId: "getItemMetadata",
  method: "get",
  path: "/{id}/metadata",
  tags: ["Metadata"],
  summary: "Get item metadata",
  description:
    "Returns an item's metadata: its tags and the extension namespaces you can read. To read metadata for many items, use `include=metadata` on `GET /items`.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: IdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: MetadataResponseSchema,
        },
      },
      description: "Returns the item's metadata.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "- `invalid_id`: the ID is not a valid item ID.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: metadataTypeRefusal("read"),
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND_ON_READ,
    },
  },
});

const putMetadataRoute = createRoute({
  operationId: "replaceItemMetadata",
  method: "put",
  path: "/{id}/metadata",
  tags: ["Metadata"],
  summary: "Replace an item's tags",
  description:
    "Replaces the item's tags with the ones you send and returns its metadata. An empty list clears all tags.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tags: z
              .array(TagSchema)
              .optional()
              .default([])
              .describe(
                "The tags the item will have: at most 100, each up to 128 characters. An empty list clears them.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: MetadataResponseSchema,
        },
      },
      description: "Returns the item's metadata with the new tags.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_id",
          ]),
        },
      },
      description:
        "- `validation_error`: `tags` is not a list of valid tags, or has more than 100.\n- `invalid_id`: the ID is not a valid item ID.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: metadataTypeRefusal("write"),
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND_ON_WRITE,
    },
  },
});

const patchMetadataRoute = createRoute({
  operationId: "updateItemMetadata",
  method: "patch",
  path: "/{id}/metadata",
  tags: ["Metadata"],
  summary: "Merge tags into an item",
  description:
    "Merges the tags you send into the item's tags as a set union, and returns its metadata. Existing tags stay. To replace them, use `PUT /items/{id}/metadata`.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tags: z
              .array(TagSchema)
              .optional()
              .describe(
                "Tags to add: each up to 128 characters. The item can hold at most 100.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: MetadataResponseSchema,
        },
      },
      description: "Returns the item's metadata with the merged tags.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_id",
          ]),
        },
      },
      description:
        "- `validation_error`: `tags` is not a list of valid tags, or the item would hold more than 100.\n- `invalid_id`: the ID is not a valid item ID.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: metadataTypeRefusal("write"),
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND_ON_WRITE,
    },
  },
});

const addTagsRoute = createRoute({
  operationId: "addItemTags",
  method: "post",
  path: "/{id}/tags",
  tags: ["Metadata"],
  summary: "Add tags to an item",
  description:
    "Adds tags to the item and returns its metadata. A tag the item already has isn't added twice.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tags: z
              .array(TagSchema)
              .min(1, "tags must be a non-empty array of strings")
              .describe(
                "The tags to add: at least one, each up to 128 characters. The item can hold at most 100.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: MetadataResponseSchema,
        },
      },
      description: "Returns the item's metadata with the tags added.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_id",
          ]),
        },
      },
      description:
        "- `validation_error`: `tags` is empty or not a list of valid tags, or the item would hold more than 100.\n- `missing_required_field`: `tags` is missing.\n- `invalid_id`: the ID is not a valid item ID.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: metadataTypeRefusal("write"),
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND_ON_WRITE,
    },
  },
});

const removeTagRoute = createRoute({
  operationId: "removeItemTag",
  method: "delete",
  path: "/{id}/tags/{tag}",
  tags: ["Metadata"],
  summary: "Remove a tag from an item",
  description:
    "Removes one tag from the item and returns its metadata. Removing a tag the item doesn't have changes nothing and succeeds.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: z.object({
      id: z.string().describe("The ID of the item."),
      tag: z.string().describe("The tag to remove, URL-encoded."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: MetadataResponseSchema,
        },
      },
      description: "Returns the item's metadata without the tag.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "- `invalid_id`: the ID is not a valid item ID.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: metadataTypeRefusal("write"),
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND_ON_WRITE,
    },
  },
});

const purgeItemRoute = createRoute({
  operationId: "purgeItem",
  method: "post",
  path: "/{id}/purge",
  tags: ["Items"],
  summary: "Purge an item",
  description:
    "Permanently deletes a trashed item with its edges, metadata and extensions. Requires `items.purge` and write on the item's type. Marfa keeps a tombstone of the item's link and natural key, which `POST /items/lookup` reads.",
  security: [{ bearerAuth: [] }],
  middleware: standingPermission("items.purge"),
  request: {
    params: IdParam,
    query: z.object({
      version: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "The version you read. If the item has changed since, nothing is deleted. Trashing doesn't change the version, so send the one you read before the trash.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: OkResponseSchema },
      },
      description:
        'Returns `{ "ok": true }`. Marfa announces each edge it deletes as `edge.deleted`, with `purged_with` naming this item.',
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "invalid_id",
            "invalid_transition",
            "validation_error",
          ]),
        },
      },
      description:
        "- `invalid_id`: the ID is not a valid item ID.\n- `invalid_transition`: the item is not in the trash.\n- `validation_error`: the item is a live `system.connection` (revoke its grant with `DELETE /auth/grants/{id}` first), or `version` is not a positive whole number.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden", "type_not_permitted"]),
        },
      },
      description:
        "- `forbidden`: you don't have `items.purge`, or the item is in a reserved namespace and is not in the trash.\n- `type_not_permitted`: you can read the item's type but don't have write on it, or your credential reaches no type.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description:
        "- `item_not_found`: no item has this ID, including one already purged, or its type is one you can't read.",
    },
    409: {
      content: {
        "application/json": { schema: StaleVersionSchema },
      },
      description: `- \`version_conflict\`: \`version\` is stale. \`current\` is the item now, and nothing is purged.\n${IDEMPOTENCY_IN_FLIGHT}`,
    },
  },
});

/** One answer for both re-sent creates, so what it discloses (extension
 *  metadata, a cascade's mark) is decided in one place. */
async function acknowledgedItemBody(
  storage: Storage,
  apiKey: ApiKey,
  existing: Item,
): Promise<{ item: Item; metadata: Metadata; acknowledged: true }> {
  const metadata = await storage.metadata.get(existing.id);
  const [item = existing] = await withCascadeMarks(storage, apiKey, [existing]);
  return {
    item,
    metadata: readableMetadata(metadata, apiKey),
    acknowledged: true,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function itemRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // POST /items — create
  router.openapi(createItemRoute, async (c) => {
    const body = c.req.valid("json");

    const type = body.type;
    if (!type) {
      throw new MarfaError(
        ErrorCode.MISSING_REQUIRED_FIELD,
        "type is required",
        {
          field: "type",
        },
      );
    }
    if (!isValidTypeIdentifier(type)) {
      throw malformedTypeIdentifier("type", `Invalid type identifier: ${type}`);
    }

    const properties = body.properties ?? {};
    if (typeof properties !== "object") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "properties must be an object",
      );
    }

    if (body.id && !isValidId(body.id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }
    if (body.occurred_at && !isValidTimestamp(body.occurred_at)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid occurred_at", {
        field: "occurred_at",
      });
    }
    const key = requireAuth(c);
    // Resolving the row, every rule the write must pass, the write itself
    // and its events happen in one transaction, against the row and type as
    // they stand there. A natural key or a minted id that resolves a row is
    // decided there too, so two sends of one key land on one row. What the
    // answer reads is read inside it as well, so a write that committed is
    // never answered with a failure.
    const { result, hydrated } = await runAuditedTransaction(
      storage,
      async () => {
        const result = await writeItem(
          storage,
          { kind: "credential", key },
          {
            op: "put",
            door: "item",
            type,
            properties: body.properties,
            ...(body.id !== undefined && { id: body.id }),
            ...(body.state !== undefined && { state: body.state as ItemState }),
            ...(body.tier !== undefined && { tier: body.tier }),
            ...(body.occurred_at !== undefined && {
              occurred_at: body.occurred_at,
            }),
            ...(body.source !== undefined && { source: body.source }),
            ...(body.source_id !== undefined && { source_id: body.source_id }),
            ...(body.version !== undefined && { version: body.version }),
            ...(body.capture_latitude !== undefined && {
              capture_latitude: body.capture_latitude,
            }),
            ...(body.capture_longitude !== undefined && {
              capture_longitude: body.capture_longitude,
            }),
            ...(body.tags !== undefined && { tags: body.tags }),
            ...(body.edges !== undefined && { edges: body.edges }),
            blob_proof: requestBlobProof(c, storage),
          },
        );
        return {
          result,
          hydrated:
            result.outcome === "updated"
              ? await hydrateEdgesForItem(storage, key, result.item.id)
              : undefined,
        };
      },
      ({ result }) =>
        result.outcome === "updated"
          ? {
              client_ip: c.get("clientIp") ?? null,
              key_id: key.id,
              action: "item.update",
              resource_type: "item",
              resource_id: result.item.id,
              details: {
                type: result.item.type,
                idempotent: true,
                source: result.item.source,
                source_id: body.source_id,
              },
            }
          : result.outcome === "created"
            ? {
                client_ip: c.get("clientIp") ?? null,
                key_id: key.id,
                action: "item.create",
                resource_type: "item",
                resource_id: result.item.id,
                details: { type: result.item.type },
              }
            : null,
    );

    switch (result.outcome) {
      case "unchanged":
        // A repeat of a create the server performed, or a re-sync of a row
        // the person has since deleted: nothing written, nothing announced.
        return c.json(
          await acknowledgedItemBody(storage, key, result.item),
          200,
        );
      case "conflict":
        // Returned rather than thrown, so the error handler that sets this
        // never runs.
        c.header("X-Error-Code", result.conflict.error.code);
        return c.json(result.conflict, 409);
      case "updated": {
        const { item: updatedItem, metadata: updatedMetadata } = result;

        return c.json(
          {
            item: { ...updatedItem, edges: hydrated ?? {} },
            metadata: readableMetadata(updatedMetadata, key),
          },
          200,
        );
      }
      case "stale":
        throw new Error("An upsert always writes the row it lands on");
      case "created":
        break;
    }
    const { item, metadata } = result;
    const createdEdges = result.edges?.created ?? [];

    // Sorted to the listing's read order (created_at DESC, id DESC) before
    // grouping, because the block is cut at the cap and its cursor is read
    // by that listing: body order fed in raw would carry the oldest fifty
    // of a large batch with a cursor that re-fetches them and never
    // reaches the newest.
    const orderedEdges = [...createdEdges].sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
    );
    const itemWithEdges = {
      ...item,
      edges: groupAndCap(
        orderedEdges,
        HYDRATE_PER_TYPE_CAP,
        ITEM_EDGES_CURSOR_KEY,
      ),
    };

    return c.json(
      {
        item: itemWithEdges,
        metadata: readableMetadata(metadata, key),
      },
      201,
    );
  });

  /**
   * What a listing's query narrows to, apart from ordering and paging. The
   * listing and the stats door both read their filters through here, so a
   * count is taken over exactly the rows the listing walks.
   */
  async function listingFilters(
    c: Context<AppEnv>,
    query: ListingFilterQuery,
    includeSet: ReadonlySet<string>,
  ): Promise<ItemFilters> {
    const type = query.type;
    // Grammar, the global wildcard and an unknown concrete type, decided once
    // for every list surface; the reasoning is at `assertTypeFilter`.
    assertTypeFilter(c, type);

    // `any` is a widening, not a state, so it never reaches the column
    // comparison. Shared with `GET /export`, which reads the same filter.
    const { state, all_states: allStates } = resolveStateFilter(query.state);

    const tagsParam = query.tags;
    const tags = tagsParam
      ? tagsParam.split(",").map((t) => t.trim())
      : undefined;

    // ?edge[X]=Y and ?backref[X]=Y shorthands are AND-composed with any existing filter= param.
    const rawQuery = new URL(c.req.raw.url).searchParams;
    const edgeClauses: string[] = [];
    const shorthandRe = EDGE_SHORTHAND_KEY;
    for (const [key, val] of rawQuery.entries()) {
      if (!shorthandRe.test(key)) continue;
      // A shorthand with nothing after the `=`, skipped, would return an
      // unfiltered page at 200: the failure the unknown-parameter refusal
      // exists to remove, reached through the exemption that keeps the
      // shorthand working. The exemption matches
      // on the key alone, because the type is part of the key; the value
      // has to be checked where it is read. `updated_after` carries
      // `.min(1)` for the same reason on this same door.
      if (val === "") {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `The "${key}" filter was sent with no value. An edge shorthand names the item on the other end of the edge, so an empty one narrows nothing and would return the whole listing.`,
          { empty_parameters: [key] },
        );
      }
      // The filter grammar reads `\"` as a quote and takes every other
      // backslash literally, so a backslash cannot be quoted: one before the
      // closing quote would swallow it, and the value would run on into the
      // next clause. An item id never carries one.
      if (val.includes("\\")) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `The "${key}" filter value contains a backslash. An edge shorthand names an item by its id, which never carries one.`,
          { invalid_parameters: [key] },
        );
      }
      edgeClauses.push(`${key} eq "${val.replace(/"/g, '\\"')}"`);
    }
    let filter = query.filter ?? undefined;
    if (edgeClauses.length > 0) {
      filter = filter
        ? `${filter} AND ${edgeClauses.join(" AND ")}`
        : edgeClauses.join(" AND ");
    }
    // The shorthand and the full form are one expression by this point,
    // so one pass over it covers both. `GET /search` makes the same call.
    assertFilterEdgeTermsReadable(c, filter);
    // Read tier from the raw query string — zod-openapi occasionally drops enum strings.
    const rawTier = c.req.query("tier");
    const tier: "library" | "feed" | undefined =
      rawTier === "library"
        ? "library"
        : rawTier === "feed"
          ? "feed"
          : undefined;
    // system.* is excluded by default and opted back in by the token or by a
    // type filter that names the namespace. Through the shared rule rather
    // than restated here, so no door matches rows its siblings hide.
    const excludeSystemTypes = excludesSystemTypes(includeSet, type);

    const callerKeyForRead = c.get("apiKey");
    const instanceConfigForRead = await readInstanceConfig(storage.settings);
    const enforcementForRead = resolveEnforcement(
      instanceConfigForRead,
      callerKeyForRead,
    );
    const typeFilterForList = getTypeFilter(c);
    return {
      type,
      state,
      all_states: allStates,
      source: query.source,
      // The lever is decided per row from the row's own type, not from the
      // `?type=` parameter: a bare listing, an ancestor wildcard, a tier
      // filter and a state filter all reach a covered row without naming it,
      // so keying off the request made a read-narrowing control optional.
      source_filter: enforcementForRead.source_filter,
      tier,
      exclude_system_types: excludeSystemTypes,
      tags,
      filter,
      readable_sources: typeFilterForList,
      allowed_types: typeFilterForList.allowed,
      excluded_types: typeFilterForList.excluded,
      occurred_after: query.occurred_after,
      occurred_before: query.occurred_before,
      updated_after: query.updated_after,
      updated_before: query.updated_before,
    };
  }

  router.openapi(getItemStatsRoute, async (c) => {
    requireAuth(c);
    const query = c.req.valid("query");
    const filters = await listingFilters(
      c,
      query,
      new Set(query.include === undefined ? [] : [query.include]),
    );
    // Every state when none is named, because the default answer is the
    // breakdown across them.
    if (query.state === undefined) filters.all_states = true;
    const stats = await storage.items.stats(filters, query.by);
    return c.json(stats, 200);
  });

  router.openapi(listItemsRoute, async (c) => {
    requireAuth(c);

    const query = c.req.valid("query");

    // `updated_after` implies `(updated_at, id)` ascending — it is the
    // only order a catch-up cursor can advance through. A request that
    // also names a different sort is contradicting itself, and honoring
    // one half silently is the same failure as ignoring a renamed
    // parameter: the caller gets a page that looks right and cannot be
    // resumed. Refuse instead of picking a winner.
    if (query.updated_after !== undefined) {
      const conflicting =
        (query.sort !== undefined && query.sort !== "updated_at") ||
        (query.direction !== undefined && query.direction !== "asc");
      if (conflicting) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          "updated_after orders by (updated_at, id) ascending and cannot be combined with a different sort or direction. Drop sort/direction, or drop updated_after.",
        );
      }
    }

    const includeSet = new Set(
      (query.include ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    const includeMetadata = includeSet.has("metadata");
    const includeEdges = includeSet.has("edges");
    const includeExtensions = includeSet.has("extensions");

    const result = await storage.items.list({
      ...(await listingFilters(c, query, includeSet)),
      // The query schema's regex already constrains this to a system column or
      // `properties.<field>`; the storage layer re-validates via parseSortField.
      sort: (query.sort as ItemSortField | undefined) ?? undefined,
      direction: query.direction ?? undefined,
      limit: query.limit,
      cursor: query.cursor,
    });
    const rows = await withCascadeMarks(storage, requireAuth(c), result.data);

    const ids = rows.map((item) => item.id);
    const apiKey = c.get("apiKey");
    const edgesMap = includeEdges
      ? await hydrateEdgesForItems(storage, requireAuth(c), ids)
      : null;
    const extensionsMap = includeExtensions
      ? await hydrateExtensionsForItems(storage, ids, apiKey)
      : null;
    const decorate = (item: (typeof rows)[number]) => {
      const withEdges = edgesMap
        ? { ...item, edges: edgesMap.get(item.id) ?? {} }
        : item;
      return extensionsMap
        ? { ...withEdges, extensions: extensionsMap.get(item.id) ?? {} }
        : withEdges;
    };

    if (includeMetadata) {
      const metadataList = await storage.metadata.getMany(ids);
      const metadataMap = new Map(metadataList.map((m) => [m.item_id, m]));
      const apiKey = c.get("apiKey");
      return c.json(
        {
          data: rows.map((item) => ({
            item: decorate(item),
            ...(c.get("readViewAuthority") && { listed: true }),
            metadata: readableMetadata(
              metadataMap.get(item.id) ?? {
                item_id: item.id,
                tags: [],
                extensions: {},
              },
              apiKey,
            ),
          })),
          next_cursor: result.next_cursor,
        },
        200,
      );
    }

    return c.json(
      {
        data: rows.map(decorate),
        next_cursor: result.next_cursor,
      },
      200,
    );
  });

  router.openapi(getItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const item = requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    // Non-optional, which `c.get("apiKey")` is not: the edge blocks
    // below are narrowed against it, and the gate above has already
    // refused a request carrying none.
    const callerKey = requireAuth(c);

    const includeSet = new Set(
      (c.req.query("include") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    const includeBackrefs = includeSet.has("backrefs");
    const includeNeighbors = includeSet.has("neighbors");
    const includeVersions = includeSet.has("versions");

    // The base shape — item (with outbound edges) + metadata — is unconditional;
    // it's what every existing caller already depends on. The three include
    // blocks are additive and default-off so the lean read stays lean.
    const [metadata, edges, backrefs, versions] = await Promise.all([
      storage.metadata.get(id),
      hydrateEdgesForItem(storage, callerKey, id),
      includeBackrefs
        ? hydrateBackrefsForItem(storage, callerKey, id)
        : Promise.resolve(null),
      includeVersions
        ? storage.versions.list(id, {
            reads: typeReader(c),
            limit: DEFAULT_PAGE_LIMIT,
          })
        : Promise.resolve(null),
    ]);

    let neighbors: { item: Item; metadata: Metadata }[] | undefined;
    // True when the 1-hop neighbor set was capped (more neighbors exist than
    // were hydrated). Distinct from the per-type edge block's `next_cursor`: several
    // edge types can each sit below their per-type cap while their COMBINED
    // neighbor set exceeds the bound, so this is the only signal that catches
    // that case. Consumers must treat every neighbor-derived view as
    // incomplete when this is set and page the per-type edge/backref endpoints.
    let neighborsTruncated = false;
    // How many neighbors the caller may not read, counted over the edge
    // blocks this response carries. A neighbor outside the caller's scope
    // is omitted, never leaked, and the count says so: without it a partial
    // neighborhood reads as a complete one, and a caller missing a type
    // scope renders an item with none of its relations as though it had
    // none.
    //
    // **It counts what the item map hid, and cannot count what the edge
    // map hid.** A relationship the credential may not read is not in
    // those blocks at all, so its far end never becomes a neighbor to
    // omit. Counting it would say how many relationships of a kind this
    // item has, which is the fact the edge gate withholds — the same
    // decision that makes `GET /edges` drop a row rather than refuse the
    // page. So an app missing an *edge* scope still sees a neighborhood
    // that looks complete, and the signal it has to read instead is the
    // block: a kind of relationship it holds no scope on has no block
    // here, whatever the item carries.
    let neighborsOmitted = 0;
    if (includeNeighbors) {
      // The 1-hop neighborhood: the far-end items of the edge blocks present
      // in this response — outbound targets always, inbound sources when
      // `backrefs` was also requested. Each neighbor is re-authorized through
      // the same per-type read gate the bulk-get path uses, so a
      // neighbor the caller cannot read is silently omitted, never leaked.
      const neighborIds = new Set<string>();
      for (const block of Object.values(edges)) {
        for (const e of block.data) neighborIds.add(e.target_id);
      }
      if (backrefs) {
        for (const block of Object.values(backrefs)) {
          for (const e of block.data) neighborIds.add(e.source_id);
        }
      }
      neighborIds.delete(id);

      // Bound the hydration so a pathological fan-out can't pin the worker. When
      // the bound bites, `neighbors_truncated` flags it — the per-block
      // `next_cursor` does NOT cover this, since the cap is on the combined set
      // across types, not any single type.
      neighborsTruncated = neighborIds.size > MAX_NEIGHBOR_IDS;
      const ids = [...neighborIds].slice(0, MAX_NEIGHBOR_IDS);
      if (ids.length === 0) {
        neighbors = [];
      } else {
        const found = await storage.items.getMany(ids);
        const visible: Item[] = [];
        // Kept apart because they mean different things to whoever reads the
        // log: a type the credential lacks is a scope to widen, an edge whose
        // far end is gone is a repair.
        const unreadableTypes = new Set<string>();
        let unresolved = 0;
        for (const nid of ids) {
          const neighbor = found.get(nid);
          if (!neighbor) {
            unresolved += 1;
            continue;
          }
          // The reserved namespace is not the caller's business and its
          // absence is not a permission answer, so it is not counted.
          if (neighbor.type.startsWith("system.")) continue;
          try {
            checkTypeAccess(apiKey, neighbor.type, "read");
          } catch {
            unreadableTypes.add(neighbor.type);
            neighborsOmitted += 1;
            continue;
          }
          visible.push(neighbor);
        }
        if (neighborsOmitted > 0 || unresolved > 0) {
          log("warn", "neighbors omitted from item read", {
            item_id: id,
            key_id: apiKey?.id,
            omitted_unreadable: neighborsOmitted,
            omitted_unresolved: unresolved,
            unreadable_types: [...unreadableTypes],
          });
        }
        const metaList = await storage.metadata.getMany(
          visible.map((n) => n.id),
        );
        const metaById = new Map(metaList.map((m) => [m.item_id, m]));
        neighbors = visible.map((n) => ({
          item: n,
          metadata: readableMetadata(
            metaById.get(n.id) ?? { item_id: n.id, tags: [], extensions: {} },
            apiKey,
          ),
        }));
      }
    }

    const readAuthority = c.get("readViewAuthority");
    return c.json(
      {
        item: { ...item, edges },
        ...(readAuthority && {
          listed: itemListed(readAuthority, item),
        }),
        metadata: readableMetadata(metadata, apiKey),
        ...(includeBackrefs && backrefs ? { backrefs } : {}),
        ...(neighbors !== undefined
          ? {
              neighbors: readAuthority
                ? neighbors.map((neighbor) => ({
                    ...neighbor,
                    listed: itemListed(readAuthority, neighbor.item),
                  }))
                : neighbors,
              neighbors_truncated: neighborsTruncated,
              neighbors_omitted: neighborsOmitted,
            }
          : {}),
        ...(includeVersions && versions ? { versions } : {}),
      },
      200,
    );
  });

  router.openapi(updateItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const body = c.req.valid("json");
    const { conflict: conflictMode } = c.req.valid("query");
    // The key the replay cache in front of this route claims, as this
    // credential's own, so a keep-both sibling can be given an id derived
    // from it: a re-executed write then produces one sibling rather than two.
    const idempotencyKey = credentialIdempotencyKey(c);
    const hasProperties =
      body.properties !== undefined && typeof body.properties === "object";
    const hasEdges =
      body.edges !== undefined &&
      typeof body.edges === "object" &&
      Object.keys(body.edges).length > 0;
    const hasTier = body.tier !== undefined;
    const hasOccurredAt = body.occurred_at !== undefined;
    const hasSourceId = body.source_id !== undefined;

    if (
      !hasProperties &&
      !hasEdges &&
      !hasTier &&
      !hasOccurredAt &&
      !hasSourceId &&
      body.retype !== true
    ) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "At least one of `properties`, `edges`, `tier`, `occurred_at`, `source_id`, or `retype` is required.",
      );
    }
    if (body.occurred_at !== undefined && !isValidTimestamp(body.occurred_at)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "occurred_at must be an ISO 8601 string",
        { field: "occurred_at" },
      );
    }
    if (body.retype === true && body.type === undefined) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "`retype` needs the `type` to move the item to",
      );
    }
    const key = requireAuth(c);
    // A `type` that matches the row is the ordinary case and passes; one
    // that disagrees is refused unless `retype` asks to move the row, which
    // needs write on the type entered as well as the one left. The edges the
    // answer carries are read inside the write's transaction.
    const { result, hydrated } = await runAuditedTransaction(
      storage,
      async () => {
        const result = await writeItem(
          storage,
          { kind: "credential", key },
          {
            op: "update",
            id,
            ...(body.type !== undefined && { declared_type: body.type }),
            ...(body.retype === true && { retype: true }),
            ...(hasProperties && { properties: body.properties }),
            ...(body.properties_mode !== undefined && {
              properties_mode: body.properties_mode,
            }),
            ...(hasTier && { tier: body.tier }),
            ...(hasOccurredAt && { occurred_at: body.occurred_at }),
            ...(hasSourceId && { source_id: body.source_id }),
            ...(hasEdges && { edges: body.edges }),
            version: body.version,
            ...(conflictMode !== undefined && { conflict_mode: conflictMode }),
            // The key that makes a re-executed write produce one keep-both
            // sibling rather than two.
            ...(idempotencyKey !== null && { idempotency_key: idempotencyKey }),
            blob_proof: requestBlobProof(c, storage),
          },
        );
        return {
          result,
          hydrated:
            result.outcome === "updated"
              ? await hydrateEdgesForItem(storage, key, id)
              : undefined,
        };
      },
      ({ result }) =>
        result.outcome === "updated"
          ? {
              client_ip: c.get("clientIp") ?? null,
              key_id: key.id,
              action: "item.update",
              resource_type: "item",
              resource_id: id,
            }
          : null,
    );

    if (result.outcome === "conflict" || result.outcome === "stale") {
      // Stamped here because this refusal is returned rather than thrown, so
      // the error handler that normally sets it never runs. Without it the
      // fresh answer and its idempotent replay describe one conflict
      // differently: the replay reads the code out of the recorded body and
      // sets the header, so a client that branches on it sees the header
      // appear only on the retry.
      c.header("X-Error-Code", result.conflict.error.code);
      return c.json(result.conflict, 409);
    }
    if (result.outcome !== "updated") {
      throw new Error(`PATCH /items/{id} answered ${result.outcome}`);
    }
    // Off the item before anything reads it. It describes what this write
    // did, not what the row is, and the row has no such column.
    const resolution = result.item.conflict_resolution;
    const resolvedItem = rowOf(result.item);

    return c.json(
      {
        item: { ...resolvedItem, edges: hydrated ?? {} },
        metadata: readableMetadata(result.metadata, key),
        // Present only where the server actually resolved a collision. It is
        // the only thing that names the sibling: no route reports what a
        // write created, so without this the row exists and nothing can
        // reach it.
        ...(resolution !== undefined && { conflict_resolution: resolution }),
      },
      200,
    );
  });

  router.openapi(deleteItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const key = requireAuth(c);
    const { version } = c.req.valid("query");
    const result = await runAuditedTransaction(
      storage,
      () =>
        writeItem(
          storage,
          { kind: "credential", key },
          { op: "delete", id, ...(version !== undefined && { version }) },
        ),
      (result) =>
        result.outcome !== "stale"
          ? {
              client_ip: c.get("clientIp") ?? null,
              key_id: key.id,
              action: "item.delete",
              resource_type: "item",
              resource_id: id,
            }
          : null,
    );
    if (result.outcome === "stale") {
      // Returned rather than thrown, so the error handler that sets this
      // never runs.
      c.header("X-Error-Code", result.conflict.error.code);
      return c.json(result.conflict, 409);
    }

    return c.json({ ok: true as const }, 200);
  });

  // Lifecycle (restore, transition) and versions live in sibling files.
  // Mounted at this point because the document emits paths in mount order,
  // and the generated document is checked in and held to the server.
  router.route("/", itemsLifecycleRoutes(storage));
  router.route("/", itemsVersionsRoutes(storage));

  // --- Metadata sub-routes ---

  // GET /items/:id/metadata
  router.openapi(getMetadataRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    const metadata = await storage.metadata.get(id);
    return c.json(
      { metadata: readableMetadata(metadata, c.get("apiKey")) },
      200,
    );
  });

  router.openapi(putMetadataRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const body = c.req.valid("json");
    const tags = body.tags;
    // The row is read, gated and written in one transaction, so a
    // change to it landing in between cannot slip past the gate.
    const { metadata } = await runAuditedTransaction(
      storage,
      async () => {
        const item = requireWritableRow(
          c,
          await storage.items.getIncludingTrashed(id),
          () =>
            new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
        );
        requireTypeAccess(c, item.type, "write");
        // The metadata layer reaches the same row the properties doors
        // guard, so it answers to the same row-level rule.

        if (tags.length > MAX_TAGS_PER_ITEM) {
          throw new MarfaError(
            ErrorCode.VALIDATION_ERROR,
            `Maximum ${String(MAX_TAGS_PER_ITEM)} tags per item`,
          );
        }

        const written = await storage.metadata.set(id, tags);
        // With the write, so the change and its event commit together.
        await publish({
          type: "metadata_changed",
          item: await itemAfterMetadataWrite(storage, item),
          metadata: written,
        });
        return { metadata: written };
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: requireAuth(c).id,
        action: "item.metadata.replace",
        resource_type: "item",
        resource_id: id,
        details: { tags },
      },
    );
    return c.json(
      { metadata: readableMetadata(metadata, c.get("apiKey")) },
      200,
    );
  });

  router.openapi(patchMetadataRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const body = c.req.valid("json");
    const tags = body.tags;
    // The row is read, gated and written in one transaction, so a
    // change to it landing in between cannot slip past the gate.
    const { metadata } = await runAuditedTransaction(
      storage,
      async () => {
        const item = requireWritableRow(
          c,
          await storage.items.getIncludingTrashed(id),
          () =>
            new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
        );
        requireTypeAccess(c, item.type, "write");
        // The metadata layer reaches the same row the properties doors
        // guard, so it answers to the same row-level rule.

        // Not subsumed by the projection below, though it reads as though it
        // should be: the projection counts a deduplicated set, so a body of 101
        // copies of one tag projects to one and passes it. This bounds what a
        // caller may send, that one bounds what the item may hold, and they are
        // different questions with different messages.
        if (Array.isArray(tags) && tags.length > MAX_TAGS_PER_ITEM) {
          throw new MarfaError(
            ErrorCode.VALIDATION_ERROR,
            `Maximum ${String(MAX_TAGS_PER_ITEM)} tags per item`,
          );
        }

        // No projection here. Reading the metadata row, unioning the incoming
        // tags into it and refusing over the bound would read in one
        // transaction and write in another, so it would bound nothing under
        // concurrency, and it would cost an unconditional read on every
        // successful request to duplicate a refusal the store makes inside
        // the transaction that computes the set, with the same status, code
        // and message, so nothing on the wire could tell the two apart.
        //
        // What is still checked above is what a caller may *send*, which is a
        // different question and one the store cannot answer: a body of a
        // hundred and one copies of one tag projects to one and is inside the
        // bound.

        const written = await storage.metadata.merge(id, tags);
        // With the write, so the change and its event commit together.
        await publish({
          type: "metadata_changed",
          item: await itemAfterMetadataWrite(storage, item),
          metadata: written,
        });
        return { metadata: written };
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: requireAuth(c).id,
        action: "item.metadata.update",
        resource_type: "item",
        resource_id: id,
        details: { tags },
      },
    );

    return c.json(
      { metadata: readableMetadata(metadata, c.get("apiKey")) },
      200,
    );
  });

  router.openapi(addTagsRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const body = c.req.valid("json");
    const tags = body.tags;
    // The row is read, gated and written in one transaction, so a
    // change to it landing in between cannot slip past the gate.
    const { metadata } = await runAuditedTransaction(
      storage,
      async () => {
        const item = requireWritableRow(
          c,
          await storage.items.getIncludingTrashed(id),
          () =>
            new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
        );
        requireTypeAccess(c, item.type, "write");
        // The metadata layer reaches the same row the properties doors
        // guard, so it answers to the same row-level rule.

        // The resulting set is bounded by the store, inside the transaction that
        // computes it. See the sibling door above for why there is no
        // projection here.
        const written = await storage.metadata.addTags(id, tags);
        // With the write, so the change and its event commit together.
        await publish({
          type: "metadata_changed",
          item: await itemAfterMetadataWrite(storage, item),
          metadata: written,
        });
        return { metadata: written };
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "item.tag",
        resource_type: "item",
        resource_id: id,
        details: { tags },
      },
    );

    return c.json(
      { metadata: readableMetadata(metadata, c.get("apiKey")) },
      200,
    );
  });

  router.openapi(purgeItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const { version } = c.req.valid("query");
    const key = requireAuth(c);
    // The key's type map is asked whatever state the row is in, and the
    // version, where one is named, against the row inside the purge's own
    // transaction: a check before it would let a write land between the two
    // and be destroyed unseen.
    const outcome = await runAuditedTransaction(
      storage,
      () =>
        writeItem(
          storage,
          { kind: "credential", key },
          { op: "purge", id, ...(version !== undefined && { version }) },
        ),
      (result) =>
        result.outcome !== "stale"
          ? {
              client_ip: c.get("clientIp") ?? null,
              key_id: key.id,
              action: "item.purge",
              resource_type: "item",
              resource_id: id,
            }
          : null,
    );
    if (outcome.outcome === "stale") {
      // Returned rather than thrown, so the error handler that sets this
      // never runs.
      c.header("X-Error-Code", outcome.conflict.error.code);
      return c.json(outcome.conflict, 409);
    }

    return c.json({ ok: true as const }, 200);
  });

  router.openapi(removeTagRoute, async (c) => {
    // The tag is used as the router hands it over. Hono decodes a path
    // parameter exactly once, so decoding it again is not defensive: it
    // corrupts a value that was already correct. Decoded twice, a tag
    // holding a literal percent would throw on the second decode and
    // answer 500, while one whose text happened to look like an escape
    // would decode into a different tag and remove nothing, silently.
    const { id, tag } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    // The row is read, gated and written in one transaction, so a
    // change to it landing in between cannot slip past the gate.
    const { metadata } = await runAuditedTransaction(
      storage,
      async () => {
        const item = requireWritableRow(
          c,
          await storage.items.getIncludingTrashed(id),
          () =>
            new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
        );
        requireTypeAccess(c, item.type, "write");
        // The metadata layer reaches the same row the properties doors
        // guard, so it answers to the same row-level rule.
        const written = await storage.metadata.removeTag(id, tag);
        // With the write, so the change and its event commit together.
        await publish({
          type: "metadata_changed",
          item: await itemAfterMetadataWrite(storage, item),
          metadata: written,
        });
        return { metadata: written };
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "item.untag",
        resource_type: "item",
        resource_id: id,
        details: { tag },
      },
    );

    return c.json(
      { metadata: readableMetadata(metadata, c.get("apiKey")) },
      200,
    );
  });

  return router;
}
