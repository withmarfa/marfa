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
import { assertTypeReadable } from "./_type-filter.js";
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
        "When the purge happened, or the later time of the vendor's change a connector made to carry it out. Set with `POST /items/tombstones`. A vendor change after this time is a new item.",
      ),
  })
  .describe(
    "What a purge left of an item under its type: a link or natural key it held.",
  )
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
    .describe(
      "Link values to name. `type` must name a `link_field`. Links held by a subtype's items aren't included.",
    ),
  source: z
    .string()
    .min(1)
    .optional()
    .describe("The source the `source_ids` are natural keys under."),
  source_ids: z
    .array(z.string().min(1))
    .optional()
    .describe("The `source_id` values to name under `source`."),
};

const LookupRequestSchema = z.strictObject({
  ...selectorFields,
  ids: z
    .array(z.string())
    .optional()
    .describe("Item IDs to look up, whatever their types."),
  include: z
    .array(z.enum(["edges"]))
    .optional()
    .describe(
      "`edges` adds each item's outbound edges, as `GET /items?include=edges` does.",
    ),
});

const LookupResponseSchema = z.object({
  data: z
    .array(ItemSchema)
    .describe(
      "The items found, in any state, in the order the request named their keys, each once. Items you can't read, and `system.*` items, are left out.",
    ),
  tombstones: z
    .array(TombstoneSchema)
    .describe(
      "The tombstones under `type` for the keys named, in the order named. Empty when you look up by `ids`.",
    ),
});

const TombstonesRequestSchema = z.strictObject({
  ...selectorFields,
  settled_at: z
    .string()
    .describe(
      "The time of the vendor's own change that carried out the purge, as an RFC 3339 time. A tombstone takes it only if it is later than the tombstone's current `settled_at`.",
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
    "Finds items, in any state, by link, by natural key or by ID, and returns the tombstones that purges left for those keys. Name exactly one of `links`, `source` with `source_ids`, or `ids`, with at most 500 values.",
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
      description:
        "Returns the items found and the tombstones purges left for the keys named. A key that an item holds again has no tombstone. You get no tombstones if you can read only subtypes of `type`.",
    },
    400: {
      content: { "application/json": { schema: selectorRefusal } },
      description:
        "- `missing_required_field`: `type` is missing.\n- `validation_error`: `type` is malformed, or the body doesn't name exactly one selector, or has more than 500 values, an empty value, an undeclared key, or `links` for a type with no `link_field`.\n- `unknown_type`: `type` isn't registered.\n- `invalid_id`: an ID in `ids` is malformed.",
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
        "- `type_not_permitted`: your credential reaches no type, or reads nothing under `type`.",
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
    "Moves the `settled_at` of tombstones later, never earlier, and returns them. A connector calls it after changing the vendor's copy to carry out a purge, so that change doesn't bring the item back as a new row.",
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
      description:
        "Returns the named tombstones as they now stand. A key with no tombstone under `type` is left out.",
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
        "- `missing_required_field`: `type` or `settled_at` is missing.\n- `validation_error`: `type` or `settled_at` is malformed, the body doesn't name exactly one of `links` or `source` with `source_ids`, or has more than 500 values, an empty value, an undeclared key, or `links` for a type with no `link_field`.\n- `unknown_type`: `type` isn't registered.",
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
        "- `type_not_permitted`: you don't have write on `type`.\n- `forbidden`: `source` is not your credential's own or one of your key's `sources`. `details.source` names it.",
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
    // The type is named outright, so a credential that reads nothing under it
    // is told so rather than answered with nothing.
    assertTypeReadable(c, type);
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
      selector.kind !== "ids" && mayRead(apiKey, type)
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
