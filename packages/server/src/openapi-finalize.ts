/**
 * Final shaping of the generated OpenAPI document for the public reference.
 *
 * `app.getOpenAPI31Document()` reflects every registered `createRoute`, in
 * registration order, with no top-level tag list and no operations for the
 * routes defined as plain Hono handlers. This pass makes the published spec
 * a deliberate, consumer-facing shape:
 *
 *   1. Sets an ordered, described top-level `tags` list (resources first).
 *   2. Strips platform-internal operations (the blob link target). They still serve — they are simply not part of the
 *      public reference.
 *   3. Injects the routes defined as plain Hono handlers (the instance
 *      root, the SSE stream and OAuth dynamic client registration), which
 *      the reflection cannot see.
 *   4. Adds the stream's frames and the request Marfa sends to a webhook,
 *      which no route declares.
 *
 * Both the live `/openapi.json` endpoint (`app.ts`) and the committed
 * `openapi.json` (`scripts/generate-openapi.ts`) call this, so the two never
 * drift.
 */

import { CONDITIONAL_READ_OPERATIONS } from "./middleware/read-view.js";
import { IDEMPOTENT_WRITE_DOORS } from "./middleware/idempotency.js";
import {
  IDEMPOTENCY_IN_FLIGHT,
  REFUSAL_TEXT,
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

/**
 * The reference's groups, in sidebar order.
 *
 * Every name here must be carried by at least one published operation. A tag
 * describing a surface no operation belongs to reads as a surface the server
 * has and is withholding, which is the same defect as advertising a feature
 * with no door behind it.
 */
const PUBLIC_TAGS = [
  { name: "Items", description: "The records Marfa stores, each of a type." },
  {
    name: "Bulk actions",
    description:
      "One change applied to every item a filter matches, run as a job you can follow and cancel.",
  },
  { name: "Metadata", description: "An item's tags, and the tags in use." },
  {
    name: "Extensions",
    description: "JSON objects attached to an item, one per namespace.",
  },
  {
    name: "Edges",
    description: "Typed, directed relationships between items.",
  },
  {
    name: "Types",
    description:
      "The types items can have: those Marfa ships and those registered on this instance.",
  },
  {
    name: "Edge types",
    description:
      "The types edges can have, each with its cardinality and cascade rule.",
  },
  {
    name: "Blobs",
    description: "Bytes stored by content hash, and the stores that hold them.",
  },
  {
    name: "Folders",
    description: "A folder's settings, held as a `system.folder` item.",
  },
  { name: "Search", description: "Full-text search across items." },
  {
    name: "Event stream",
    description: "Changes to items and edges, streamed as they happen.",
  },
  {
    name: "Webhooks",
    description:
      "Changes sent to a URL you choose, and each delivery's record.",
  },
  {
    name: "Connectors",
    description:
      "Processes outside the server that read and write on your behalf, and what the instance keeps for them.",
  },
  {
    name: "Access",
    description:
      "API keys, the instance's owner and OAuth client registration.",
  },
  {
    name: "Instance",
    description:
      "The instance itself: what it is, its configuration, its housekeeping jobs and its audit log.",
  },
  {
    name: "Export and restore",
    description: "Export the instance's data, and restore it from an archive.",
  },
];

/**
 * Operations excluded from the public reference, by operationId. These are
 * platform-internal — they still serve, but app developers never call them.
 * A new internal route adds its operationId here.
 */
export const INTERNAL_OPERATION_IDS = new Set<string>([
  // blobs.ts — the target of an instance-served link, which
  // `GET /blobs/{hash}/url` hands out; nothing calls it by name
  "fetchBlob",
]);

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
  "X-Marfa-Read-View": {
    description:
      "A matching opaque read-view certificate, supplied only after a conditional copy read and its snapshot have completed. Successful conditional reads and snapshot-attributed resource refusals carry it with Cache-Control: no-store. Ordinary reads and write receipts carry none.",
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
 * No route declares these, so they are written out rather than reflected;
 * `openapi-published.test.ts` compares each against a reflected
 * `makeErrorResponseSchema(codes)` so the two cannot drift.
 */
export interface ChainRefusal {
  codes: readonly [string, ...string[]];
  name: string;
  schema: Record<string, unknown>;
  response: Record<string, unknown>;
}

const WRITTEN_REFUSALS: ChainRefusal[] = [];

function chainRefusal(
  codes: readonly [string, ...string[]],
  description: string,
): ChainRefusal {
  const name = refusalComponentName(codes);
  const refusal: ChainRefusal = {
    codes,
    name,
    schema: {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: {
            code: {
              type: "string",
              enum: [...codes].sort(),
              description: REFUSAL_TEXT.code,
            },
            message: { type: "string", description: REFUSAL_TEXT.message },
            details: {
              type: "object",
              additionalProperties: {},
              description: REFUSAL_TEXT.details,
            },
          },
          required: ["code", "message"],
          description: REFUSAL_TEXT.error,
        },
      },
      required: ["error"],
      description: REFUSAL_TEXT.refusal,
    },
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

const UNDECLARED_QUERY_REFUSAL = chainRefusal(
  ["validation_error"],
  "`validation_error`: the query has a parameter this endpoint doesn't take.",
);

const READ_VIEW_REFUSAL = chainRefusal(
  ["read_view_changed"],
  "`read_view_changed`: the read view in `X-Marfa-Read-View` has changed. Rebuild the working copy.",
);
const READ_VIEW_PARAMETER = {
  name: "X-Marfa-Read-View",
  in: "header",
  required: false,
  schema: {
    type: "string",
    pattern: "^[0-9a-f]{64}$",
    minLength: 64,
    maxLength: 64,
  },
  description:
    "A read-view certificate from a copy stream, for a working copy. Marfa reads the current data and checks the view in one snapshot, and returns `409 read_view_changed` if the view has changed. Leave it out for an ordinary read.",
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
      names.push("X-Marfa-Read-View");
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
const COPY_READ_VIEW = {
  type: "string",
  description:
    "Only on a copy stream: the read view to send as `X-Marfa-Read-View`, to resume or to read the working copy's data.",
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
        "An item event: a change to an item, or, as `metadata.changed`, to its tags or extensions.",
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
        "An edge event: a change to an edge. You receive it only if you can read both the edge type and `source_type`.",
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
        read_view: COPY_READ_VIEW,
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
        read_view: COPY_READ_VIEW,
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
    ReadViewChangedFrame: {
      type: "object",
      description:
        "The last frame of a copy stream, with no `id:`, when its read view changes, such as after a retype or a narrowed key. Rebuild the working copy.",
      properties: { event_type: marker("read_view_changed") },
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
        "ReadViewChangedFrame",
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
        summary: "Receive an event",
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
const STREAM_EXAMPLE = [
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
 * Consumer routes defined as plain Hono handlers, invisible to the
 * `createRoute` reflection. Documented here so the reference is complete.
 *
 * Their refusals are written out for the same reason the route is: there is
 * no `createRoute` to reflect one from.
 */
export const EXTRA_PATHS: Record<string, Record<string, unknown>> = {
  "/": {
    get: {
      operationId: "getInstance",
      tags: ["Instance"],
      summary: "Describe the instance",
      description:
        "Describes the instance: its `instance_id`, the build it runs, the contract version it speaks and the features it serves. Needs no credential.",
      responses: {
        "400": UNDECLARED_QUERY_REFUSAL.response,
        "200": {
          description:
            "Returns the instance's description. A request whose `Accept` header prefers `text/html` gets an HTML page instead.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    const: "marfa",
                    description: "Always `marfa`.",
                  },
                  version: {
                    type: "string",
                    description: "The build the instance runs.",
                  },
                  instance_id: {
                    type: "string",
                    description:
                      "Unique identifier for the instance. `GET /config` and an archive's manifest show the same value.",
                  },
                  contract: {
                    type: "integer",
                    minimum: 0,
                    description:
                      "The contract version, the same number as this document's `info.version`. It stays at `0` until the first public release.",
                  },
                  features: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "The features the instance serves, such as `items` and `webhooks`.",
                  },
                },
                required: [
                  "name",
                  "version",
                  "instance_id",
                  "contract",
                  "features",
                ],
              },
            },
          },
        },
      },
    },
  },
  "/events": {
    get: {
      operationId: "streamEvents",
      tags: ["Event stream"],
      summary: "Stream change events",
      description:
        "Opens a Server-Sent Events stream of the changes to items and edges that you can read. Send `Last-Event-ID` to resume after a disconnect, or `copy=1` to follow a working copy.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "copy",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["1"] },
          description:
            "Set to `1` for a copy stream, which a working copy follows. It takes `edges=all` and no other parameter. Its `stream_cursor` and `stream_live` carry `instance_id` and `read_view`, and its item frames carry `listed`.",
        },
        {
          ...READ_VIEW_PARAMETER,
          description:
            "On a copy stream, the `read_view` from the last `stream_cursor` or `stream_live` you received. Send it with `Last-Event-ID` to resume, and leave both out to start a new copy.",
        },
        {
          name: "type",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Only send item events for these types and their subtypes: a comma-separated list of up to 10, such as `core.note,app.*`. A pattern matches the types you can read. Edge events aren't filtered. Leave it out for every type.",
        },
        {
          name: "edges",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["all", "none"], default: "all" },
          description:
            "Set to `none` to leave out edge events. You receive an edge event only if you could read the edge with `GET /edges/{id}`.",
        },
        {
          name: "Last-Event-ID",
          in: "header",
          required: false,
          schema: { type: "string" },
          description:
            "The ID of the last event you received. Marfa replays every event after it that the log still holds, then goes live. Send it as the stream wrote it. Empty means none, except on a copy stream.",
        },
      ],
      responses: {
        "200": {
          description:
            "Returns the stream. Each frame's `event:` names it:\n- `stream_cursor`: first, where the log stands.\n- An event, such as `item.created`, with its event ID as `id:`.\n- `stream_live`: once the catch-up is over.\n- `stream_incomplete`, `catchup_too_old`, `cursor_ahead` or `read_view_changed`: last, before the stream closes.",
          content: {
            "text/event-stream": {
              schema: { $ref: "#/components/schemas/EventStreamFrame" },
              example: STREAM_EXAMPLE,
            },
          },
        },
        "400": chainRefusal(
          ["validation_error", "unknown_type"],
          "- `validation_error`: a parameter or header is invalid, or not one this endpoint takes. For example, `type` has more than 10 entries or is `*`, or `Last-Event-ID` isn't an event ID. A copy stream takes only `copy=1` and `edges=all`, and both resume headers or neither; another stream takes no `X-Marfa-Read-View`.\n- `unknown_type`: a `type` entry isn't registered.",
        ).response,
        "403": chainRefusal(
          ["type_not_permitted"],
          "- `type_not_permitted`: you can't read any type, or a `type` entry names a type you can't read, with no subtype you can.",
        ).response,
        "503": chainRefusal(
          ["stream_capacity_exhausted", "write_contention"],
          `- \`stream_capacity_exhausted\`: the instance is serving as many streams as its operator allows. Try again later.\n- ${WRITE_CONTENTION_TEXT}`,
        ).response,
      },
    },
  },
  "/auth/oauth2/register": {
    post: {
      operationId: "registerOAuthClient",
      tags: ["Access"],
      summary: "Register an OAuth client",
      description:
        "Registers an OAuth client for an app and returns it with its `client_id`. Send no credential. The `client_credentials` grant isn't available: a program that acts for no person uses an API key.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                redirect_uris: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "The addresses Marfa may send a person back to after authorization. Required for `authorization_code`. A `web` client's URIs must use `https` off the loopback; a `native` client may use `http` on `localhost`, `127.0.0.1` or `[::1]`.",
                },
                grant_types: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "The grants the client uses: `authorization_code`, `refresh_token` or `urn:ietf:params:oauth:grant-type:device_code`. Defaults to `authorization_code`. Without `authorization_code`, add `refresh_token` to get a refresh token with `offline_access`.",
                },
                response_types: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "The response types the client uses. Defaults to `code` when `grant_types` includes `authorization_code`.",
                },
                client_name: {
                  type: "string",
                  description:
                    "The app's name, which Marfa shows a person asked to approve it.",
                },
                application_type: {
                  type: "string",
                  description:
                    "`web` or `native`, which decides the redirect URIs the client may use. Defaults to `web`.",
                },
                scope: {
                  type: "string",
                  description:
                    "Space-separated scopes to register the client for. `offline_access` needs `refresh_token` or `authorization_code` in `grant_types`. Leave it out to register the client for every scope the instance allows that it can use.",
                },
                token_endpoint_auth_method: {
                  type: "string",
                  description:
                    "How the client proves itself at the token endpoint. Defaults to `client_secret_basic`. Send `none` for a public client, which gets no `client_secret`.",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description:
            "Returns the registered client, with its `client_id` and, unless it's a public client, its `client_secret`.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  client_id: {
                    type: "string",
                    description: "Unique identifier for the client.",
                  },
                  client_secret: {
                    type: "string",
                    description:
                      "The secret the client proves itself with at the token endpoint. Absent for a public client.",
                  },
                  client_id_issued_at: {
                    type: "integer",
                    description:
                      "When the client was registered, in seconds since the Unix epoch.",
                  },
                  scope: {
                    type: "string",
                    description:
                      "Space-separated scopes the client is registered for: the ones you named, or every scope the instance allows, without `offline_access` for a client that can't use a refresh token.",
                  },
                  redirect_uris: {
                    type: "array",
                    items: { type: "string" },
                    description: "The redirect URIs, as registered.",
                  },
                  grant_types: {
                    type: "array",
                    items: { type: "string" },
                    description: "The grants, as registered.",
                  },
                  response_types: {
                    type: "array",
                    items: { type: "string" },
                    description: "The response types, as registered.",
                  },
                  token_endpoint_auth_method: {
                    type: "string",
                    description:
                      "How the client proves itself at the token endpoint.",
                  },
                  client_secret_expires_at: {
                    type: "integer",
                    description:
                      "When the secret expires, in seconds since the Unix epoch, or `0` if it doesn't.",
                  },
                  client_name: {
                    type: "string",
                    description: "The app's name, as registered.",
                  },
                  application_type: {
                    type: "string",
                    description: "`web` or `native`.",
                  },
                  disabled: {
                    type: "boolean",
                    description: "`true` if the client is disabled.",
                  },
                  dpop_bound_access_tokens: {
                    type: "boolean",
                    description:
                      "`true` if the client always uses DPoP for its token requests.",
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "An error in the shape RFC 7591 defines:\n- `invalid_client_metadata`: a field is invalid, such as `grant_types` naming `client_credentials`.\n- `invalid_redirect_uri`: a redirect URI is missing, malformed or not allowed for the `application_type`.\n- `invalid_scope`: `scope` names a scope the instance doesn't allow.\n\nAn unknown query parameter gets Marfa's own `validation_error` instead.",
          content: {
            "application/json": {
              schema: {
                anyOf: [
                  {
                    $ref: `#/components/schemas/${UNDECLARED_QUERY_REFUSAL.name}`,
                  },
                  {
                    type: "object",
                    properties: {
                      error: {
                        type: "string",
                        enum: [
                          "invalid_client_metadata",
                          "invalid_redirect_uri",
                          "invalid_scope",
                        ],
                      },
                      error_description: { type: "string" },
                    },
                    required: ["error"],
                  },
                ],
              },
            },
          },
        },
        "401": {
          description:
            "An error in the shape RFC 6750 defines:\n- `invalid_token`: the request sends a bearer token, such as an API key. Register with no credential.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: { type: "string", enum: ["invalid_token"] },
                  error_description: { type: "string" },
                },
                required: ["error"],
              },
            },
          },
        },
        "415": {
          description:
            "An error with `message` and `code`, rather than Marfa's own shape:\n- `UNSUPPORTED_MEDIA_TYPE`: the request doesn't send its body as `application/json`.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  code: {
                    type: "string",
                    enum: ["UNSUPPORTED_MEDIA_TYPE"],
                    description: REFUSAL_TEXT.code,
                  },
                  message: {
                    type: "string",
                    description: REFUSAL_TEXT.message,
                  },
                },
                required: ["code", "message"],
              },
            },
          },
        },
        // Declared here rather than by the floor, which hangs it off a
        // door's `security`, and this door has none: the registration is
        // still a write, and it meets the write lock as any other does.
        "503": CHAIN_REFUSALS.writeContention.response,
      },
    },
  },
};

/** Shape the reflected document into the published public reference. */
export function finalizeOpenAPISpec<T extends OpenAPIDoc>(spec: T): T {
  spec.tags = PUBLIC_TAGS;

  // Build a new paths object excluding internal operations, rather than
  // deleting keys in place (cleaner, and avoids dynamic-delete).
  const sourcePaths = (spec.paths ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const nextPaths: Record<string, Record<string, unknown>> = {};
  for (const [pathKey, methods] of Object.entries(sourcePaths)) {
    const keptMethods: Record<string, unknown> = {};
    for (const [method, op] of Object.entries(methods)) {
      const operationId = (op as { operationId?: unknown } | null)?.operationId;
      if (
        typeof operationId === "string" &&
        INTERNAL_OPERATION_IDS.has(operationId)
      ) {
        continue;
      }
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

  // Inject the plain-Hono consumer routes the reflection can't see.
  for (const [pathKey, def] of Object.entries(EXTRA_PATHS)) {
    nextPaths[pathKey] = { ...(nextPaths[pathKey] ?? {}), ...def };
  }

  // Declare the middleware-set response headers, last so that the injected
  // routes above are covered too: they are served through the same logger
  // as everything else, and a client reading the reference has no way to
  // know which routes the reflection happened to see.
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
          READ_VIEW_PARAMETER,
        ];
      }
      if (conditionalRead || operation.operationId === "streamEvents") {
        responses["409"] =
          responses["409"] === undefined
            ? READ_VIEW_REFUSAL.response
            : withExtraBranch(responses["409"], READ_VIEW_REFUSAL);
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

  spec.paths = nextPaths;
  spec.webhooks = webhookRequests();
  return spec;
}
