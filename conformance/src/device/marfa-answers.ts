import type { Answer, RecordedRequest, SseFrame } from "./scripted-server.js";

/**
 * The bodies the scripted server gives back, in the shapes the real server
 * serves them.
 *
 * Every builder here is checked against a live server by `fidelity.test.ts`
 * for the cases a live server can be made to produce. The field names are the
 * ones the server serves at this commit, not the names the vocabulary settles
 * on: a fixture that renamed a field would be testing a server nobody runs.
 */

export interface WireItemOptions {
  id: string;
  type?: string;
  properties?: Record<string, unknown>;
  state?: string;
  tier?: string;
  version?: number;
  source?: string;
  source_id?: string | null;
  occurred_at?: string;
  created_at?: string;
  updated_at?: string;
  /** The edges the server hydrates onto the row, keyed by edge type. */
  edges?: Record<string, unknown>;
}

const EPOCH = "2026-09-18T00:00:00.000Z";

/** The source a served row carries where a fixture names none. */
export const SERVED_SOURCE = "device-fixtures";

export function wireItem(options: WireItemOptions): Record<string, unknown> {
  const at = options.occurred_at ?? EPOCH;
  return {
    id: options.id,
    type: options.type ?? "core.note",
    properties: options.properties ?? {
      title: options.id,
      body: `body of ${options.id}`,
    },
    state: options.state ?? "active",
    tier: options.tier ?? "library",
    version: options.version ?? 1,
    schema_version: 1,
    source: options.source ?? SERVED_SOURCE,
    // Omitted rather than null: the server leaves out a column it has nothing
    // for, and absent and null are two different things to a device.
    ...(options.source_id === undefined || options.source_id === null
      ? {}
      : { source_id: options.source_id }),
    occurred_at: at,
    created_at: options.created_at ?? at,
    updated_at: options.updated_at ?? at,
    // Present and empty, which is what the server answers for a row with no
    // edges. Absent would be a different thing to a device, and this is the
    // shape every door that returns an item returns.
    edges: options.edges ?? {},
  };
}

export interface WireEdgeOptions {
  id: string;
  source_id: string;
  target_id: string;
  edge_type?: string;
  version?: number;
  properties?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

/** An edge as the server answers one, on every door that returns an edge. */
export function wireEdge(options: WireEdgeOptions): Record<string, unknown> {
  return {
    id: options.id,
    source_id: options.source_id,
    target_id: options.target_id,
    edge_type: options.edge_type ?? "references",
    properties: options.properties ?? {},
    created_at: options.created_at ?? EPOCH,
    updated_at: options.updated_at ?? options.created_at ?? EPOCH,
    version: options.version ?? 1,
  };
}

export function withMetadata(
  item: Record<string, unknown>,
  tags: string[] = [],
  extensions: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    item,
    // `item_id` and `extensions` both, because the server answers both on
    // every door that carries metadata. A scripted block holding only tags
    // let a device read `metadata.item_id` and be green here.
    metadata: { item_id: item.id, tags, extensions },
  };
}

export function itemsPage(
  rows: Array<{ item: Record<string, unknown>; tags?: string[] }>,
  options: { nextCursor?: string } = {},
): Answer {
  return {
    kind: "json",
    status: 200,
    body: {
      data: rows.map((row) => withMetadata(row.item, row.tags ?? [])),
      next_cursor: options.nextCursor ?? null,
    },
  };
}

/**
 * A page of `GET /edges`, the listing a hydration walks for an edge type it
 * holds whole.
 */
export function edgesPage(
  edges: Array<Record<string, unknown>>,
  options: { nextCursor?: string } = {},
): Answer {
  return {
    kind: "json",
    status: 200,
    body: { data: edges, next_cursor: options.nextCursor ?? null },
  };
}

export function wireType(
  id: string,
  options: {
    parent?: string;
    titleField?: string;
    bodyField?: string;
    fields?: Record<string, unknown>;
    /** Which fields collide how. What decides whether a resolution names a
     *  sibling (`queue-and-verdicts.md` 11), so a scripted type without one
     *  describes a server that cannot keep both copies. */
    mergePolicy?: { fields: Record<string, string>; default: string };
  } = {},
): Record<string, unknown> {
  return {
    id,
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    label: id.split(".").at(-1),
    description: `the ${id} type`,
    version: 1,
    fields: options.fields ?? {
      title: { type: "string", description: "Heading or title" },
      body: { type: "string", description: "The body", required: true },
    },
    // `body_field` only where the type declares one. A default would put it
    // on every type, and the server puts it on the ones that have a body:
    // `core.entity.person` has none, so a scripted default is a hint a
    // device could read and not find.
    display_hints: {
      title_field: options.titleField ?? "title",
      ...(options.bodyField === undefined
        ? {}
        : { body_field: options.bodyField }),
    },
    merge_policy: options.mergePolicy ?? {
      fields: { body: "keep_both_copies" },
      default: "last_writer_wins",
    },
  };
}

/**
 * The types the device fixtures declare, as one list.
 *
 * One definition, read by the catalog the scripted server serves and by the
 * fidelity comparison that holds it against the real registry. Two copies is
 * how the catalog came to carry a `core.note` with two fields while the
 * comparison held a different one with two others, and neither noticed.
 */
export const SCRIPTED_TYPES: ReadonlyArray<Record<string, unknown>> = [
  wireType("core.note", {
    bodyField: "body",
    // The four the deployment seeds `core.note` with. Mirrored rather than
    // abbreviated: a device resolving a title field reads this registry, and
    // a scripted type thinner than the real one is a registry no server
    // serves.
    fields: {
      body: { type: "string", description: "The note text", required: true },
      title: { type: "string", description: "Heading or title" },
      language: {
        type: "string",
        description: "BCP 47 language code",
        format: "bcp47",
      },
      notes: { type: "string", description: "Personal annotations" },
    },
    mergePolicy: {
      fields: { body: "keep_both_copies", notes: "keep_both_copies" },
      default: "last_writer_wins",
    },
  }),
  // A body kept in a property other than `body`, as `core.event`'s is.
  wireType("core.event", {
    bodyField: "description",
    fields: {
      title: { type: "string", description: "Event name", required: true },
      description: { type: "string", description: "Event details" },
      starts_at: { type: "string", format: "datetime" },
    },
    mergePolicy: {
      fields: { notes: "keep_both_copies" },
      default: "last_writer_wins",
    },
  }),
  // A title kept in a property other than `title`, as `core.highlight`'s is.
  wireType("core.highlight", {
    titleField: "text",
    bodyField: "note",
    fields: {
      text: {
        type: "string",
        description: "The highlighted passage",
        required: true,
      },
      note: { type: "string", description: "User annotation on the highlight" },
    },
  }),
  wireType("core.file", { titleField: "title" }),
  wireType("core.file.image", { parent: "core.file", titleField: "title" }),
  wireType("core.bookmark", {
    titleField: "title",
    bodyField: "body",
    fields: {
      url: { type: "string", format: "url" },
      body: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
    },
  }),
];

/**
 * A registered type declaring a thumbnail (`device.md` 29). A function of
 * its id, because the fidelity comparison registers the same type on the
 * real server under an id of its own run.
 */
export function snapshotType(id = "user.snapshot"): Record<string, unknown> {
  // A registered type carries no description and no merge policy unless its
  // registration names them, and the shipped types have both.
  const {
    description: _description,
    merge_policy: _mergePolicy,
    ...row
  } = wireType(id, {
    titleField: "title",
    fields: {
      title: { type: "string" },
      thumbnail: { type: "thumbnail" },
    },
  });
  return row;
}

/** One scripted type by id, for a comparison against the served one. */
export function scriptedType(id: string): Record<string, unknown> {
  const found = SCRIPTED_TYPES.find((row) => row.id === id);
  if (found === undefined) {
    throw new Error(
      `no scripted type ${id}: a comparison against it would be against nothing`,
    );
  }
  return found;
}

/** The scripted types, and any a fixture registers beside them. */
export function typeCatalog(
  registered: ReadonlyArray<Record<string, unknown>> = [],
): Answer {
  return {
    kind: "json",
    status: 200,
    body: { data: [...SCRIPTED_TYPES, ...registered], next_cursor: null },
  };
}

/** An edge type as `GET /edge-types` lists it. */
export interface WireEdgeType {
  id: string;
  label?: string;
  cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  source_type_constraints: string[];
  target_type_constraints: string[];
  cascade_on_delete: "cascade" | "orphan" | "block";
  property_schema: Record<string, unknown>;
  reverse_name?: string;
  written_at: "source" | "target";
  shipped: boolean;
}

/**
 * An edge type as the listing answers one registered through
 * `POST /edge-types` (`edges.md` 18 and 20): every endpoint taken, orphaned
 * on delete, no properties and written at its source unless named.
 */
export function edgeType(
  id: string,
  options: Partial<Omit<WireEdgeType, "id">> = {},
): WireEdgeType {
  return {
    id,
    cardinality: "many-to-many",
    source_type_constraints: ["*"],
    target_type_constraints: ["*"],
    cascade_on_delete: "orphan",
    property_schema: {},
    written_at: "source",
    shipped: false,
    ...options,
  };
}

function shipped(
  id: string,
  label: string,
  options: Partial<Omit<WireEdgeType, "id" | "label" | "shipped">> = {},
): WireEdgeType {
  return edgeType(id, { label, shipped: true, ...options });
}

/** The shipped edge types as `GET /edge-types` lists them, which
 *  `fidelity.test.ts` holds to the real listing. */
export const SCRIPTED_EDGE_TYPES: ReadonlyArray<WireEdgeType> = [
  shipped("about", "About"),
  shipped("attached-to", "Attached to", { reverse_name: "has-attachment" }),
  shipped("authored-by", "Authored by"),
  shipped("derived-from", "Derived from"),
  shipped("in-collection", "In collection", {
    target_type_constraints: ["role:container"],
    property_schema: {
      position: {
        type: "number",
        description: "Ordering within the collection (1-based).",
      },
    },
  }),
  shipped("in-folder", "In folder", {
    target_type_constraints: ["system.folder"],
    property_schema: {
      path: {
        type: "string",
        description:
          "The file's path relative to the folder's root, with `/` between names; required, and it may not climb out of the folder. The edge takes no other property.",
      },
    },
  }),
  shipped("in-thread", "In thread", {
    cardinality: "many-to-one",
    property_schema: {
      position: {
        type: "number",
        description: "Ordering within the thread (1-based).",
      },
    },
  }),
  shipped("parent-of", "Parent of", {
    cardinality: "one-to-many",
    cascade_on_delete: "cascade",
    reverse_name: "child-of",
    written_at: "target",
  }),
  shipped("references", "References"),
  shipped("supersedes", "Supersedes", { cardinality: "one-to-one" }),
];

/** The shipped edge types, and any a fixture registers beside them. */
export function edgeTypeCatalog(
  registered: ReadonlyArray<WireEdgeType> = [],
): Answer {
  return {
    kind: "json",
    status: 200,
    body: { data: [...SCRIPTED_EDGE_TYPES, ...registered], next_cursor: null },
  };
}

export function refusal(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Answer {
  return {
    kind: "json",
    status,
    body: {
      error: { code, message, ...(details === undefined ? {} : { details }) },
    },
  };
}

export const connected: SseFrame = { comment: "connected" };

export function streamCursor(cursor: string): SseFrame {
  return { event: "stream_cursor", data: { type: "stream_cursor", cursor } };
}

/**
 * The frame that ends a replay, naming how far it reached, frames withheld
 * from this reader included. `null` where the server knew no position.
 */
export function streamLive(cursor: string | null): SseFrame {
  return { event: "stream_live", data: { type: "stream_live", cursor } };
}

export function itemEvent(
  id: string,
  kind: string,
  item: Record<string, unknown>,
  options: { tags?: string[] } = {},
): SseFrame {
  // The sidecar rides on every item frame, empty or not, so a device can learn
  // that a row's tags were cleared. A frame without it is a shape the server
  // does not send.
  // The frame publishes the stored row, and the stored row has no hydrated
  // edges: `edges` rides on the doors that were asked to include them and on
  // nothing else. Left on, a device could read a frame's edge block and find
  // nothing there in production.
  const { edges: _hydrated, ...stored } = item;
  return {
    id,
    event: kind,
    // The same metadata block every other door carries, built the same way.
    // A frame whose metadata held only tags is a shape the server does not
    // send.
    data: { type: kind, ...withMetadata(stored, options.tags ?? []) },
  };
}

/** An edge's event, as the server publishes it: the type and the edge. */
export function edgeEvent(
  id: string,
  kind: string,
  edge: Record<string, unknown>,
): SseFrame {
  return { id, event: kind, data: { type: kind, edge } };
}

export function catchupTooOld(
  minRetainedId: string,
  requested: string,
): SseFrame {
  // The frame carries the oldest retained id as its own `id:`, so a client
  // that stores the last id it saw cannot come back with a cursor the log
  // still cannot serve.
  return {
    id: minRetainedId,
    event: "catchup_too_old",
    data: {
      type: "catchup_too_old",
      min_retained_id: minRetainedId,
      requested,
    },
  };
}

/** The head read a hydration performs before it takes its snapshot. */
export function headRead(cursor: string): Answer {
  return { kind: "sse", frames: [connected, streamCursor(cursor)] };
}

/** A replay: the head, then the events after the cursor. */
export function replay(head: string, frames: SseFrame[]): Answer {
  return { kind: "sse", frames: [connected, streamCursor(head), ...frames] };
}

/**
 * A replay as a real server completes one: the head, the events after the
 * cursor, the marker naming how far the replay reached, and the stream held
 * open for what comes next. `replay` is a stream that ends before its marker.
 */
export function liveReplay(
  head: string,
  frames: SseFrame[],
  live: string | null = head,
): Answer {
  return {
    kind: "sse",
    hold: true,
    frames: [connected, streamCursor(head), ...frames, streamLive(live)],
  };
}

/**
 * A held stream that answers each request from the cursor it names, as the
 * server's log does: every frame after `Last-Event-ID`. A fixed answer would
 * give a device that opened the stream again either nothing or every frame
 * again, whatever it had taken, and neither is what the server does.
 */
export function heldLog(
  frames: SseFrame[],
): (request: RecordedRequest) => Answer {
  return (request) => {
    const after = BigInt(request.headers["last-event-id"] ?? "0");
    return {
      kind: "sse",
      hold: true,
      frames: [
        connected,
        ...frames.filter(
          (frame) => frame.id !== undefined && BigInt(frame.id) > after,
        ),
      ],
    };
  };
}

/**
 * A snapshot inside a 409 envelope, as the real server writes one.
 *
 * The three item fields are here because the version check covers them
 * (`versions.md` 8) and a collision can name one, so the envelope carries
 * both sides' values. `fidelity.test.ts` is what makes that a requirement
 * rather than a nicety: a field the real server sends and the scripted one
 * does not is a device read that goes green here and meets nothing there.
 */
export interface ConflictSnapshotBody {
  /** The row: a create names a natural key and not an id, and learns from
   *  this which row refused it (`queue-and-verdicts.md` 39). */
  id: string;
  version: number;
  properties: Record<string, unknown>;
  tier: "library" | "feed";
  occurred_at: string;
  source_id: string | null;
  /** The type the row had at this version: a stale move onto a row moved
   *  since collides on it, and the envelope shows both sides. */
  type: string;
}

/**
 * The two 409 envelopes, the refusals and the failures a device has to
 * classify. Named here rather than inline in a fixture so `fidelity.test.ts`
 * can hold every one of them against the real server's answer for the same
 * case.
 */
export const answers = {
  /** The root, answering the contract it is given. */
  root: (contract: unknown): Answer => ({
    kind: "json",
    status: 200,
    body: {
      name: "marfa",
      version: "dev",
      instance_id: "00000000-0000-7000-8000-000000000000",
      contract,
      features: ["items"],
    },
  }),
  created: (item: Record<string, unknown>, tags: string[] = []): Answer => ({
    kind: "json",
    status: 201,
    // Through `withMetadata` rather than a metadata block written here, so
    // the block a write answers with is the one every other door answers
    // with. A second hand-written copy drifts silently: it holds whichever
    // fields it was written with while the server answers the current set.
    body: withMetadata(item, tags),
  }),
  updated: (item: Record<string, unknown>, tags: string[] = []): Answer => ({
    kind: "json",
    status: 200,
    body: withMetadata(item, tags),
  }),
  /** A create whose natural key resolved a row the server holds: `200` and
   *  that row, under its own id, as an update answers (`items.md` 5). */
  upserted: (item: Record<string, unknown>, tags: string[] = []): Answer => ({
    kind: "json",
    status: 200,
    body: withMetadata(item, tags),
  }),
  /** A create naming an `id` that is not the row its natural key resolves:
   *  refused rather than written onto either row. */
  idNotTheKeys: (
    requestedId: string,
    existingId: string,
    source: string,
    sourceId: string,
  ): Answer =>
    refusal(
      400,
      "validation_error",
      "Request `id` does not match the item resolved by (source, source_id)",
      {
        field: "id",
        requested_id: requestedId,
        existing_id: existingId,
        source,
        source_id: sourceId,
      },
    ),
  resolved: (
    item: Record<string, unknown>,
    strategy: Record<string, string>,
    conflictedCopyId?: string,
  ): Answer => ({
    kind: "json",
    status: 200,
    body: {
      ...withMetadata(item),
      conflict_resolution: {
        // The fields that collided, which a device reports as what the
        // server resolved (`queue-and-verdicts.md` 10, 34). Derived from
        // the strategy rather than passed separately: the server answers
        // both and they name the same fields, so two arguments would let a
        // fixture script a resolution whose two halves disagreed.
        fields: Object.keys(strategy).sort(),
        strategy,
        ...(conflictedCopyId === undefined
          ? {}
          : { conflicted_copy_id: conflictedCopyId }),
      },
    },
  }),
  versionConflict: (
    current: ConflictSnapshotBody,
    ancestor: ConflictSnapshotBody,
    conflictingFields: string[],
    mergePolicy: { fields: Record<string, string>; default: string },
  ): Answer => ({
    kind: "json",
    status: 409,
    body: {
      error: {
        code: "version_conflict",
        message: "The item has been modified since the version you read",
        status: 409,
      },
      current,
      ancestor,
      conflicting_fields: conflictingFields,
      merge_policy: mergePolicy,
    },
  }),
  /** An edge the server already holds between the same two items under the
   *  same type, refused rather than made twice. */
  edgeDuplicate: (edge: {
    source_id: string;
    target_id: string;
    edge_type: string;
  }): Answer =>
    refusal(
      400,
      "edge_constraint_violation",
      `Edge "${edge.edge_type}" already exists between these items`,
      { ...edge, constraint: "duplicate" },
    ),
  /** A second edge at an end its type holds one at, a second parent say
   *  (`edges.md` 14). */
  edgeCardinality: (edge: { target_id: string; edge_type: string }): Answer =>
    refusal(
      400,
      "edge_constraint_violation",
      `Edge "${edge.edge_type}" is one-to-many on the target side; target already has an inbound edge of this type`,
      { ...edge, constraint: "cardinality" },
    ),
  /** An edge write refused by the edge type's half of the dual gate
   *  (`edges.md` 21). */
  edgePermissionDenied: (edgeType: string): Answer =>
    refusal(
      403,
      "edge_permission_denied",
      `Missing edge.${edgeType}:write permission`,
      { edge_type: edgeType, required: "write" },
    ),
  /** An edge update naming no properties and moving no end (`edges.md` 10). */
  edgeChangesNothing: (): Answer =>
    refusal(
      400,
      "missing_required_field",
      "properties is required where no end moves",
      { field: "properties" },
    ),
  /** An item read by id that the server does not hold, or holds of a type
   *  the key may not read (`keys-and-oauth.md` 20). */
  itemNotFound: (id: string): Answer =>
    refusal(404, "item_not_found", `Item ${id} not found`),
  /** An edge end a move names that the server does not hold (`edges.md` 10). */
  edgeEndNotFound: (end: "source" | "target", id: string): Answer =>
    refusal(404, "item_not_found", `Edge ${end} item not found: ${id}`),
  /** A move of an edge end whose type holds more than one at the end that
   *  stays (`edges.md` 10). */
  edgeMoveRefused: (
    field: "source_id" | "target_id",
    message: string,
  ): Answer =>
    refusal(400, "validation_error", message, {
      errors: [{ path: field, message }],
    }),
  /** `GET /keys/current`: the key the request bears, its edge grants and
   *  its type grants as named. */
  currentKey: (
    id: string,
    edgePermissions: Record<string, "read" | "write">,
    typePermissions: Record<string, "read" | "write" | "none"> = {
      "*": "write",
    },
  ): Answer => ({
    kind: "json",
    status: 200,
    body: {
      id,
      label: "device fixtures",
      source: SERVED_SOURCE,
      sources: [],
      permissions: [],
      default_tier: "library",
      is_operator: false,
      type_permissions: typePermissions,
      extension_permissions: {},
      edge_permissions: edgePermissions,
      metadata_permissions: {},
      created_at: EPOCH,
      expires_at: null,
      last_used_at: null,
    },
  }),
  /** A stale edge update: the edge as it now stands under `current`, and no
   *  ancestor, fields or policy, because an edge has no history to merge
   *  against (`versions.md` 16, 17). */
  edgeVersionConflict: (current: Record<string, unknown>): Answer => ({
    kind: "json",
    status: 409,
    body: {
      error: {
        code: "version_conflict",
        message: "The edge has been modified since the version you read",
        status: 409,
      },
      current,
    },
  }),
  ancestorUnavailable: (
    current: ConflictSnapshotBody,
    requestedVersion: number,
  ): Answer => ({
    kind: "json",
    status: 409,
    body: {
      error: {
        code: "ancestor_unavailable",
        message: "No snapshot is retained for the version named",
        status: 409,
      },
      current,
      requested_version: requestedVersion,
    },
  }),
  unauthorized: (): Answer =>
    refusal(401, "unauthorized", "Invalid or missing credential"),
  forbidden: (code: string): Answer =>
    refusal(403, code, "The credential does not reach this"),
  validation: (code: string, message: string): Answer =>
    refusal(400, code, message),
  keyReused: (): Answer =>
    refusal(
      422,
      "idempotency_key_reused",
      "This key was answered for a different request",
    ),
  serverFault: (): Answer =>
    refusal(500, "internal_error", "Something went wrong"),
  rateLimited: (): Answer => ({
    kind: "json",
    status: 429,
    headers: { "retry-after": "2" },
    body: { error: { code: "rate_limited", message: "Too many requests" } },
  }),
  dropped: (): Answer => ({ kind: "drop" }),
} as const;

/**
 * The answers the write doors that are not about an item's fields give.
 *
 * Four different shapes, and none of them carries an `item`. A device that
 * read every `2xx` against the item shape would take a tag, an edge, a
 * metadata write, an extension and a delete — every one of which the server
 * had already done — as an answer it could not read, count a refusal, and
 * kill the write on the fifth pass. Scripting them as items is what hid
 * exactly that, so these exist to be scripted instead.
 */
export const writeAnswers = {
  /** `POST /items/{id}/tags`, `DELETE /items/{id}/tags/{tag}` and both
   *  metadata doors: the sidecar, whole. */
  metadata: (itemId: string, tags: string[] = []): Answer => ({
    kind: "json",
    status: 200,
    body: { metadata: { item_id: itemId, tags, extensions: {} } },
  }),
  /** Both extension doors: the namespaces, whole. */
  extensions: (namespaces: Record<string, unknown> = {}): Answer => ({
    kind: "json",
    status: 200,
    body: { extensions: namespaces },
  }),
  /** `DELETE /items/{id}` and `DELETE /edges/{id}`. */
  ok: (): Answer => ({ kind: "json", status: 200, body: { ok: true } }),
  /** `POST /blobs`: the name the server gives the bytes it was sent. */
  uploaded: (hash: string, mimeType: string, size: number): Answer => ({
    kind: "json",
    status: 201,
    body: { hash, mime_type: mimeType, size_bytes: size },
  }),
  /** `GET /blobs/{hash}/url`: a link to the bytes, and its lifetime. */
  link: (url: string): Answer => ({
    kind: "json",
    status: 200,
    body: { url, expires_in: 3600 },
  }),
  /** `POST /edges`, which answers `201`, and `PATCH /edges/{id}`, which
   *  answers `200`. */
  edge: (edge: WireEdgeOptions, status: 200 | 201 = 201): Answer => ({
    kind: "json",
    status,
    body: { edge: wireEdge(edge) },
  }),
  /** `POST /edges` naming the id of an edge the server holds between the
   *  same two items under the same type: a repeat, answered with the edge as
   *  it stands and nothing written. */
  edgeRepeated: (edge: WireEdgeOptions): Answer => ({
    kind: "json",
    status: 200,
    body: { edge: wireEdge(edge), acknowledged: true },
  }),
};
