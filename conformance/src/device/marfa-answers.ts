import type { Answer, SseFrame } from "./scripted-server.js";

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
    source: options.source ?? "device-fixtures",
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
  options: { cursor?: string; hasMore?: boolean } = {},
): Answer {
  return {
    kind: "json",
    status: 200,
    body: {
      data: rows.map((row) => withMetadata(row.item, row.tags ?? [])),
      cursor: options.cursor ?? null,
      has_more: options.hasMore ?? false,
    },
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
  wireType("core.file", { titleField: "title" }),
  wireType("core.file.image", { parent: "core.file", titleField: "title" }),
  wireType("core.bookmark", { titleField: "title" }),
];

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

export function typeCatalog(): Answer {
  return { kind: "json", status: 200, body: [...SCRIPTED_TYPES] };
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
 * The two 409 envelopes, the refusals and the failures a device has to
 * classify. Named here rather than inline in a fixture so `fidelity.test.ts`
 * can hold every one of them against the real server's answer for the same
 * case.
 */
export const answers = {
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
    current: { version: number; properties: Record<string, unknown> },
    ancestor: { version: number; properties: Record<string, unknown> },
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
  ancestorUnavailable: (
    current: { version: number; properties: Record<string, unknown> },
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
  /** `POST /edges` and `PATCH /edges/{id}`. */
  edge: (edge: {
    id: string;
    source_id: string;
    target_id: string;
    edge_type?: string;
    version?: number;
    properties?: Record<string, unknown>;
  }): Answer => ({
    kind: "json",
    status: 201,
    body: {
      edge: {
        id: edge.id,
        source_id: edge.source_id,
        target_id: edge.target_id,
        edge_type: edge.edge_type ?? "references",
        properties: edge.properties ?? {},
        created_at: EPOCH,
        updated_at: EPOCH,
        version: edge.version ?? 1,
      },
    },
  }),
};
