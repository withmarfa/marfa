import { OpenAPIHono } from "@hono/zod-openapi";
/**
 * Add the middleware's refusals and headers, and the stream and webhook
 * frames, to the document generated from the registered route schemas.
 * The live and committed documents use this same shaping step.
 */

import { CONDITIONAL_READ_OPERATIONS } from "./middleware/reach.js";
import { IDEMPOTENT_WRITE_DOORS } from "./middleware/idempotency.js";
import {
  IDEMPOTENCY_IN_FLIGHT,
  makeErrorResponseSchema,
  refusalComponentName,
} from "./openapi.js";
import { toOpenApiPath } from "./openapi-path.js";
import { CONTRACT_HEADER, CONTRACT_VERSION } from "./contract.js";
import { bodyCapFor } from "./middleware/body-cap.js";
import { WEBHOOK_EVENTS } from "./routes/webhooks.js";
import { STREAM_INCOMPLETE_REASONS } from "./routes/_stream-incomplete.js";

// Loose typing — the document is a plain OpenAPI 3.1 object. `paths` is typed
// `object` (not a precise Record) so the concrete `OpenAPIObject`, whose
// `PathItemObject` values carry no index signature, still satisfies the
// constraint; the generic preserves the real return type for callers.
interface OpenAPIDoc {
  paths?: object;
  webhooks?: object;
  tags?: unknown[];
  components?: object;
}

/**
 * The rules that hold across operations, stated once so that no operation
 * repeats them. `packages/server/API-STYLE.md` says what belongs here.
 */
const GENERAL_SECTIONS = [
  "Marfa stores typed records, called items, and the edges between them. This reference describes its HTTP API.",
  "## Authentication",
  "Send a credential in the `Authorization` header as `Bearer <token>`: an API key (`marfa_k1_…`) or the access token of an app someone signed in to (`marfa_at_…`). In this reference, *you* means the credential that sends the request.",
  "## Permissions",
  "Your credential reads and writes only the types its permissions reach. If you ask by ID for an item whose type you can't read, Marfa answers as if the item doesn't exist. An edge appears in a response only if you can read both its edge type and the type of the item it starts from.",
  "## Pagination",
  'A list returns one page at a time, as `{ "data": [...], "next_cursor": "..." }`. To get the next page, send `next_cursor` back as `cursor`. The last page has `next_cursor: null`. A page can be short or empty and still have more after it, so stop only when `next_cursor` is `null`.',
  "## Query parameters",
  "Every operation refuses a query parameter it doesn't recognize with `400 validation_error`, so a misspelled filter can't silently return everything. The `edge[<type>]` and `backref[<type>]` filters on `GET /items` and `GET /items/stats` are recognized for any type. Marfa ignores any parameter that starts with `_`, so use that prefix for a parameter of your own, such as a cache buster.",
  "## Errors",
  'An error answers `{ "error": { "code": "...", "message": "...", "details": {} } }`. Use `code` in your logic: each operation lists the codes it can return, and the `X-Error-Code` header repeats it. `message` is for people and can change. A version conflict also carries the item or edge as it stands now, in `current`, so you can merge and try again.',
  "## Idempotency",
  "A write that takes an `Idempotency-Key` header is safe to retry. Send the same request with the same key, and Marfa returns the first response, with `Idempotency-Replayed: true`, and doesn't write again. A key belongs to the credential that sends it. While the first request with a key is still running, a repeat returns `409 idempotency_key_in_flight` and writes nothing, so retry it. Reusing a key for a different request returns `422 idempotency_key_reused`.",
  "## Request bodies",
  "A body is JSON, sent with `Content-Type: application/json`. A request that doesn't send its body as JSON returns `400 validation_error` and changes nothing, even if it has no body at all. The exceptions are `POST /blobs`, which takes the bytes of a blob, and `POST /restore`, which takes an archive. `POST /auth/oauth2/register` takes JSON too, but answers a request that isn't JSON with its own error, not this one.",
  "## Time",
  "Every time is UTC, written as `2026-10-03T09:30:00.000Z`. A time field is named for what happened, such as `created_at`. A filter on a time field pairs `_after` and `_before`, and both leave out the time you give, except `updated_after`, which includes it so that nothing changed at the same moment is skipped. `GET /occurrences` takes a window, `from` and `to`, instead.",
  "## Event stream",
  "`GET /events` sends each change as a frame whose `id:` is its event ID, in the order Marfa made the changes. To resume, reconnect with the last ID you received as `Last-Event-ID`, under any `type` or `edges` filter: Marfa replays what you missed, then sends `stream_live`. Marfa reads your credential again before each batch of frames and every 30 seconds: you receive only what it can read now, and a credential that's revoked or expired ends the stream, so reconnect with a current one. Ignore lines that start with `:`.",
  "## Web pages",
  "A web page can connect from a browser with no setup. `POST /auth/oauth2/register` and the discovery documents answer any origin, so the page registers itself, then opens the authorization endpoint in a window for the owner to approve. Once the owner approves it, the origin of each redirect URI it registered may call every operation from a browser. Send the access token in `Authorization`: no response allows a browser's credentials.",
  "## Every response",
  "Every response carries `X-Marfa-Contract`, the version of this contract, which is also this document's version. Every response outside `/auth/` and `/.well-known/`, and every response to `POST /auth/oauth2/register`, also carries `X-Request-ID`, which identifies the request if you report a problem.",
].join("\n\n");

/**
 * `info` block for the generated document. `version` is the contract
 * version, whose rule is in `contract.ts`; the live `/openapi.json` and the
 * committed document read it from there.
 */
export const OPENAPI_DOCUMENT_INFO = {
  title: "Marfa API",
  version: String(CONTRACT_VERSION),
  description: GENERAL_SECTIONS,
} as const;

/**
 * The server the committed document names. Every instance answers at its own
 * address, so this is the port a local server listens on; generated clients
 * take it as their default base path, so it must be a real URL rather than a
 * template.
 */
export const SERVERS = [
  {
    url: "http://localhost:8600",
    description:
      "A Marfa instance running locally. Use your own instance's address.",
  },
];

export interface PublicTag {
  readonly name: string;
  readonly description: string;
  /**
   * The group's operations in the order a developer meets them: create or
   * register, get, list, update, replace, delete, then the group's other
   * actions. Each is an `operationId`.
   */
  readonly operations: readonly string[];
}

/**
 * The reference's groups, in sidebar order, each with its operations in
 * reading order.
 *
 * Every group must be carried by at least one published operation. A tag
 * describing a surface no operation belongs to reads as a surface the server
 * has and is withholding, which is the same defect as advertising a feature
 * with no door behind it. Every published operation is listed once, under its
 * own tag: `openapi-operation-order.test.ts` holds the lists to the document.
 */
export const PUBLIC_TAGS: readonly PublicTag[] = [
  {
    name: "Items",
    description:
      "The records Marfa stores, each of a type, and the ways to read and change them.",
    operations: [
      "createItem",
      "getItem",
      "listItems",
      "updateItem",
      "deleteItem",
      "previewItemTrash",
      "restoreItem",
      "purgeItem",
      "transitionItem",
      "listItemVersions",
      "lookupItems",
      "bulkGetItems",
      "bulkUpsertItems",
      "getItemStats",
      "listItemSummaries",
      "listOccurrences",
      "settleTombstones",
    ],
  },
  {
    name: "Trash",
    description:
      "Items in the trash: list them, move an item in, and restore, purge or empty them.",
    operations: [
      "listTrash",
      "trashItemSummary",
      "restoreItemSummary",
      "purgeItemSummary",
      "emptyTrash",
    ],
  },
  {
    name: "Bulk actions",
    description:
      "One change applied to every item a filter matches, run as a job you can follow and cancel.",
    operations: ["applyBulkAction", "getBulkActionJob", "cancelBulkActionJob"],
  },
  {
    name: "Metadata",
    description: "An item's tags and extensions together, and the tags in use.",
    operations: [
      "getItemMetadata",
      "replaceItemMetadata",
      "addItemTags",
      "removeItemTag",
      "listTags",
    ],
  },
  {
    name: "Extensions",
    description: "JSON objects attached to an item, one per namespace.",
    operations: [
      "getItemExtension",
      "listItemExtensions",
      "replaceItemExtension",
      "deleteItemExtension",
    ],
  },
  {
    name: "Edges",
    description: "Typed, directed relationships between items.",
    operations: [
      "createEdge",
      "getEdge",
      "listEdges",
      "updateEdge",
      "deleteEdge",
      "bulkUpsertEdges",
      "listItemEdges",
      "listItemBackrefs",
    ],
  },
  {
    name: "Search",
    description: "Full-text search across items.",
    operations: ["searchItems"],
  },
  {
    name: "Types",
    description:
      "The types items can have: those Marfa ships and those registered on this instance.",
    operations: [
      "registerType",
      "getType",
      "listTypes",
      "replaceType",
      "deleteType",
      "moveType",
      "normalizeType",
      "setTypeIcon",
      "clearTypeIcon",
    ],
  },
  {
    name: "Edge types",
    description:
      "The types edges can have, each with its cardinality and cascade rule.",
    operations: ["registerEdgeType", "listEdgeTypes", "deleteEdgeType"],
  },
  {
    name: "Blobs",
    description: "Bytes stored by content hash, and the stores that hold them.",
    operations: [
      "uploadBlob",
      "downloadBlob",
      "getBlobUrl",
      "listBlobCopies",
      "deleteBlobCopy",
      "listBlobStores",
      "listBlobOrphans",
    ],
  },
  {
    name: "Event stream",
    description: "Changes to items and edges, streamed as they happen.",
    operations: ["streamEvents"],
  },
  {
    name: "Webhooks",
    description:
      "Changes sent to a URL you choose, and each delivery's record.",
    operations: [
      "createWebhook",
      "getWebhook",
      "listWebhooks",
      "updateWebhook",
      "deleteWebhook",
      "listWebhookDeliveries",
      "redeliverWebhookDelivery",
      "receiveWebhookEvent",
    ],
  },
  {
    name: "Folders",
    description: "A folder's settings, held as a `system.folder` item.",
    operations: [
      "createFolder",
      "listFolders",
      "updateFolder",
      "revokeFolder",
      "reportFolderStatus",
      "getFolderStatus",
    ],
  },
  {
    name: "Views",
    description:
      "Saved lists of items with their sort and grouping, held as `system.view` items.",
    operations: ["createView", "listViewItems", "updateView", "deleteView"],
  },
  {
    name: "Connectors",
    description:
      "Processes outside the server that read and write on your behalf, with their heartbeats and runs.",
    operations: [
      "registerConnector",
      "getConnector",
      "listConnectors",
      "deleteConnector",
      "sendConnectorHeartbeat",
      "reportConnectorRun",
      "listConnectorRuns",
    ],
  },
  {
    name: "Connector state",
    description:
      "What the instance keeps for a connector's source: its hold, its state document and its agreements.",
    operations: [
      "takeConnectorHold",
      "releaseConnectorHold",
      "getConnectorState",
      "replaceConnectorState",
      "deleteConnectorState",
      "writeConnectorAgreements",
      "listConnectorAgreements",
      "lookupConnectorAgreements",
    ],
  },
  {
    name: "Inbound webhooks",
    description:
      "Addresses where a service sends requests to a connector, and the deliveries Marfa stores for it.",
    operations: [
      "createInboundEndpoint",
      "listInboundEndpoints",
      "retireInboundEndpoint",
      "listInboundDeliveries",
      "getInboundDeliveryBody",
      "markInboundDeliveriesHandled",
    ],
  },
  {
    name: "API keys",
    description:
      "The keys that authenticate requests to this instance, and the permissions each holds.",
    operations: [
      "createKey",
      "getCurrentKey",
      "listKeys",
      "updateKey",
      "revokeKey",
    ],
  },
  {
    name: "Apps",
    description:
      "Apps that register as OAuth clients, and the access the owner grants them.",
    operations: [
      "registerOAuthClient",
      "listAppGrants",
      "narrowAppGrant",
      "revokeAppGrant",
    ],
  },
  {
    name: "Owner",
    description: "The instance's owner and their profile.",
    operations: [
      "createOwner",
      "getOwner",
      "updateOwner",
      "updateProfile",
      "replaceOwnerPicture",
      "replaceProfilePicture",
      "getOwnerPicture",
    ],
  },
  {
    name: "Sign-ins and passkeys",
    description:
      "The browsers, apps and keys that can reach the instance, and the owner's passkeys.",
    operations: [
      "listSignIns",
      "renameSignIn",
      "endSignIn",
      "listOwnerPasskeys",
      "renameOwnerPasskey",
      "deleteOwnerPasskey",
    ],
  },
  {
    name: "Instance",
    description: "The instance itself: what it is and how it's configured.",
    operations: [
      "getInstance",
      "getOverview",
      "getConfig",
      "updateConfig",
      "replaceConfig",
    ],
  },
  {
    name: "Health and maintenance",
    description:
      "How the instance is doing: what needs attention, its metrics and audit log, its housekeeping jobs and its retired platform types, which this build no longer ships.",
    operations: [
      "listAttention",
      "getInstanceMetrics",
      "listAuditLog",
      "listHousekeeping",
      "runHousekeeping",
      "listRetiredPlatformTypes",
      "deleteRetiredPlatformType",
    ],
  },
  {
    name: "Export and restore",
    description: "Export the instance's data, and restore it from an archive.",
    operations: ["exportArchive", "restoreArchive"],
  },
];

/**
 * The `Idempotency-Key` header, added to every door that honors it.
 *
 * Derived from `IDEMPOTENT_WRITE_DOORS` rather than restated on each
 * `createRoute` definition, so the reference cannot claim a door the
 * middleware does not serve, or miss one it does. The table is written in
 * Hono's path syntax and the spec uses OpenAPI's, which is the whole of
 * the translation below.
 *
 * Declared here rather than as a `request.headers` schema on each route
 * for a second reason: a header schema on a `createRoute` is a validator
 * as well as a description, and the header is read by middleware that runs
 * before the route is reached. Two places deciding what a valid key is is
 * one more than there should be.
 */
const IDEMPOTENCY_HEADER_PARAM = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 255 },
  description:
    "A unique key that makes the request safe to retry. If you send the same request with the same key again, Marfa returns the first response and doesn't write again. A key belongs to the credential that sends it.",
};

/** The doors, keyed the way the reflected document keys an operation. */
const IDEMPOTENT_OPERATIONS = new Set(
  IDEMPOTENT_WRITE_DOORS.map((door) => {
    const [method, path] = door.split(" ");
    return `${(method ?? "").toLowerCase()} ${toOpenApiPath(path ?? "")}`;
  }),
);

/**
 * The response headers the server sets, and what each one means.
 *
 * None of these can be reflected. Every one is set by middleware or by the
 * error handler rather than declared on a `createRoute` response, so
 * without this a client could learn that any of them existed only by
 * reading the server. They are the set the chain sets on every operation;
 * a header one door sets itself (`Accept-Ranges`, `ETag`, `Content-Range`
 * on the blob doors) is declared inline on that door's responses. The
 * `Cache-Control` and `Pragma` in `routes/no-store.ts` sit on the plain-Hono
 * auth HTML pages, which are not part of the reflected API surface and are
 * deliberately left out.
 *
 * Held in `components.headers` and referenced from each response, so the
 * meaning is written once rather than restated on every operation.
 */
const RESPONSE_HEADER_COMPONENTS: Record<string, unknown> = {
  [CONTRACT_HEADER]: {
    description:
      "The contract version this server speaks, the same integer as the document's `info.version` and the root's `contract`. Sent on every response the application gives, refusals included, so a client can check the answer it is about to read. A client generated for another number cannot trust the body. A request refused by the HTTP layer before it reaches the application, such as one with a malformed host, is answered without it.",
    schema: { type: "integer", minimum: 0 },
  },
  "X-Marfa-Reach": {
    description:
      "The matching opaque reach, supplied only after a conditional copy read and its snapshot have completed. Successful conditional reads and snapshot-attributed resource refusals carry it with Cache-Control: no-store. Ordinary reads and write receipts carry none.",
    schema: {
      type: "string",
      pattern: "^[0-9a-f]{64}$",
      minLength: 64,
      maxLength: 64,
    },
  },
  "X-Request-ID": {
    description:
      "This request's identifier, the same one written to the server's request log. Echoes the caller's own `X-Request-ID` when it sends one matching `[A-Za-z0-9_-]{1,128}`, and is a generated UUIDv7 otherwise, so a client can either adopt the server's id or impose its own. Quote it when reporting a problem: it is the one value that finds the request again.",
    schema: { type: "string" },
  },
  "X-Error-Code": {
    description:
      "The machine-readable error code, identical to `error.code` in the body and drawn from the same enum the response schema lists. Read it rather than matching on `error.message`, which is prose written for a person and may be reworded. Present on every error the server renders, including one served from an idempotency record.",
    schema: { type: "string" },
  },
  "X-RateLimit-Limit": {
    description:
      "How many requests this credential may make against this path group in the current window. Sent on every response, not only refusals, so a client can pace itself before it is refused. A second window bounds what one credential spends across every path group together, and a refusal from that one carries this trio unchanged, so a 429 may arrive with requests apparently left. Absent entirely on a deployment that does not enable rate limiting, along with the rest of the `X-RateLimit-*` trio.",
    schema: { type: "integer" },
  },
  "X-RateLimit-Remaining": {
    description:
      "Requests left in this path group's window for this credential, floored at 0. A 429 from that window is the one that reads 0; a 429 from the credential-wide window described above can read more.",
    schema: { type: "integer" },
  },
  "X-RateLimit-Reset": {
    description:
      "Unix time in seconds at which the current window ends and `X-RateLimit-Remaining` returns to `X-RateLimit-Limit`.",
    schema: { type: "integer" },
  },
  "Retry-After": {
    description:
      "Seconds to wait before retrying, sent with the rate limiter's refusal. Derived from the time left in the window rather than a fixed backoff, so a client that honors it needs no backoff of its own.",
    schema: { type: "integer" },
  },
  "Idempotency-Replayed": {
    description:
      "Sent as `true` when this response was served from the record of an earlier request carrying the same `Idempotency-Key`, rather than by performing the write. It is only ever sent on a replay and only with that value, so its absence means the write was performed. The status and body are the first attempt's, which is why the header can arrive on an error: a recorded 409 replays as a 409. Read a replayed response exactly as the original would have been read: the header says where the answer came from, not that anything went wrong.",
    schema: { type: "string", enum: ["true"] },
  },
};

/** Headers on every response, whatever the operation or the status. */
const UNIVERSAL_RESPONSE_HEADERS = [CONTRACT_HEADER, "X-Request-ID"];

/**
 * Every header an answer carries that a browser hides from a page on another
 * origin unless CORS exposes it: the chain's, the blob doors' own (their
 * range, validator, disposition and sandbox policy), and the export's file
 * name. None is on the safelist, and a client that cannot see
 * `X-Marfa-Contract` refuses every success it is sent. `app.cors.test.ts`
 * holds this to every header the document declares.
 */
export const EXPOSED_RESPONSE_HEADERS: readonly string[] = [
  ...Object.keys(RESPONSE_HEADER_COMPONENTS),
  "Accept-Ranges",
  "Content-Range",
  "ETag",
  "Content-Disposition",
  "Content-Security-Policy",
];

/** Headers the rate limiter sets on every response that passes through it. */
const RATE_LIMIT_HEADERS = [
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
];

/**
 * Operations that bypass the general request limiter carry none of its
 * headers. Claim declares its own durable code-guessing limit separately.
 */
const AHEAD_OF_THE_LIMITER = new Set(["get /", "post /owner"]);

/**
 * Statuses answered ahead of the rate limiter and the idempotency claim: the
 * body cap refuses before either sees the request, so its refusal carries
 * neither's headers.
 */
const ANSWERED_AHEAD_OF_THE_LIMITER = new Set([413]);

/**
 * A refusal middleware answers on behalf of the doors it is mounted over.
 *
 * Reflected through the same schema factory the route declarations use,
 * so middleware and handler refusals share one envelope.
 */
export interface ChainRefusal {
  codes: readonly [string, ...string[]];
  name: string;
  schema: Record<string, unknown>;
  response: Record<string, unknown>;
}

const WRITTEN_REFUSALS: ChainRefusal[] = [];

function reflectedRefusal(
  codes: readonly [string, ...string[]],
): Record<string, unknown> {
  const name = refusalComponentName(codes);
  // Hono owns the schema metadata registry, including in the production bundle.
  const document = new OpenAPIHono();
  document.openAPIRegistry.register(name, makeErrorResponseSchema(codes));
  const schema = document.getOpenAPI31Document({
    openapi: "3.1.0",
    info: OPENAPI_DOCUMENT_INFO,
  }).components?.schemas?.[name];
  if (schema === undefined)
    throw new Error(`Refusal schema ${name} was not reflected`);
  return schema as Record<string, unknown>;
}

function chainRefusal(
  codes: readonly [string, ...string[]],
  description: string,
): ChainRefusal {
  const name = refusalComponentName(codes);
  const refusal: ChainRefusal = {
    codes,
    name,
    schema: reflectedRefusal(codes),
    response: {
      description,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${name}` },
        },
      },
    },
  };
  WRITTEN_REFUSALS.push(refusal);
  return refusal;
}

const WRITE_CONTENTION_TEXT =
  "`write_contention`: the database was busy, and Marfa couldn't complete the request in time. Nothing changed. Try the request again.";

const INSUFFICIENT_STORAGE_TEXT =
  "`insufficient_storage`: the disk that holds the instance's data has no room for the request, or the request would leave less free than the instance keeps in reserve. Nothing changed, unless `details.write_outcome` is `unknown`, which means the write may have landed: read what you changed before you repeat it. Free space on the disk, then try the request again.";

/**
 * Applied as floors: a route that declares the status itself keeps its own.
 *
 * The 401 belongs here because it is the credential gate's answer, hung off
 * the route's `security` by `createOpenAPIRouter` rather than raised by the
 * handler. The 503 rides with it: the gate records a key's first use in
 * each hour before the handler runs, so any credentialed request can meet
 * the database's write lock, and the storage layer answers that the same way
 * on every door.
 */
export const CHAIN_REFUSALS = {
  unauthorized: chainRefusal(
    ["unauthorized"],
    "`unauthorized`: the request has no credential, or its credential is not valid.",
  ),
  requestTooLarge: chainRefusal(
    ["request_too_large"],
    "`request_too_large`: the request body is larger than this instance accepts.",
  ),
  rateLimited: chainRefusal(
    ["rate_limited"],
    "`rate_limited`: you sent too many requests. Wait for the number of seconds in `Retry-After`, then try again.",
  ),
  writeContention: chainRefusal(["write_contention"], WRITE_CONTENTION_TEXT),
  insufficientStorage: chainRefusal(
    ["insufficient_storage"],
    INSUFFICIENT_STORAGE_TEXT,
  ),
  internalError: chainRefusal(
    ["internal_error"],
    "`internal_error`: Marfa failed in a way it didn't expect, and the request may not have completed. Read what you changed before you repeat a write.",
  ),
} as const;

const REACH_REFUSAL = chainRefusal(
  ["reach_changed"],
  "`reach_changed`: the reach in `X-Marfa-Reach` has changed. Rebuild the working copy.",
);
const REACH_PARAMETER = {
  name: "X-Marfa-Reach",
  in: "header",
  required: false,
  schema: {
    type: "string",
    pattern: "^[0-9a-f]{64}$",
    minLength: 64,
    maxLength: 64,
  },
  description:
    "The reach from a copy stream, for a working copy. Marfa reads the current data and checks the reach in one snapshot, and returns `409 reach_changed` if it has changed. Leave it out for an ordinary read.",
};

/**
 * Applies a chain refusal as a floor. A route that declares the same refusal
 * itself takes the shared text too, so one status reads one way everywhere;
 * a route answering something else on that status keeps its own.
 */
function floorRefusal(
  responses: Record<string, unknown>,
  status: string,
  refusal: ChainRefusal,
): void {
  const declared = responses[status] as
    { content?: Record<string, { schema?: { $ref?: string } }> } | undefined;
  if (declared === undefined) {
    responses[status] = refusal.response;
    return;
  }
  const ref = declared.content?.["application/json"]?.schema?.$ref;
  if (ref === `#/components/schemas/${refusal.name}`) {
    responses[status] = {
      ...declared,
      description: refusal.response.description,
    };
  }
}

/**
 * The instance a write names. Every operation outside `/auth` that is not a
 * read takes it: a door served ahead of the credential is either `/auth` or
 * one the document does not publish.
 */
const INSTANCE_PARAMETER = {
  name: "X-Marfa-Instance-Id",
  in: "header",
  required: false,
  schema: {
    type: "string",
    pattern:
      "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  },
  description:
    "The ID of the instance you expect, as `GET /` returns it. If another instance answers at this address, Marfa returns `409 instance_changed` and doesn't write. Leave it out to send the request to whichever instance answers.",
};
const INSTANCE_REFUSALS: {
  status: string;
  refusal: ChainRefusal;
  merge: "floor" | "branch";
}[] = [
  {
    status: "400",
    merge: "floor",
    refusal: chainRefusal(
      ["validation_error"],
      "`X-Marfa-Instance-Id` isn't one lowercase UUIDv7.",
    ),
  },
  {
    status: "409",
    merge: "branch",
    refusal: chainRefusal(
      ["instance_changed"],
      "`instance_changed`: `X-Marfa-Instance-Id` names another instance. Nothing is written. Rebuild the working copy from the instance at this address.",
    ),
  },
];

function namesInstance(method: string, pathKey: string): boolean {
  return (
    ["post", "put", "patch", "delete"].includes(method) &&
    !/^\/auth(?:\/|$)/.test(pathKey)
  );
}

function declaresSecurity(operation: Record<string, unknown>): boolean {
  const security = operation.security;
  return Array.isArray(security) && security.length > 0;
}

/**
 * What the idempotency middleware answers on the doors that honor the header.
 *
 * Declared beside the `Idempotency-Key` parameter, and from the same table,
 * so a door cannot advertise the header without declaring what sending it
 * can be refused with.
 */
const IDEMPOTENCY_REFUSALS: {
  status: string;
  refusal: ChainRefusal;
  /**
   * `floor` where the code is already inside whatever the door declares for
   * the status — `openapi-response-headers.test.ts` holds that — and
   * `branch` where the door answers the status with a shape of its own.
   */
  merge: "floor" | "branch";
}[] = [
  {
    status: "400",
    merge: "floor",
    refusal: chainRefusal(
      ["validation_error"],
      "`Idempotency-Key` is empty or longer than 255 characters.",
    ),
  },
  {
    status: "409",
    merge: "branch",
    refusal: chainRefusal(["idempotency_key_in_flight"], IDEMPOTENCY_IN_FLIGHT),
  },
  {
    status: "422",
    merge: "floor",
    refusal: chainRefusal(
      ["idempotency_key_reused", "idempotency_result_not_retained"],
      "- `idempotency_key_reused`: the key was first used for a different request. Nothing is written.\n- `idempotency_result_not_retained`: the first response was too large to keep, so Marfa can't replay it. The write isn't repeated.",
    ),
  },
];

/**
 * Add a refusal to a status the operation already answers with something
 * else, as a further branch rather than by rewriting what is there.
 */
function withExtraBranch(
  response: unknown,
  refusal: ChainRefusal,
): Record<string, unknown> {
  const existing = response as Record<string, unknown> & {
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  const media = existing.content?.["application/json"];
  const schema = media?.schema;
  if (media === undefined || schema === undefined) return existing;

  const added = { $ref: `#/components/schemas/${refusal.name}` };
  const branches: unknown[] = Array.isArray(schema.anyOf)
    ? (schema.anyOf as unknown[])
    : [schema];
  if (
    branches.some((branch) => (branch as { $ref?: string }).$ref === added.$ref)
  ) {
    return existing;
  }
  return {
    ...existing,
    content: {
      ...existing.content,
      "application/json": { ...media, schema: { anyOf: [...branches, added] } },
    },
  };
}

/**
 * Responses that answer with an error status without passing through the
 * error handler, so `X-Error-Code` is never set on them: registration's
 * `401` and `415`, which the sign-in library answers in its own shape.
 * Its `400` stays declared, because a query key on it is the server's own
 * refusal.
 *
 * Three responses return rather than throw and each stamps the header
 * itself, on the code the response actually carries, so the declaration is
 * true of them: the item conflict envelope on `patch /items/{id}`, the edge
 * conflict envelope, and the conflict a conditional natural-key upsert
 * answers on `post /items`.
 */
const RESPONSES_WITHOUT_ERROR_CODE = new Set<string>([
  "post /auth/oauth2/register 401",
  "post /auth/oauth2/register 415",
]);

/**
 * Statuses an idempotency claim releases rather than records.
 *
 * `RELEASED_STATUSES` in the middleware gives the key back on 401 and 403,
 * so neither is ever stored and neither can ever be replayed, and the
 * replay marker is not declared on them.
 */
const NEVER_REPLAYED_STATUSES = new Set([401, 403]);

/** `{ "X-Request-ID": { "$ref": … }, … }` for the named headers. */
function headerRefs(names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    out[name] = { $ref: `#/components/headers/${name}` };
  }
  return out;
}

/**
 * Declare, on one operation, the headers its responses actually carry.
 *
 * Which headers apply is decided per status rather than per operation:
 * `X-Error-Code` rides every error the handler renders, `Retry-After` only
 * the limiter's own refusal. `Idempotency-Replayed` is the exception that
 * is decided per operation, and it goes on every response rather than only
 * the success one because a replay reproduces whatever the first attempt
 * answered — a recorded conflict replays as a conflict.
 */
function withResponseHeaders(
  operation: Record<string, unknown>,
  replays: boolean,
  operationKey: string,
): Record<string, unknown> {
  const responses = operation.responses;
  if (responses === null || typeof responses !== "object") return operation;

  const next: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(
    responses as Record<string, unknown>,
  )) {
    if (response === null || typeof response !== "object") {
      next[status] = response;
      continue;
    }
    const code = Number.parseInt(status, 10);
    const names = [...UNIVERSAL_RESPONSE_HEADERS];
    const passedTheLimiter =
      !AHEAD_OF_THE_LIMITER.has(operationKey) &&
      !ANSWERED_AHEAD_OF_THE_LIMITER.has(code);
    if (passedTheLimiter) names.push(...RATE_LIMIT_HEADERS);
    // `default` and any other non-numeric key parses to NaN, and NaN fails
    // both comparisons — so an unrecognized key gets the universal set and
    // no claim this code cannot support.
    if (
      code >= 400 &&
      !RESPONSES_WITHOUT_ERROR_CODE.has(`${operationKey} ${status}`)
    ) {
      names.push("X-Error-Code");
    }
    if (code === 429) names.push("Retry-After");
    if (
      typeof operation.operationId === "string" &&
      CONDITIONAL_READ_OPERATIONS.has(operation.operationId) &&
      ((code >= 200 && code < 300) || code === 403 || code === 404)
    ) {
      names.push("X-Marfa-Reach");
    }
    if (
      replays &&
      !NEVER_REPLAYED_STATUSES.has(code) &&
      !ANSWERED_AHEAD_OF_THE_LIMITER.has(code)
    ) {
      names.push("Idempotency-Replayed");
    }

    const existing = (response as { headers?: Record<string, unknown> })
      .headers;
    next[status] = {
      ...response,
      headers: { ...headerRefs(names), ...(existing ?? {}) },
    };
  }

  return { ...operation, responses: next };
}

const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** A field holding a named schema, with its own text beside the reference. */
const described = (name: string, description: string) => ({
  allOf: [schemaRef(name), { description }],
});

const COPY_INSTANCE_ID = {
  type: "string",
  description:
    "Only on a copy stream: the instance's ID, as `GET /` returns it.",
};
const COPY_REACH = {
  type: "string",
  description:
    "Only on a copy stream: the reach to send as `X-Marfa-Reach`, to resume or to read the working copy's data.",
};

/**
 * The frames of `GET /events`, and the bodies of the webhook deliveries built
 * from the same events. Built when the document is, not when this module
 * loads: the event names come from `routes/webhooks.ts`, which reaches this
 * module through `openapi.ts`, so they may not exist yet at load.
 */
function eventSchemas(): Record<string, unknown> {
  const itemEvents = WEBHOOK_EVENTS.filter((name) => !name.startsWith("edge."));
  const edgeEvents = WEBHOOK_EVENTS.filter((name) => name.startsWith("edge."));
  const marker = (name: string) => ({
    type: "string",
    const: name,
    description: "The frame's name, which is also its `event:`.",
  });
  const deliveryFields = {
    type: "object",
    properties: {
      event_id: {
        type: "string",
        description:
          "The event's ID in the log, the same as its `id:` on `GET /events`.",
      },
      delivery_id: {
        type: "string",
        description:
          "The ID of the delivery, the same on every attempt. Use it to recognize a repeat.",
      },
      delivered_at: {
        type: "string",
        description: "When Marfa sent this attempt, in UTC.",
      },
    },
    required: ["event_id", "delivery_id", "delivered_at"],
  };
  return {
    ItemEventFrame: {
      type: "object",
      description:
        "An item event: a change to an item, or, as `metadata.changed`, to its tags or extensions. Except on a copy stream, you receive it only if your source filter shows the item.",
      properties: {
        event_type: {
          type: "string",
          enum: itemEvents,
          description: "The event, which is also the frame's `event:`.",
        },
        item: described(
          "Item",
          "The item after the change. On `item.deleted` and `item.purged` of an item a cascade trashed, it carries `trashed_by_cascade`, and `trashed_with` if you can read that item's type.",
        ),
        metadata: {
          oneOf: [schemaRef("Metadata"), { type: "null" }],
          description:
            "The item's tags and extensions after the change, with only the namespaces you can read. The stream leaves it out when the event carries none, and a webhook sends `null`.",
        },
        restored_with: {
          type: "string",
          description:
            "On `item.restored` of an item another item's restore brought back: the ID of that item, if you can read its type.",
        },
        listed: {
          type: "boolean",
          description:
            "Only on a copy stream: `true` if the item is in the set you can list, `false` if you can read it only by ID.",
        },
      },
      required: ["event_type", "item"],
    },
    EdgeEventFrame: {
      type: "object",
      description:
        "An edge event: a change to an edge. You receive it only if you can read both the edge type and `source_type`, and, except on a copy stream, only if your source filter shows the edge's source item.",
      properties: {
        event_type: {
          type: "string",
          enum: edgeEvents,
          description: "The event, which is also the frame's `event:`.",
        },
        edge: described(
          "Edge",
          "The edge after the change, or before it for `edge.deleted`.",
        ),
        source_type: {
          type: "string",
          description:
            "The type of the edge's source item when the event happened.",
        },
        purged_with: {
          type: "string",
          description:
            "On `edge.deleted` of an edge a purge removed: the ID of the purged item.",
        },
      },
      required: ["event_type", "edge"],
    },
    StreamCursorFrame: {
      type: "object",
      description:
        "The stream's first frame, with no `id:`: where the log stood when the stream opened. If Marfa can't read the log within 5 seconds, an ordinary stream leaves it out, so don't wait for it, and a copy stream ends with `stream_incomplete`.",
      properties: {
        event_type: marker("stream_cursor"),
        cursor: {
          type: "string",
          description:
            "The ID of the latest event in the log, or `0` if it's empty. Read state after this frame, and you can resume from this ID without missing a change.",
        },
        instance_id: COPY_INSTANCE_ID,
        reach: COPY_REACH,
      },
      required: ["event_type", "cursor"],
    },
    StreamLiveFrame: {
      type: "object",
      description:
        "Sent once, with no `id:`, when the catch-up is over: everything up to `cursor` has been sent or withheld, and what follows is live. A stream that ends early never sends it.",
      properties: {
        event_type: marker("stream_live"),
        cursor: {
          type: ["string", "null"],
          description:
            "A position you can resume from without receiving again what the catch-up covered. `null` only when Marfa couldn't read the log in time and had nothing to replay.",
        },
        instance_id: COPY_INSTANCE_ID,
        reach: COPY_REACH,
      },
      required: ["event_type", "cursor"],
    },
    StreamIncompleteFrame: {
      type: "object",
      description:
        "The last frame, with no `id:`, when the stream can no longer deliver what it opened with. Marfa sends nothing past the gap, so reconnect with the last `id:` you received. `reader_behind` comes when 4 MiB of frames wait unread, or when you take none for 30 seconds during the catch-up.",
      properties: {
        event_type: marker("stream_incomplete"),
        reason: {
          type: "string",
          enum: [...STREAM_INCOMPLETE_REASONS],
          description:
            "`replay_failed`: catch-up failed. `backlog_overflow`: changes piled up as it opened. `live_delivery_failed`: live events failed. `credential_ended`: your credential ended. `reader_behind`: you fell behind. `server_stopping`: Marfa is stopping.",
        },
        cursor: {
          type: ["string", "null"],
          description:
            "The ID of the last event the stream sent, or `null` if it sent none.",
        },
      },
      required: ["event_type", "reason", "cursor"],
    },
    CatchupTooOldFrame: {
      type: "object",
      description:
        "The last frame, with no `id:`, when the log no longer holds the events after your `Last-Event-ID`. Read state again from the API, then open a new stream.",
      properties: {
        event_type: marker("catchup_too_old"),
        min_retained_id: {
          type: "string",
          description: "The ID of the oldest event the log still holds.",
        },
        requested: {
          type: "string",
          description: "The `Last-Event-ID` you sent.",
        },
      },
      required: ["event_type", "min_retained_id", "requested"],
    },
    CursorAheadFrame: {
      type: "object",
      description:
        "The last frame, with no `id:`, when your `Last-Event-ID` is past the latest event in the log, as after the instance is restored to an earlier state. Read state again from the API.",
      properties: {
        event_type: marker("cursor_ahead"),
        requested: {
          type: "string",
          description: "The `Last-Event-ID` you sent.",
        },
        head: {
          type: "string",
          description: "The ID of the latest event in the log.",
        },
      },
      required: ["event_type", "requested", "head"],
    },
    ReachChangedFrame: {
      type: "object",
      description:
        "The last frame of a copy stream, with no `id:`, when its reach changes, such as after a retype or a narrowed key. Rebuild the working copy.",
      properties: { event_type: marker("reach_changed") },
      required: ["event_type"],
    },
    EventStreamFrame: {
      description:
        "One frame of `GET /events`. Its `event_type` is also its `event:`.",
      oneOf: [
        "StreamCursorFrame",
        "ItemEventFrame",
        "EdgeEventFrame",
        "StreamLiveFrame",
        "StreamIncompleteFrame",
        "CatchupTooOldFrame",
        "CursorAheadFrame",
        "ReachChangedFrame",
      ].map(schemaRef),
    },
    WebhookItemEvent: {
      description: "The body of a webhook delivery of an item event.",
      allOf: [
        schemaRef("ItemEventFrame"),
        {
          ...deliveryFields,
          required: [...deliveryFields.required, "metadata"],
        },
      ],
    },
    WebhookEdgeEvent: {
      description: "The body of a webhook delivery of an edge event.",
      allOf: [schemaRef("EdgeEventFrame"), deliveryFields],
    },
    WebhookEvent: {
      description:
        "The body of a webhook delivery: the event, with its ID and the delivery's.",
      oneOf: [schemaRef("WebhookItemEvent"), schemaRef("WebhookEdgeEvent")],
    },
  };
}

/**
 * The requests Marfa sends to a webhook's URL, as the top-level `webhooks`
 * of the document.
 */
function webhookRequests(): Record<string, unknown> {
  return {
    event: {
      post: {
        operationId: "receiveWebhookEvent",
        tags: ["Webhooks"],
        summary: "Receive a webhook event",
        description:
          "Marfa sends this request to a webhook's `url` for each event it subscribes to, with only what the webhook's credential can read when it's sent. A delivery can arrive more than once: use `delivery_id` to recognize a repeat.",
        parameters: [
          {
            name: "X-Marfa-Signature",
            in: "header",
            required: true,
            schema: { type: "string" },
            description:
              "`t=<unix seconds>,v1=<hex>`, where `v1` is the HMAC-SHA256 of `<t>.<raw body>` under the webhook's `secret`. Check it, and that `t` is recent, before you trust the body.",
          },
          {
            name: "X-Marfa-Event-Type",
            in: "header",
            required: true,
            schema: { type: "string", enum: [...WEBHOOK_EVENTS] },
            description: "The event, the same as `event_type` in the body.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: schemaRef("WebhookEvent") },
          },
        },
        responses: {
          "2XX": {
            description:
              "Marfa records the delivery as `success`. It doesn't read the response body.",
          },
          default: {
            description:
              "Any other answer is a failure. On a `3xx`, or a `4xx` other than `408` and `429`, the delivery becomes `dead_letter`. On a `408`, `429` or `5xx`, no answer within 10 seconds or no connection, Marfa tries again after at least 1, 5, 25, 125, 625, 3125 and 15625 seconds, and as long as `Retry-After` asks, up to 5 minutes. After 8 attempts, it's `dead_letter`.",
          },
        },
      },
    },
  };
}

const EXAMPLE_ITEM_ID = "0199a9c4-7c1e-7d3a-9f2b-3c4d5e6f7a8b";
const EXAMPLE_TIME = "2026-10-03T09:30:00.000Z";

/** A stream opened without a cursor, as it reads on the wire. */
export const STREAM_EXAMPLE = [
  ": connected",
  "",
  "event: stream_cursor",
  `data: ${JSON.stringify({ event_type: "stream_cursor", cursor: "1041" })}`,
  "",
  "event: stream_live",
  `data: ${JSON.stringify({ event_type: "stream_live", cursor: "1041" })}`,
  "",
  "id: 1042",
  "event: item.created",
  `data: ${JSON.stringify({
    event_type: "item.created",
    item: {
      id: EXAMPLE_ITEM_ID,
      type: "core.note",
      properties: {
        title: "Reading list",
        body: "Finish the chapter on tides.",
      },
      state: "active",
      tier: "library",
      version: 1,
      schema_version: 0,
      source: "notes-app",
      occurred_at: EXAMPLE_TIME,
      created_at: EXAMPLE_TIME,
      updated_at: EXAMPLE_TIME,
    },
    metadata: { item_id: EXAMPLE_ITEM_ID, tags: [], extensions: {} },
  })}`,
  "",
  "",
].join("\n");

/**
 * Where each operation stands in the reference: the groups in order, each
 * group's operations in order.
 */
const OPERATION_RANK: ReadonlyMap<string, number> = (() => {
  const rank = new Map<string, number>();
  for (const { operations } of PUBLIC_TAGS) {
    for (const id of operations) {
      if (!rank.has(id)) rank.set(id, rank.size);
    }
  }
  return rank;
})();

/**
 * Order `paths` by the first appearance of any of a path's operations in
 * `PUBLIC_TAGS`. A path whose methods fall in two groups stands where its
 * earliest operation does. A path with no listed operation goes last, in the
 * order it was registered, and the test that holds the lists to the document
 * fails for it.
 *
 * Route mounts in `app.ts` stay as they are: Hono matches in registration
 * order, and a static route such as `/items/stats` shares a prefix with a
 * parameter route.
 */
function orderPaths(
  paths: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const rankOf = (methods: Record<string, unknown>): number => {
    let first = Number.POSITIVE_INFINITY;
    for (const operation of Object.values(methods)) {
      const id = (operation as { operationId?: unknown } | null)?.operationId;
      const rank = typeof id === "string" ? OPERATION_RANK.get(id) : undefined;
      if (rank !== undefined && rank < first) first = rank;
    }
    return first;
  };
  const ranked = Object.entries(paths).map(([key, methods]) => ({
    key,
    methods,
    rank: rankOf(methods),
  }));
  ranked.sort((a, b) => (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1));
  return Object.fromEntries(ranked.map(({ key, methods }) => [key, methods]));
}

/** Shape the reflected document into the published public reference. */
export function finalizeOpenAPISpec<T extends OpenAPIDoc>(spec: T): T {
  // Keep the document the caller supplied separate from the additions.
  const sourcePaths = (spec.paths ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const nextPaths: Record<string, Record<string, unknown>> = {};
  for (const [pathKey, methods] of Object.entries(sourcePaths)) {
    const keptMethods: Record<string, unknown> = {};
    for (const [method, op] of Object.entries(methods)) {
      if (
        IDEMPOTENT_OPERATIONS.has(`${method} ${pathKey}`) &&
        op !== null &&
        typeof op === "object"
      ) {
        const operation = op as { parameters?: unknown[] };
        keptMethods[method] = {
          ...operation,
          parameters: [
            ...(operation.parameters ?? []),
            IDEMPOTENCY_HEADER_PARAM,
          ],
        };
        continue;
      }
      keptMethods[method] = op;
    }
    if (Object.keys(keptMethods).length > 0) {
      nextPaths[pathKey] = keptMethods;
    }
  }

  // Every registered operation is served through the same middleware.
  for (const [pathKey, methods] of Object.entries(nextPaths)) {
    const withHeaders: Record<string, unknown> = {};
    for (const [method, op] of Object.entries(methods)) {
      if (op === null || typeof op !== "object") {
        withHeaders[method] = op;
        continue;
      }
      const operation = op as Record<string, unknown>;
      const responses = {
        ...((operation.responses as Record<string, unknown> | undefined) ?? {}),
      };
      const conditionalRead =
        typeof operation.operationId === "string" &&
        CONDITIONAL_READ_OPERATIONS.has(operation.operationId);
      if (conditionalRead) {
        operation.parameters = [
          ...((operation.parameters as unknown[] | undefined) ?? []),
          REACH_PARAMETER,
        ];
      }
      if (conditionalRead || operation.operationId === "streamEvents") {
        responses["409"] =
          responses["409"] === undefined
            ? REACH_REFUSAL.response
            : withExtraBranch(responses["409"], REACH_REFUSAL);
      }
      if (declaresSecurity(operation)) {
        floorRefusal(responses, "401", CHAIN_REFUSALS.unauthorized);
      }
      // The body cap counts a body, and a GET or HEAD carries none to count.
      if (
        bodyCapFor(pathKey) !== "none" &&
        method !== "get" &&
        method !== "head"
      ) {
        floorRefusal(responses, "413", CHAIN_REFUSALS.requestTooLarge);
      }
      if (!AHEAD_OF_THE_LIMITER.has(`${method} ${pathKey}`)) {
        floorRefusal(responses, "429", CHAIN_REFUSALS.rateLimited);
      }
      if (declaresSecurity(operation)) {
        floorRefusal(responses, "503", CHAIN_REFUSALS.writeContention);
        floorRefusal(responses, "507", CHAIN_REFUSALS.insufficientStorage);
      }
      // Every door can meet a fault nothing foresaw, and the error handler
      // answers it alike on all of them. Registration is the exception: the
      // sign-in library serves it, and what it answers for a fault of its
      // own is not this server's envelope.
      if (pathKey !== "/auth/oauth2/register") {
        floorRefusal(responses, "500", CHAIN_REFUSALS.internalError);
      }
      if (namesInstance(method, pathKey)) {
        operation.parameters = [
          ...((operation.parameters as unknown[] | undefined) ?? []),
          INSTANCE_PARAMETER,
        ];
        for (const { status, refusal, merge } of INSTANCE_REFUSALS) {
          if (responses[status] === undefined) {
            responses[status] = refusal.response;
          } else if (merge === "branch") {
            responses[status] = withExtraBranch(responses[status], refusal);
          }
        }
      }
      if (IDEMPOTENT_OPERATIONS.has(`${method} ${pathKey}`)) {
        for (const { status, refusal, merge } of IDEMPOTENCY_REFUSALS) {
          if (responses[status] === undefined) {
            responses[status] = refusal.response;
          } else if (merge === "branch") {
            responses[status] = withExtraBranch(responses[status], refusal);
          }
        }
      }
      withHeaders[method] = withResponseHeaders(
        { ...operation, responses },
        IDEMPOTENT_OPERATIONS.has(`${method} ${pathKey}`),
        `${method} ${pathKey}`,
      );
    }
    nextPaths[pathKey] = withHeaders;
  }

  // The chain's own refusals, added only where no route already registered
  // the shape. `unauthorized` is registered by every door that declares it
  // itself, and a second object under one name is a component whose meaning
  // is whichever arrived first.
  const schemas: Record<string, unknown> = {
    ...((spec.components as { schemas?: Record<string, unknown> } | undefined)
      ?.schemas ?? {}),
  };
  for (const refusal of WRITTEN_REFUSALS) {
    schemas[refusal.name] ??= refusal.schema;
  }
  for (const [name, schema] of Object.entries(eventSchemas())) {
    if (name in schemas) throw new Error(`Schema ${name} is defined twice`);
    schemas[name] = schema;
  }

  spec.components = {
    ...(spec.components ?? {}),
    headers: RESPONSE_HEADER_COMPONENTS,
    schemas,
  };

  spec.paths = orderPaths(nextPaths);
  spec.webhooks = webhookRequests();
  spec.tags = PUBLIC_TAGS.map(({ name, description, operations }) => ({
    name,
    description,
    "x-operation-order": [...operations],
  }));
  return spec;
}
