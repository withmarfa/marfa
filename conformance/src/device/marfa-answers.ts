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
  };
}

export function withMetadata(
  item: Record<string, unknown>,
  tags: string[] = [],
): Record<string, unknown> {
  return { item, metadata: { tags } };
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
  options: { parent?: string; titleField?: string } = {},
): Record<string, unknown> {
  return {
    id,
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    label: id.split(".").at(-1),
    display_hints: { title_field: options.titleField ?? "title" },
    fields: {},
  };
}

/** The two types the device fixtures declare, and one subtype to prove a subtree. */
export function typeCatalog(): Answer {
  return {
    kind: "json",
    status: 200,
    body: [
      wireType("core.note"),
      wireType("core.file", { titleField: "title" }),
      wireType("core.file.image", { parent: "core.file", titleField: "title" }),
      wireType("core.bookmark", { titleField: "title" }),
    ],
  };
}

export function refusal(status: number, code: string, message: string): Answer {
  return { kind: "json", status, body: { error: { code, message } } };
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
  return {
    id,
    event: kind,
    data: { type: kind, item, metadata: { tags: options.tags ?? [] } },
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
  created: (item: Record<string, unknown>): Answer => ({
    kind: "json",
    status: 201,
    body: { item, metadata: { tags: [] } },
  }),
  updated: (item: Record<string, unknown>): Answer => ({
    kind: "json",
    status: 200,
    body: { item, metadata: { tags: [] } },
  }),
  resolved: (
    item: Record<string, unknown>,
    strategy: Record<string, string>,
    conflictedCopyId?: string,
  ): Answer => ({
    kind: "json",
    status: 200,
    body: {
      item,
      metadata: { tags: [] },
      conflict_resolution:
        conflictedCopyId === undefined
          ? { strategy }
          : { strategy, conflicted_copy_id: conflictedCopyId },
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
