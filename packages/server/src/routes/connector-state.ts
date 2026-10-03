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
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../page-limits.js";
import { pageOf } from "./_schemas.js";
import {
  refuseUnknownBodyKeys,
  refuseUnknownQueryParams,
} from "./_unknown-query-keys.js";
import {
  IdParam,
  connectorOrRefuse,
  ownKeyResponses,
  requireOwnKey,
  requireOwnKeyOrOperator,
  validationResponse,
} from "./connectors.js";

export const MAX_STATE_BYTES = 512 * 1024;
export const MAX_RECORD_BYTES = 16 * 1024;
export const MAX_AGREEMENTS_PER_REQUEST = 500;

const CONNECTOR_KEY_ONLY = "The connector's own key only.";

const UNDECLARED_REFUSED =
  "A top-level field the body does not declare is refused.";

const FENCED =
  "Taken only from the `process` holding a live hold on the registration; from any other this answers `409 connector_held` and writes nothing, naming the other process's `expires_at` in `details` when one holds it.";

const ProcessSchema = z
  .string()
  .min(1)
  .max(100)
  .describe(
    "The process's own name for itself, opaque to the server, such as a UUID it chose at start.",
  );

/**
 * Zod rebuilds a record without its `__proto__` key, which a vendor's payload
 * may carry as data, so the doors that write one take it from the body as
 * parsed once this has passed it.
 */
const JsonObject = z.record(z.string(), z.unknown());

const ItemId = z.string().min(1).max(200);

const ConnectorStateSchema = z
  .object({
    state: JsonObject.describe(
      "The document as last written; `{}` when none was.",
    ),
    updated_at: z
      .string()
      .nullable()
      .describe("When it was last written; `null` when it never was."),
  })
  .openapi("ConnectorState");

const WrittenStateSchema = z.object({
  state: JsonObject.describe("The document as written."),
  updated_at: z.string().describe("When it was written."),
});

const ConnectorAgreementSchema = z
  .object({
    item_id: z.string(),
    waiting: z
      .boolean()
      .describe(
        "Whether a change to the row waits to be carried to the vendor.",
      ),
    record: JsonObject.describe("The connector's own record of the row."),
    updated_at: z.string(),
  })
  .openapi("ConnectorAgreement");

const HoldInputSchema = z.object({ process: ProcessSchema });

const StateInputSchema = z.object({
  process: ProcessSchema,
  state: JsonObject,
});

const FindInputSchema = z.object({
  item_ids: z.array(ItemId).min(1).max(MAX_AGREEMENTS_PER_REQUEST),
});

const AgreementsInputSchema = z.object({
  process: ProcessSchema,
  set: z
    .array(
      z.object({
        item_id: ItemId,
        waiting: z.boolean(),
        record: JsonObject,
      }),
    )
    .max(MAX_AGREEMENTS_PER_REQUEST)
    .optional()
    .describe("Records to write, each replacing the row's."),
  clear: z
    .array(ItemId)
    .max(MAX_AGREEMENTS_PER_REQUEST)
    .optional()
    .describe("Rows whose records to remove."),
});

const bodyRefusal = {
  400: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema([
          "missing_required_field",
          "validation_error",
        ]),
      },
    },
    description: "A field missing, or one of the wrong shape or past its bound",
  },
};

const heldResponse = {
  409: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["connector_held"]),
      },
    },
    description:
      "Another process holds the registration until `details.expires_at`; the hold did not move",
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
      "`process` does not hold the registration: another process does, until `details.expires_at`, or no live hold does and `details` names no `expires_at`. Nothing was written",
  },
};

const holdRoute = createRoute({
  operationId: "holdConnector",
  method: "post",
  path: "/{id}/hold",
  tags: ["Connectors"],
  summary: "Take or renew the hold on a registration",
  description: `Holds the registration for \`process\` until the server's clock plus the instance's hold window, three minutes unless it names another, and answers until when, for how long, and whether this renewed a hold the process still held. The process holding it renews it the same way; while another process holds it and its hold has not lapsed, this answers \`409 connector_held\` and nothing moves. Only the process holding a live hold writes the state and the agreements. A hold is a lock the process takes and gives up: nothing watches it, and a process that stops renewing simply loses it, so one answered \`renewed: false\` while it believed it held the registration re-reads the state and the agreements before writing again. ${UNDECLARED_REFUSED} ${CONNECTOR_KEY_ONLY}`,
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
            expires_at: z.string().describe("When the hold lapses."),
            ttl_ms: z
              .number()
              .int()
              .describe(
                "The instance's hold window in milliseconds: `expires_at` is the server's clock plus this when it took the hold, so a process schedules its next renewal without reading the server's clock.",
              ),
            renewed: z
              .boolean()
              .describe(
                "True only when this process's hold was still live when the call arrived; false on a first take and on a take after a lapse. A process answered false while it believed it held the registration re-reads the state and the agreements before writing again.",
              ),
          }),
        },
      },
      description: "Held",
    },
    ...bodyRefusal,
    ...ownKeyResponses,
    ...heldResponse,
  },
});

const releaseHoldRoute = createRoute({
  operationId: "releaseConnectorHold",
  method: "delete",
  path: "/{id}/hold",
  tags: ["Connectors"],
  summary: "Release the hold on a registration",
  description: `Releases the hold if \`process\` holds it, so another process may take it at once. Answers the same whether or not it did, and leaves another process's hold standing. ${CONNECTOR_KEY_ONLY}`,
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({ process: ProcessSchema }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Released, or never held by this process",
    },
    ...bodyRefusal,
    ...ownKeyResponses,
  },
});

const getStateRoute = createRoute({
  operationId: "getConnectorState",
  method: "get",
  path: "/{id}/state",
  tags: ["Connectors"],
  summary: "Read what a connector keeps on the instance",
  description: `The state document of the registration's source, which a later key with the same source reads too. ${CONNECTOR_KEY_ONLY}`,
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: { "application/json": { schema: ConnectorStateSchema } },
      description: "The state",
    },
    ...ownKeyResponses,
  },
});

const putStateRoute = createRoute({
  operationId: "replaceConnectorState",
  method: "put",
  path: "/{id}/state",
  tags: ["Connectors"],
  summary: "Replace what a connector keeps on the instance",
  description: `Replaces the state document of the registration's source whole. At most ${String(MAX_STATE_BYTES / 1024)} KiB serialized. ${FENCED} ${UNDECLARED_REFUSED} ${CONNECTOR_KEY_ONLY}`,
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
      description: "The state, written",
    },
    ...bodyRefusal,
    ...ownKeyResponses,
    ...fencedResponse,
  },
});

const clearStateRoute = createRoute({
  operationId: "clearConnectorState",
  method: "delete",
  path: "/{id}/state",
  tags: ["Connectors"],
  summary: "Clear what a connector keeps on the instance",
  description:
    "Removes the state document and every agreement of the registration's source, which every registration of that source reads, and writes an audit row against the registration named. No hold fences it. The connector's own key or the operator key.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Cleared",
    },
    ...ownKeyResponses,
  },
});

const writeAgreementsRoute = createRoute({
  operationId: "writeConnectorAgreements",
  method: "post",
  path: "/{id}/agreements",
  tags: ["Connectors"],
  summary: "Write a connector's agreements about rows",
  description: `Writes and removes the connector's records of what it and its vendor last agreed about rows, one per row for the registration's source: at most ${String(MAX_AGREEMENTS_PER_REQUEST)} in each list, each record at most ${String(MAX_RECORD_BYTES / 1024)} KiB serialized, and no row named twice. A row that is not stored, or whose type the key's type map does not read, is skipped and named in \`skipped\`; a trashed row is stored. ${UNDECLARED_REFUSED} A record announces nothing and leaves the row, its \`updated_at\` and its version as they were. ${FENCED} ${CONNECTOR_KEY_ONLY}`,
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
            written: z.number().int(),
            cleared: z.number().int(),
            skipped: z
              .array(z.string())
              .describe("The ids skipped, in the order named."),
          }),
        },
      },
      description: "What was written",
    },
    ...bodyRefusal,
    ...ownKeyResponses,
    ...fencedResponse,
  },
});

const findAgreementsRoute = createRoute({
  operationId: "findConnectorAgreements",
  method: "post",
  path: "/{id}/agreements/find",
  tags: ["Connectors"],
  summary: "Read a connector's agreements about named rows",
  description: `The agreements of the rows named that have one, each row once, in the order first named; at most ${String(MAX_AGREEMENTS_PER_REQUEST)} ids. A row whose type the key's type map does not read is left out. ${UNDECLARED_REFUSED} ${CONNECTOR_KEY_ONLY}`,
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
          schema: z.object({ data: z.array(ConnectorAgreementSchema) }),
        },
      },
      description: "The agreements",
    },
    ...bodyRefusal,
    ...ownKeyResponses,
  },
});

const listAgreementsRoute = createRoute({
  operationId: "listConnectorAgreements",
  method: "get",
  path: "/{id}/agreements",
  tags: ["Connectors"],
  summary: "List a connector's agreements",
  description: `The agreements of the registration's source, the longest unchanged first. A row whose type the key's type map does not read is left out, so a page can be short with a cursor still to follow. ${CONNECTOR_KEY_ONLY}`,
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({
      waiting: z
        .enum(["true", "false"])
        .optional()
        .describe(
          "Only the agreements waiting to be carried to the vendor, or only the others.",
        ),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_LIMIT)
        .default(DEFAULT_PAGE_LIMIT)
        .describe(
          `How many agreements: at most ${String(MAX_PAGE_LIMIT)}, ${String(DEFAULT_PAGE_LIMIT)} unless given.`,
        ),
      cursor: z
        .string()
        .optional()
        .describe("Opaque cursor from a previous page's `next_cursor`."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(ConnectorAgreementSchema, "ConnectorAgreementPage"),
        },
      },
      description: "The agreements",
    },
    ...validationResponse,
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
    refuseUnknownQueryParams(c.req.raw.url, releaseHoldRoute.request.query);
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

  router.openapi(clearStateRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKeyOrOperator(connector.key_id, key);
    await runAuditedTransaction(
      storage,
      () => storage.connectorState.clear(connector.source),
      (cleared) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: key.id,
        action: "connector_state.clear",
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

  router.openapi(findAgreementsRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    refuseUnknownBodyKeys(await c.req.json(), FindInputSchema);
    const { item_ids } = c.req.valid("json");
    return c.json(
      {
        data: await storage.connectorState.findAgreements(
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
    refuseUnknownQueryParams(c.req.raw.url, listAgreementsRoute.request.query);
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
