import { maxStringLength } from "@withmarfa/shared";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
/**
 * What a connector keeps on the instance rather than beside itself, so a
 * process can run anywhere and restart empty.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import { DEFAULT_CONNECTOR_HOLD_MS } from "../config.js";
import type { AppConfig } from "../config.js";
import type { AppEnv } from "../middleware/auth.js";
import { mayReadType, requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  createOpenAPIRouter,
  makeErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  pageLimit,
  pageCursor,
} from "../page-limits.js";
import { pageOf } from "./_schemas.js";
import { refuseUnknownBodyKeys } from "./_unknown-body-keys.js";
import {
  IdParam,
  connectorOrRefuse,
  ownKeyOrOperatorResponses,
  ownKeyResponses,
  requireOwnKey,
  requireOwnKeyOrOperator,
} from "./connectors.js";

export const MAX_STATE_BYTES = 512 * 1024;
export const MAX_RECORD_BYTES = 16 * 1024;
export const MAX_AGREEMENTS_PER_REQUEST = 500;

const ProcessSchema = maxStringLength(z.string().min(1), 100).describe(
  "A name the process chose for itself, such as a UUID made at start. Marfa treats it as opaque.",
);

/** The `process` of a write the hold fences. */
const HolderSchema = ProcessSchema.describe(
  "The name the process took the connector's hold under.",
);

/**
 * Zod rebuilds a record without its `__proto__` key, which a vendor's payload
 * may carry as data, so the doors that write one take it from the body as
 * parsed once this has passed it.
 */
const JsonObject = z.record(z.string(), z.unknown());

const ItemId = maxStringLength(z.string().min(1), 200);

const WAITING =
  "`true` if a change to the item is waiting to be carried to the vendor.";

const ConnectorStateSchema = z
  .object({
    state: JsonObject.describe(
      "The document as last written; `{}` if none was.",
    ),
    updated_at: z
      .string()
      .nullable()
      .describe("When it was last written; `null` if it never was."),
  })
  .describe(
    "A connector's state document: the JSON object it keeps on the instance to resume from.",
  )
  .openapi("ConnectorState");

const WrittenStateSchema = z.object({
  state: JsonObject.describe("The document as written."),
  updated_at: z.string().describe("When it was written."),
});

const ConnectorAgreementSchema = z
  .object({
    item_id: z.string().describe("The ID of the item the agreement is about."),
    waiting: z.boolean().describe(WAITING),
    record: JsonObject.describe(
      "The connector's own record of the item, as it wrote it.",
    ),
    updated_at: z.string().describe("When the agreement was last written."),
  })
  .describe(
    "An agreement is a connector's record of what it and its vendor last agreed about one item.",
  )
  .openapi("ConnectorAgreement");

const HoldInputSchema = z.object({ process: ProcessSchema });

const StateInputSchema = z.object({
  process: HolderSchema,
  state: JsonObject.describe(
    `The new document, a JSON object of at most ${String(MAX_STATE_BYTES / 1024)} KiB serialized. It replaces the whole document.`,
  ),
});

const FindInputSchema = z.object({
  item_ids: z
    .array(ItemId)
    .min(1)
    .max(MAX_AGREEMENTS_PER_REQUEST)
    .describe("The IDs of the items to look up."),
});

const AgreementsInputSchema = z.object({
  process: HolderSchema,
  set: z
    .array(
      z.object({
        item_id: ItemId.describe("The ID of the item."),
        waiting: z.boolean().describe(WAITING),
        record: JsonObject.describe(
          `The connector's record of the item: a JSON object of at most ${String(MAX_RECORD_BYTES / 1024)} KiB serialized.`,
        ),
      }),
    )
    .max(MAX_AGREEMENTS_PER_REQUEST)
    .optional()
    .describe(
      "Agreements to write. Each replaces the item's current agreement. Leave it out to write none.",
    ),
  clear: z
    .array(ItemId)
    .max(MAX_AGREEMENTS_PER_REQUEST)
    .optional()
    .describe(
      "The IDs of items whose agreements to remove. Leave it out to remove none.",
    ),
});

const UNKNOWN_FIELD =
  "the body has a top-level field the endpoint doesn't take";

const badRequest = (
  codes: readonly ["missing_required_field" | "validation_error", ...string[]],
  description: string,
) => ({
  400: {
    content: {
      "application/json": { schema: makeErrorResponseSchema(codes) },
    },
    description,
  },
});

const PROCESS_MISSING = "- `missing_required_field`: `process` is missing.";

const heldResponse = {
  409: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["connector_held"]),
      },
    },
    description:
      "- `connector_held`: another process holds the connector until `details.expires_at`. The hold doesn't move.",
  },
};

const fencedResponse = {
  409: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["connector_held"]),
      },
    },
    description:
      "- `connector_held`: `process` doesn't hold the connector. `details.expires_at` is when another process's hold ends, and is absent when no process holds a live hold. Nothing is written.",
  },
};

const holdRoute = createRoute({
  operationId: "holdConnector",
  method: "post",
  path: "/{id}/hold",
  tags: ["Connectors"],
  summary: "Take or renew a hold",
  description:
    "Takes the connector's hold for `process`, or renews it if `process` already holds it. Only the process holding a live hold can replace the state document or write agreements.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": { schema: HoldInputSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            expires_at: z
              .string()
              .describe(
                "When the hold lapses: the hold window after Marfa took or renewed it. The window is three minutes unless the instance sets another.",
              ),
            ttl_ms: z
              .number()
              .int()
              .describe(
                "The hold window in milliseconds, so you can schedule the next renewal without reading Marfa's clock.",
              ),
            renewed: z
              .boolean()
              .describe(
                "`true` if this process's hold was still live when the call arrived; `false` on a first take or after a lapse. If it's `false` and you believed you held the connector, read the state and agreements again before writing.",
              ),
          }),
        },
      },
      description:
        "Returns the hold. It lapses at `expires_at` unless you renew it: nothing watches it, and a process that stops renewing loses it.",
    },
    ...badRequest(
      ["missing_required_field", "validation_error"],
      `${PROCESS_MISSING}\n- \`validation_error\`: \`process\` isn't 1 to 100 characters, or ${UNKNOWN_FIELD}.`,
    ),
    ...ownKeyResponses,
    ...heldResponse,
  },
});

const releaseHoldRoute = createRoute({
  operationId: "releaseConnectorHold",
  method: "delete",
  path: "/{id}/hold",
  tags: ["Connectors"],
  summary: "Release a hold",
  description:
    "Releases the hold if `process` holds it, so another process can take it at once. Returns the same either way, and leaves another process's hold in place.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({ process: ProcessSchema }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description:
        "Returns `ok: true`, whether or not `process` held the hold.",
    },
    ...badRequest(
      ["missing_required_field", "validation_error"],
      `${PROCESS_MISSING}\n- \`validation_error\`: \`process\` isn't 1 to 100 characters, or the query has a parameter this endpoint doesn't take.`,
    ),
    ...ownKeyResponses,
  },
});

const getStateRoute = createRoute({
  operationId: "getConnectorState",
  method: "get",
  path: "/{id}/state",
  tags: ["Connectors"],
  summary: "Get the state document",
  description:
    "Returns the state document of the connector's source. A later key with the same source reads the same document.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: { "application/json": { schema: ConnectorStateSchema } },
      description: "Returns the state document.",
    },
    ...ownKeyResponses,
  },
});

const putStateRoute = createRoute({
  operationId: "replaceConnectorState",
  method: "put",
  path: "/{id}/state",
  tags: ["Connectors"],
  summary: "Replace the state document",
  description:
    "Replaces the whole state document of the connector's source. Only the process holding a live hold can write it.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": { schema: StateInputSchema },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: WrittenStateSchema } },
      description: "Returns the document as written.",
    },
    ...badRequest(
      ["missing_required_field", "validation_error"],
      `- \`missing_required_field\`: \`process\` or \`state\` is missing.\n- \`validation_error\`: \`process\` isn't 1 to 100 characters, \`state\` isn't a JSON object or is over ${String(MAX_STATE_BYTES / 1024)} KiB serialized, or ${UNKNOWN_FIELD}.`,
    ),
    ...ownKeyResponses,
    ...fencedResponse,
  },
});

const deleteStateRoute = createRoute({
  operationId: "deleteConnectorState",
  method: "delete",
  path: "/{id}/state",
  tags: ["Connectors"],
  summary: "Delete the state document",
  description:
    "Deletes the state document and every agreement of the connector's source, which every registration of that source reads. No hold is needed.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Returns `ok: true`.",
    },
    ...ownKeyOrOperatorResponses,
  },
});

const writeAgreementsRoute = createRoute({
  operationId: "writeConnectorAgreements",
  method: "post",
  path: "/{id}/agreements",
  tags: ["Connectors"],
  summary: "Write agreements",
  description:
    "Writes and clears the connector's agreements, its records of what it and its vendor last agreed about each item. Only the process holding a live hold can write them.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: AgreementsInputSchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            written: z
              .number()
              .int()
              .describe("How many agreements Marfa wrote."),
            cleared: z
              .number()
              .int()
              .describe("How many agreements Marfa removed."),
            skipped: z
              .array(z.string())
              .describe(
                "The IDs Marfa skipped, in the order named, `set` first. An ID is skipped if no stored item has it or its type is one you can't read. A trashed item counts as stored.",
              ),
          }),
        },
      },
      description:
        "Returns how many agreements Marfa wrote and removed, and the IDs it skipped. Writing an agreement doesn't change the item, its `updated_at` or its `version`, and sends no event.",
    },
    ...badRequest(
      ["missing_required_field", "validation_error"],
      `- \`missing_required_field\`: \`process\` is missing, or an entry in \`set\` lacks a field.\n- \`validation_error\`: a list has more than ${String(MAX_AGREEMENTS_PER_REQUEST)} entries, a record is over ${String(MAX_RECORD_BYTES / 1024)} KiB serialized, an item is named twice across \`set\` and \`clear\`, a field has the wrong type, or ${UNKNOWN_FIELD}.`,
    ),
    ...ownKeyResponses,
    ...fencedResponse,
  },
});

const lookupAgreementsRoute = createRoute({
  operationId: "lookupConnectorAgreements",
  method: "post",
  path: "/{id}/agreements/lookup",
  tags: ["Connectors"],
  summary: "Look up agreements",
  description:
    "Returns the agreements of the named items that have one, each item once, in the order you first named it. An item whose type you can't read is left out.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": { schema: FindInputSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z
              .array(ConnectorAgreementSchema)
              .describe("The agreements found. This list never pages."),
          }),
        },
      },
      description: "Returns the agreements.",
    },
    ...badRequest(
      ["missing_required_field", "validation_error"],
      `- \`missing_required_field\`: \`item_ids\` is missing.\n- \`validation_error\`: \`item_ids\` is empty or has more than ${String(MAX_AGREEMENTS_PER_REQUEST)} IDs, or ${UNKNOWN_FIELD}.`,
    ),
    ...ownKeyResponses,
  },
});

const listAgreementsRoute = createRoute({
  operationId: "listConnectorAgreements",
  method: "get",
  path: "/{id}/agreements",
  tags: ["Connectors"],
  summary: "List a connector's agreements",
  description:
    "Returns the agreements of the connector's source, the one written longest ago first. Items whose type you can't read are left out, so a page can be short with more to follow.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({
      waiting: z
        .enum(["true", "false"])
        .optional()
        .describe(
          "Only the agreements waiting to be carried to the vendor (`true`), or only the others (`false`).",
        ),
      limit: pageLimit({ max: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(ConnectorAgreementSchema, "ConnectorAgreementPage", {
            page: "One page of a connector's agreements.",
            data: "The agreements, the one written longest ago first.",
          }),
        },
      },
      description: "Returns a page of agreements.",
    },
    ...badRequest(
      ["validation_error"],
      "- `validation_error`: `waiting` isn't `true` or `false`, `limit` is out of range, `cursor` isn't one this endpoint returned, or the query has a parameter this endpoint doesn't take.",
    ),
    ...ownKeyResponses,
  },
});

function held(expiresAt: string | null): MarfaError {
  return expiresAt === null
    ? new MarfaError(
        ErrorCode.CONNECTOR_HELD,
        "This process does not hold this connector; take its hold before writing",
      )
    : new MarfaError(
        ErrorCode.CONNECTOR_HELD,
        `Another process holds this connector until ${expiresAt}`,
        { expires_at: expiresAt },
      );
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function connectorStateRoutes(storage: Storage, config: AppConfig) {
  const router = createOpenAPIRouter<AppEnv>();
  const holdMs = config.connectorHoldMs ?? DEFAULT_CONNECTOR_HOLD_MS;

  router.openapi(holdRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    refuseUnknownBodyKeys(await c.req.json(), HoldInputSchema);
    const { process } = c.req.valid("json");
    const hold = await storage.connectors.takeHold(
      connector.id,
      process,
      holdMs,
    );
    if (hold === null) {
      throw new MarfaError(
        ErrorCode.CONNECTOR_NOT_FOUND,
        "Connector not found",
      );
    }
    if (!hold.taken) throw held(hold.expires_at);
    return c.json(
      { expires_at: hold.expires_at, ttl_ms: holdMs, renewed: hold.renewed },
      200,
    );
  });

  router.openapi(releaseHoldRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    await storage.connectors.releaseHold(
      connector.id,
      c.req.valid("query").process,
    );
    return c.json({ ok: true as const }, 200);
  });

  router.openapi(getStateRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    return c.json(await storage.connectorState.getState(connector.source), 200);
  });

  router.openapi(putStateRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    const sent = await c.req.json<{ state: Record<string, unknown> }>();
    refuseUnknownBodyKeys(sent, StateInputSchema);
    const { process } = c.req.valid("json");
    const { state } = sent;
    if (serializedBytes(state) > MAX_STATE_BYTES) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `A state is at most ${String(MAX_STATE_BYTES / 1024)} KiB serialized`,
        { field: "state" },
      );
    }
    const written = await storage.connectorState.putState(
      { connectorId: connector.id, process },
      connector.source,
      state,
    );
    if (!("state" in written)) throw held(written.expires_at);
    return c.json(written, 200);
  });

  router.openapi(deleteStateRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKeyOrOperator(connector.key_id, key);
    await runAuditedTransaction(
      storage,
      () => storage.connectorState.clear(connector.source),
      (cleared) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: key.id,
        action: "connector_state.delete",
        resource_type: "connector",
        resource_id: connector.id,
        details: { source: connector.source, ...cleared },
      }),
    );
    return c.json({ ok: true as const }, 200);
  });

  router.openapi(writeAgreementsRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    const body = c.req.valid("json");
    const sent = await c.req.json<{
      set?: { record: Record<string, unknown> }[];
    }>();
    refuseUnknownBodyKeys(sent, AgreementsInputSchema);
    const set = (body.set ?? []).map((entry, index) => ({
      ...entry,
      record: sent.set?.[index]?.record ?? entry.record,
    }));
    const clear = body.clear ?? [];
    const named = [...set.map((entry) => entry.item_id), ...clear];
    if (new Set(named).size !== named.length) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "A row is named at most once in one request, across `set` and `clear`",
      );
    }
    const oversized = set.findIndex(
      (entry) => serializedBytes(entry.record) > MAX_RECORD_BYTES,
    );
    if (oversized !== -1) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `A record is at most ${String(MAX_RECORD_BYTES / 1024)} KiB serialized`,
        { field: `set[${String(oversized)}].record` },
      );
    }
    const written = await storage.connectorState.writeAgreements(
      { connectorId: connector.id, process: body.process },
      connector.source,
      { set, clear },
      (type) => mayReadType(key, type),
    );
    if (!("written" in written)) throw held(written.expires_at);
    return c.json(written, 200);
  });

  router.openapi(lookupAgreementsRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    refuseUnknownBodyKeys(await c.req.json(), FindInputSchema);
    const { item_ids } = c.req.valid("json");
    return c.json(
      {
        data: await storage.connectorState.lookupAgreements(
          connector.source,
          item_ids,
          (type) => mayReadType(key, type),
        ),
      },
      200,
    );
  });

  router.openapi(listAgreementsRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    const { waiting, limit, cursor } = c.req.valid("query");
    return c.json(
      await storage.connectorState.listAgreements(
        connector.source,
        waiting === undefined ? {} : { waiting: waiting === "true" },
        { limit, cursor },
        (type) => mayReadType(key, type),
      ),
      200,
    );
  });

  return router;
}
