import { runAuditedTransaction } from "../storage/audited-transaction.js";
// The doors a connector finds its rows, and the tombstones its purges left, by.

import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  getTypeSchema,
  isValidId,
  isValidTypeIdentifier,
  malformedTypeIdentifier,
} from "@withmarfa/shared";
import type { ApiKey, Item } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireTypeAccess,
  checkTypeAccess,
  getTypeFilter,
  itemProvenanceSource,
  readsSomeType,
} from "../middleware/auth.js";
import type {
  Storage,
  Tombstone,
  TombstoneSelector,
} from "../storage/interface.js";
import { normalizeTimeBound } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { withCascadeMarks } from "./_cascade-marks.js";
import { hydrateEdgesForItems } from "./_edges-hydrate.js";
import { ItemSchema } from "./_schemas.js";

const MAX_LOOKUP_VALUES = 500;

const TombstoneSchema = z
  .object({
    key: z
      .string()
      .describe("The link value, or the natural key's `source_id`."),
    purged_at: z.string().describe("When the row holding the key was purged."),
    settled_at: z
      .string()
      .describe(
        "The purge time, or the later time of the vendor's own change a connector made in carrying the purge out, moved by `POST /items/tombstones`; a vendor change after it is a new row.",
      ),
  })
  .openapi("Tombstone");

const selectorFields = {
  type: z
    .string()
    .describe(
      "The type the links are held in and the tombstones are kept under.",
    ),
  links: z
    .array(z.string().min(1))
    .optional()
    .describe("Link values, which `type` must name a `link_field` for."),
  source: z
    .string()
    .min(1)
    .optional()
    .describe("The source the `source_ids` are natural keys under."),
  source_ids: z
    .array(z.string().min(1))
    .optional()
    .describe("Natural-key identifiers under `source`."),
};

const LookupRequestSchema = z.strictObject({
  ...selectorFields,
  ids: z.array(z.string()).optional().describe("Item ids."),
  include: z
    .array(z.enum(["edges"]))
    .optional()
    .describe(
      "`edges` hydrates each row's outbound edges as `GET /items?include=edges` does, held to the same two read permissions.",
    ),
});

const LookupResponseSchema = z.object({
  data: z
    .array(ItemSchema)
    .describe(
      "The rows found, in any state, in the order the request named their keys, each once.",
    ),
  tombstones: z
    .array(TombstoneSchema)
    .describe(
      "The tombstones under `type` for the keys named, in the order named. Empty by `ids`.",
    ),
});

const TombstonesRequestSchema = z.strictObject({
  ...selectorFields,
  settled_at: z
    .string()
    .describe(
      "An RFC 3339 instant: the time of the vendor's own change the connector made in carrying the purge out. Each named tombstone takes it where it is later than the one it holds, and keeps its own otherwise.",
    ),
});

const TombstonesResponseSchema = z.object({
  tombstones: z
    .array(TombstoneSchema)
    .describe(
      "The named tombstones as they stand after the write, in the order named. A key with no tombstone under `type` is left out.",
    ),
});

const selectorRefusal = makeErrorResponseSchema([
  "invalid_id",
  "missing_required_field",
  "unknown_type",
  "validation_error",
]);

const lookupRoute = createRoute({
  method: "post",
  path: "/lookup",
  operationId: "lookupItems",
  tags: ["Items"],
  summary: "Look up items",
  description:
    "Finds rows by one selector, in every state, the bin included, and answers the tombstones purges left for the keys it names. Name exactly one of `links`, `source` with `source_ids`, or `ids`, at most 500 values.\n\n" +
    "- `links`: the rows of `type` holding those values in the type's `link_field`, which `type` must name. Rows of a subtype are not among them; a subtype names its own link.\n" +
    "- `source` and `source_ids`: the rows holding those natural keys, whatever their type, so a row retyped since it was written is found.\n" +
    "- `ids`: the rows with those ids, whatever their type.\n\n" +
    "A row whose type the credential may not read is left out, as are `system.*` rows. `tombstones` answers, for each link or natural key named, what the purge of the row holding it recorded under `type`, and is empty by `ids`. A credential that may not read `type` is refused `403 type_not_permitted`. A key held by a row again has no tombstone. A read: nothing is announced or audited.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    body: {
      content: { "application/json": { schema: LookupRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: LookupResponseSchema } },
      description: "The rows found and the tombstones for the keys named",
    },
    400: {
      content: { "application/json": { schema: selectorRefusal } },
      description:
        "`missing_required_field` for a body naming no `type`; `validation_error` for a malformed `type`, a body naming no selector or more than one, `source` without `source_ids` or the reverse, more than 500 values, an empty value, a key the door does not declare, or `links` for a type naming no `link_field`; `unknown_type` for a well-formed type nothing registered; `invalid_id` for a malformed id.",
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
      description:
        "The credential's type permissions reach no type, or it may not read `type`. A credential that reaches some types is answered the rows it may read and the rest are left out.",
    },
  },
});

const tombstonesRoute = createRoute({
  method: "post",
  path: "/tombstones",
  operationId: "settleTombstones",
  tags: ["Items"],
  summary: "Move tombstones' settled time",
  description:
    "Moves the `settled_at` of the tombstones purges left under `type` to `settled_at`, for each named link or natural key whose tombstone holds an earlier time; a later one stands, so the time only ever moves later. An entry from the vendor naming a purged key comes back as a new row only if the vendor changed it after `settled_at`. A connector whose own carrying of the purge changed the vendor's copy, closing an issue it cannot delete say, moves the time to that change, so its own close does not bring the row back. Name exactly one of `links` or `source` with `source_ids`, at most 500 values. Needs write on `type`, and `source` is held as an item write holds it: the credential's own, or one its key claims.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    body: {
      content: { "application/json": { schema: TombstonesRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: TombstonesResponseSchema } },
      description: "The named tombstones as they now stand",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "missing_required_field",
            "unknown_type",
            "validation_error",
          ]),
        },
      },
      description:
        "`missing_required_field` for a body naming no `type` or `settled_at`; `validation_error` for a malformed `type` or `settled_at`, a body naming neither selector or both, `source` without `source_ids` or the reverse, more than 500 values, an empty value, a key the door does not declare, or `links` for a type naming no `link_field`; `unknown_type` for a well-formed type nothing registered.",
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
        "`type_not_permitted`: the credential does not hold write on `type`. `forbidden`: `source` is neither the credential's own nor one its key claims, named in `details.source`.",
    },
  },
});

type KeySelector =
  | { kind: "links"; values: string[] }
  | { kind: "source"; source: string; values: string[] };

type Selector = KeySelector | { kind: "ids"; values: string[] };

interface SelectorBody {
  links?: string[];
  source?: string;
  source_ids?: string[];
  ids?: string[];
}

function registeredType(type: string): string {
  if (!isValidTypeIdentifier(type)) {
    throw malformedTypeIdentifier("type", `Invalid type identifier: ${type}`);
  }
  if (!getTypeSchema(type)) {
    throw new MarfaError(ErrorCode.UNKNOWN_TYPE, `Unknown type: ${type}`, {
      type,
    });
  }
  return type;
}

function selectorOf(
  type: string,
  body: SelectorBody,
  withIds: false,
): KeySelector;
function selectorOf(type: string, body: SelectorBody, withIds: true): Selector;
function selectorOf(
  type: string,
  body: SelectorBody,
  withIds: boolean,
): Selector {
  const named = [
    ...(body.links !== undefined ? ["links"] : []),
    ...(body.source !== undefined || body.source_ids !== undefined
      ? ["source"]
      : []),
    ...(withIds && body.ids !== undefined ? ["ids"] : []),
  ];
  if (named.length !== 1) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "Name exactly one selector: `links`, `source` with `source_ids`, or `ids`",
      { selectors: named },
    );
  }
  const once = (values: string[]) => [...new Set(values)];
  const capped = (values: string[]) => {
    if (values.length > MAX_LOOKUP_VALUES) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_LOOKUP_VALUES)} values per call`,
        { cap: MAX_LOOKUP_VALUES, provided: values.length },
      );
    }
    return once(values);
  };
  if (body.links !== undefined) {
    if (getTypeSchema(type)?.link_field === undefined) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Type "${type}" names no link_field, so its rows hold no links`,
        { field: "links", type },
      );
    }
    return { kind: "links", values: capped(body.links) };
  }
  if (withIds && body.ids !== undefined) {
    const ids = capped(body.ids);
    for (const id of ids) {
      if (!isValidId(id)) {
        throw new MarfaError(ErrorCode.INVALID_ID, `Invalid item id: ${id}`, {
          id,
        });
      }
    }
    return { kind: "ids", values: ids };
  }
  if (body.source === undefined || body.source_ids === undefined) {
    const missing = body.source === undefined ? "source" : "source_ids";
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "`source` and `source_ids` are named together",
      { field: missing },
    );
  }
  return {
    kind: "source",
    source: body.source,
    values: capped(body.source_ids),
  };
}

function tombstoneSelector(selector: KeySelector): TombstoneSelector {
  return selector.kind === "links"
    ? { links: selector.values }
    : { source: selector.source, source_ids: selector.values };
}

function inOrder(values: string[], found: Tombstone[]): Tombstone[] {
  const byKey = new Map(found.map((t) => [t.key, t]));
  return values.flatMap((value) => {
    const tombstone = byKey.get(value);
    return tombstone ? [tombstone] : [];
  });
}

function mayRead(key: ApiKey, type: string): boolean {
  try {
    checkTypeAccess(key, type, "read");
    return true;
  } catch {
    return false;
  }
}

export function itemsLookupRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(lookupRoute, async (c) => {
    const apiKey = requireAuth(c);
    const body = c.req.valid("json");
    const type = registeredType(body.type);
    const selector = selectorOf(type, body, true);
    // The type is named outright, so a credential that may not read it is told
    // so rather than answered with nothing.
    requireTypeAccess(c, type, "read");
    // Before the per-row filter: an empty answer to a key that may read
    // nothing would say the keys named nothing.
    getTypeFilter(c);

    const found =
      selector.kind === "links"
        ? await storage.items.findByLinks(type, selector.values)
        : selector.kind === "source"
          ? await storage.items.findBySourceIds(
              selector.source,
              selector.values,
            )
          : await storage.items.getMany(selector.values, {
              includeTrashed: true,
            });
    const readable: Item[] = [];
    for (const value of selector.values) {
      const item = found.get(value);
      if (!item || item.type.startsWith("system.")) continue;
      if (!mayRead(apiKey, item.type)) continue;
      readable.push(item);
    }
    const rows = await withCascadeMarks(storage, apiKey, readable);

    const tombstones =
      selector.kind !== "ids"
        ? inOrder(
            selector.values,
            await storage.items.tombstones(type, tombstoneSelector(selector)),
          )
        : [];

    const data =
      body.include?.includes("edges") === true
        ? await (async () => {
            const edges = await hydrateEdgesForItems(
              storage,
              apiKey,
              rows.map((item) => item.id),
            );
            return rows.map((item) => ({
              ...item,
              edges: edges.get(item.id) ?? {},
            }));
          })()
        : rows;

    return c.json({ data, tombstones }, 200);
  });

  router.openapi(tombstonesRoute, async (c) => {
    const apiKey = requireAuth(c);
    const body = c.req.valid("json");
    const type = registeredType(body.type);
    const selector = selectorOf(type, body, false);
    const settledAt = normalizeTimeBound(body.settled_at, "settled_at");
    requireTypeAccess(c, type, "write");
    if (selector.kind === "source") {
      itemProvenanceSource(apiKey, selector.source);
    }

    const tombstones = inOrder(
      selector.values,
      await runAuditedTransaction(
        storage,
        () =>
          storage.items.settleTombstones(
            type,
            tombstoneSelector(selector),
            settledAt,
          ),
        (tombstones) => ({
          client_ip: c.get("clientIp") ?? null,
          key_id: c.get("apiKey")?.id,
          action: "items.tombstones",
          resource_type: "type",
          resource_id: type,
          details: { settled_at: settledAt, count: tombstones.length },
        }),
      ),
    );

    return c.json({ tombstones }, 200);
  });

  return router;
}
