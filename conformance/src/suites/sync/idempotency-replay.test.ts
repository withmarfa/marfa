import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { MarfaClient } from "../../client/api.js";
import type {
  ApiKeyRequest,
  ApiResponse,
  BulkActionJob,
  BulkResponse,
  MarfaEdge,
  MarfaItem,
  TestContext,
} from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getManagementClient,
  trackEdge,
  trackEdgeType,
  trackFolder,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import { detectSyncCapabilities, requireRule } from "./capabilities.js";

/**
 * A retained answer is replayed only while the credential asking again is
 * still authorized for everything that answer did and disclosed.
 *
 * `idempotency.test.ts` holds that a repeat is the first write's answer. Here
 * the credential is narrowed between the first request and the repeat with
 * `PATCH /keys/{id}`, so a repeat that is served from the record without a
 * second look at the grants would hand back what the key can no longer see or
 * do. A refused repeat is not a replay: it carries no `Idempotency-Replayed`
 * header, it writes and announces nothing, and it keeps the record, so
 * restoring the grant gets the first answer back with the first status.
 *
 * Each case narrows by the one grant under test and leaves the rest of the
 * key whole, so the refusal can only be that grant's. Each also shows the
 * repeat replays before the narrowing, which is what gives the refusal its
 * meaning: a server that refused every repeat would pass the refusal alone.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let operator: MarfaClient;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "sync",
    "idempotency-replay",
  ));
  const caps = await detectSyncCapabilities({ client, ctx, apiUrl, apiKey });
  requireRule(caps, "idempotencyKeys");
  operator = getManagementClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

type Method = "POST" | "PATCH" | "DELETE" | "PUT";
type Answer = ApiResponse<unknown>;

interface Actor {
  id: string;
  source: string;
  client: MarfaClient;
}

let minted = 0;

/** A key that holds every grant the cases narrow, under a source of its own. */
async function mint(overrides: Partial<ApiKeyRequest> = {}): Promise<Actor> {
  const label = `replay-${String(++minted)}`;
  const source = `${ctx.source}-${label}`;
  const key = await client.createKey({
    label,
    source,
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
    extension_permissions: { "*": "write" },
    permissions: ["items.purge"],
    ...overrides,
  });
  expect(key.ok, JSON.stringify(key.error)).toBe(true);
  trackKey(ctx, key.data.id);
  return {
    id: key.data.id,
    source,
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: key.data.key }),
  };
}

/** Changing a key's `sources` enforcement requires config.manage. */
async function grant(
  actor: Actor,
  changes: Partial<ApiKeyRequest>,
  by: MarfaClient = client,
): Promise<void> {
  const changed = await by.updateKey(actor.id, changes);
  expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
}

/** The same request under one fresh key, each time it is called. */
function keyed(
  actor: Actor,
  method: Method,
  path: string,
  body?: unknown,
): () => Promise<Answer> {
  const headers = { "Idempotency-Key": `replay-${randomUUID()}` };
  return () =>
    actor.client.rawRequest<unknown>(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: body as Record<string, unknown> }),
    });
}

function replayedHeader(answer: Answer): string | null {
  return answer.headers.get("Idempotency-Replayed");
}

/** The first answer to a key: written, so nothing marks it a replay. */
function expectFirst(answer: Answer, status: number): void {
  expect(
    answer.status,
    `the first request was refused: ${JSON.stringify(answer.error)}`,
  ).toBe(status);
  expect(
    replayedHeader(answer),
    "a first answer announced itself as a replay",
  ).toBeNull();
}

/** The first answer again, with its status and body, marked as a replay. */
function expectReplay(answer: Answer, first: Answer): void {
  expect(
    answer.status,
    `the repeat was not replayed: ${JSON.stringify(answer.error)}`,
  ).toBe(first.status);
  expect(replayedHeader(answer)).toBe("true");
  expect(answer.data).toEqual(first.data);
}

/** A refused repeat: its own status and code, and no replay marker. */
function expectRefused(answer: Answer, status: number, code: string): void {
  expect(
    answer.status,
    `the repeat was not refused: ${JSON.stringify(answer.data)}`,
  ).toBe(status);
  expect(answer.error?.error.code).toBe(code);
  expect(
    replayedHeader(answer),
    "a refused repeat announced itself as a replay",
  ).toBeNull();
}

function text(answer: Answer): string {
  return JSON.stringify(answer.data);
}

function itemOf(answer: Answer): MarfaItem {
  return (answer.data as { item: MarfaItem }).item;
}

function edgeOf(answer: Answer): MarfaEdge {
  return (answer.data as { edge: MarfaEdge }).edge;
}

async function note(
  properties: Record<string, unknown> = {
    title: "Original",
    body: "Retained body",
  },
  extra: { tags?: string[] } = {},
): Promise<MarfaItem> {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties,
    ...extra,
  });
  expect(made.status).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item;
}

async function task(title = "A task"): Promise<MarfaItem> {
  const made = await client.createItem({
    type: "core.task",
    source: ctx.source,
    properties: { title },
  });
  expect(made.status).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item;
}

async function link(
  source_id: string,
  target_id: string,
  edge_type: string,
  properties?: Record<string, unknown>,
): Promise<MarfaEdge> {
  const made = await client.createEdge({
    source_id,
    target_id,
    edge_type,
    ...(properties === undefined ? {} : { properties }),
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackEdge(ctx, made.data.edge.id);
  return made.data.edge;
}

async function blockingEdgeType(): Promise<string> {
  const id = `replay.blocks.${ctx.runId}`;
  const found = await client.listEdgeTypes();
  if (!found.data.data.some((t) => t.id === id)) {
    const registered = await client.registerEdgeType({
      id,
      cardinality: "many-to-many",
      cascade_on_delete: "block",
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackEdgeType(ctx, id);
  }
  return id;
}

function listsIdempotencyKey(
  paths: Record<string, unknown>,
  path: string,
  method: string,
): boolean {
  const operation = (
    paths[path] as Record<string, { parameters?: { name: string }[] }>
  )[method.toLowerCase()];
  return (operation.parameters ?? []).some((p) => p.name === "Idempotency-Key");
}

describe("a retained answer after its credential is narrowed", () => {
  it("refuses a replay 403 type_not_permitted to a key that now only reads the type, and replays once write returns", async () => {
    const actor = await mint();
    const item = await note();
    const ask = keyed(actor, "PATCH", `/items/${item.id}`, {
      version: item.version,
      properties: { title: "Changed" },
    });
    const first = await ask();
    expectFirst(first, 200);
    expectReplay(await ask(), first);

    await grant(actor, { type_permissions: { "core.note": "read" } });
    const readable = await actor.client.getItem(item.id);
    expect(readable.status, "the key can no longer read the row").toBe(200);
    expectRefused(await ask(), 403, "type_not_permitted");

    await grant(actor, { type_permissions: { "core.note": "write" } });
    const restored = await ask();
    expectReplay(restored, first);
    expect(restored.status).toBe(200);
    expect((await client.getItem(item.id)).data.item.version).toBe(
      itemOf(first).version,
    );
  });

  it("writes and announces nothing on a refused replay", async ({ signal }) => {
    const actor = await mint();
    const tag = `replay-quiet-${ctx.runId}`;
    const ask = keyed(actor, "POST", "/items", {
      type: "core.note",
      tags: [tag],
      properties: { title: "Quiet", body: "Retained body" },
    });
    let first!: Answer;
    let refused!: Answer;
    let retyped!: ApiResponse<{ item: MarfaItem }>;
    let sentinel = "";
    const frames = await withStream(apiUrl, apiKey, {}, async (stream) => {
      await collectUntil(
        stream,
        (events) => events.some((e) => e.event === "stream_live"),
        "the stream to go live",
        signal,
      );
      first = await ask();
      expectFirst(first, 201);
      trackItem(ctx, itemOf(first).id);
      // A row retyped out from under the retained answer is a refusal a
      // second run of the create would not share: the key still writes a
      // note, so running it again would make a second row.
      retyped = await client.updateItem(itemOf(first).id, {
        version: itemOf(first).version,
        type: "core.task",
        retype: true,
      });
      expect(retyped.status, JSON.stringify(retyped.error)).toBe(200);
      await grant(actor, { type_permissions: { "core.note": "write" } });
      refused = await ask();
      sentinel = (
        await note({ title: "Sentinel", body: "after" }, { tags: [tag] })
      ).id;
      return (
        await collectUntil(
          stream,
          (events) =>
            events.some(
              (e) => (e.data as { item?: MarfaItem }).item?.id === sentinel,
            ),
          `sentinel ${sentinel}`,
          signal,
        )
      ).events;
    });

    expectRefused(refused, 404, "item_not_found");

    const row = itemOf(first).id;
    const about = (events: SseEvent[]) =>
      events.filter((e) => JSON.stringify(e.data).includes(row));
    expect(
      about(frames).map((e) => e.event),
      "the stream carried the create and the retype, and nothing for the refused repeat",
    ).toEqual(["item.created", "item.updated"]);
    expect(
      frames.filter(
        (e) =>
          e.event === "item.created" &&
          (e.data as { item: MarfaItem }).item.source === actor.source,
      ),
    ).toHaveLength(1);

    const after = await client.getItem(row);
    expect(after.data.item.type).toBe("core.task");
    expect(after.data.item.version).toBe(retyped.data.item.version);
    const written = await client.listItems({
      source: actor.source,
      state: "any",
      limit: 100,
    });
    expect(written.data.next_cursor).toBeNull();
    expect(written.data.data.map((i) => i.id)).toEqual([row]);

    // The witness: the key could have written, so a refusal that wrote
    // nothing is the replay guard's and not a missing grant's.
    const fresh = await actor.client.createItem({
      type: "core.note",
      properties: { title: "Quiet", body: "Retained body" },
    });
    expect(fresh.status).toBe(201);
    trackItem(ctx, fresh.data.item.id);
  });

  it("refuses a purge replay once the key no longer holds items.purge", async () => {
    const actor = await mint();
    const item = await note();
    expect((await actor.client.deleteItem(item.id)).status).toBe(200);
    const ask = keyed(actor, "POST", `/items/${item.id}/purge`);
    const first = await ask();
    expectFirst(first, 200);
    expect(
      (await client.getItem(item.id)).status,
      "the row is gone, so only the record can answer the repeat",
    ).toBe(404);
    expectReplay(await ask(), first);

    await grant(actor, { permissions: [] });
    const refused = await ask();
    expectRefused(refused, 403, "forbidden");
    expect(refused.error?.error.details?.required_scope).toBe("items.purge");

    await grant(actor, { permissions: ["items.purge"] });
    expectReplay(await ask(), first);
  });

  it("refuses a replay once the key no longer claims the source the write named, naming the source", async () => {
    const actor = await mint();
    const source = `${ctx.source}-claimed-create`;
    await grant(actor, { sources: [source] }, operator);
    const ask = keyed(actor, "POST", "/items", {
      type: "core.note",
      source,
      properties: { body: "Claimed source" },
    });
    const first = await ask();
    expectFirst(first, 201);
    trackItem(ctx, itemOf(first).id);
    expect(itemOf(first).source).toBe(source);
    expectReplay(await ask(), first);

    await grant(actor, { sources: [] }, operator);
    const refused = await ask();
    expectRefused(refused, 403, "forbidden");
    expect(refused.error?.error.details?.source).toBe(source);

    await grant(actor, { sources: [source] }, operator);
    expectReplay(await ask(), first);
  });

  it("refuses an edge replay once the key loses write on the edge type", async () => {
    const actor = await mint();
    const [from, to] = [await note(), await note()];
    const ask = keyed(actor, "POST", "/edges", {
      source_id: from.id,
      target_id: to.id,
      edge_type: "about",
    });
    const first = await ask();
    expectFirst(first, 201);
    trackEdge(ctx, edgeOf(first).id);
    expectReplay(await ask(), first);

    await grant(actor, { edge_permissions: { "*": "read" } });
    expect(
      (await actor.client.getEdge(edgeOf(first).id)).status,
      "the key still reads the edge",
    ).toBe(200);
    expectRefused(await ask(), 403, "edge_permission_denied");

    await grant(actor, { edge_permissions: { "*": "write" } });
    expectReplay(await ask(), first);
  });

  it("refuses a replay to a key that now reaches no type", async () => {
    const actor = await mint();
    const ask = keyed(actor, "POST", "/items", {
      type: "core.note",
      properties: { body: "Reached" },
    });
    const first = await ask();
    expectFirst(first, 201);
    trackItem(ctx, itemOf(first).id);
    expectReplay(await ask(), first);

    await grant(actor, { type_permissions: {} });
    const none = await actor.client.listItems({ limit: 1 });
    expect(none.status, "the key reaches no type").toBe(403);
    expect(none.error?.error.code).toBe("type_not_permitted");
    expectRefused(await ask(), 403, "type_not_permitted");

    await grant(actor, { type_permissions: { "*": "write" } });
    expectReplay(await ask(), first);
  });

  it("refuses the replay of a conflict envelope once the key cannot read the row it disclosed", async () => {
    const actor = await mint();
    const item = await note();
    // Another writer retypes the row, so the conflict names the row as it is
    // (a task) and as the stale write read it (a note).
    const moved = await client.updateItem(item.id, {
      version: item.version,
      type: "core.task",
      retype: true,
      properties: { title: "Winner" },
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    const ask = keyed(actor, "PATCH", `/items/${item.id}?conflict=manual`, {
      version: item.version,
      properties: { title: "Loser" },
    });
    const first = await ask();
    expectFirst(first, 409);
    expect(first.data).toMatchObject({
      current: { type: "core.task", properties: { title: "Winner" } },
      ancestor: { type: "core.note", properties: { title: "Original" } },
    });
    expectReplay(await ask(), first);

    // The key still reads the current row and writes it, but not the
    // snapshot the stale write was based on.
    await grant(actor, { type_permissions: { "core.task": "write" } });
    expect((await actor.client.getItem(item.id)).status).toBe(200);
    const withoutAncestor = await ask();
    expectRefused(withoutAncestor, 404, "item_not_found");
    expect(text(withoutAncestor)).not.toContain("Original");

    await grant(actor, { type_permissions: { "core.note": "write" } });
    const withoutCurrent = await ask();
    expectRefused(withoutCurrent, 404, "item_not_found");
    expect(text(withoutCurrent)).not.toContain("Winner");

    await grant(actor, { type_permissions: { "*": "write" } });
    expectReplay(await ask(), first);
  });

  it("refuses a replay disclosing an extension namespace the key can no longer read", async () => {
    const actor = await mint();
    const item = await note();
    const namespace = "replay-private";
    const marker = "Extension marker";
    expect(
      (await client.setItemExtension(item.id, namespace, { secret: marker }))
        .ok,
    ).toBe(true);
    const ask = keyed(actor, "PATCH", `/items/${item.id}`, {
      version: item.version,
      properties: { title: "Changed" },
    });
    const first = await ask();
    expectFirst(first, 200);
    expect(text(first), "the answer carries the extension").toContain(marker);
    expectReplay(await ask(), first);

    await grant(actor, { extension_permissions: {} });
    const readable = await actor.client.getItem(item.id);
    expect(readable.status, "the row is still readable").toBe(200);
    expect(JSON.stringify(readable.data)).not.toContain(marker);
    const refused = await ask();
    expectRefused(refused, 403, "forbidden");
    expect(text(refused)).not.toContain(marker);

    await grant(actor, { extension_permissions: { "*": "write" } });
    expectReplay(await ask(), first);
  });

  it("refuses a replay disclosing hydrated edges the key can no longer read", async () => {
    const actor = await mint();
    const item = await note();
    const marker = "Edge marker";
    await link(item.id, (await note()).id, "about", { label: marker });
    const ask = keyed(actor, "PATCH", `/items/${item.id}`, {
      version: item.version,
      properties: { title: "Changed" },
    });
    const first = await ask();
    expectFirst(first, 200);
    expect(text(first), "the answer carries the edge").toContain(marker);
    expectReplay(await ask(), first);

    await grant(actor, { edge_permissions: {} });
    const readable = await actor.client.getItem(item.id);
    expect(readable.status, "the row is still readable").toBe(200);
    expect(JSON.stringify(readable.data)).not.toContain(marker);
    const refused = await ask();
    expectRefused(refused, 404, "edge_not_found");
    expect(text(refused)).not.toContain(marker);

    await grant(actor, { edge_permissions: { "*": "write" } });
    expectReplay(await ask(), first);
  });

  it("refuses a bulk-action replay once the key may no longer write the matched rows, naming none of them", async () => {
    const actor = await mint();
    const tag = `replay-job-${ctx.runId}`;
    const rows = [
      await note({ title: "One", body: "a" }, { tags: [tag] }),
      await note({ title: "Two", body: "b" }, { tags: [tag] }),
    ];
    const body = {
      action: "update_tags",
      add: ["replay-job"],
      filter: { tags: [tag] },
    };
    for (const row of rows) expect(JSON.stringify(body)).not.toContain(row.id);
    const ask = keyed(actor, "POST", "/items/bulk-actions", body);
    const first = await ask();
    expectFirst(first, 202);
    expect((first.data as BulkActionJob).matched).toBe(rows.length);
    for (const row of rows) expect(text(first)).not.toContain(row.id);
    await actor.client.pollBulkActionToTerminal(
      (first.data as BulkActionJob).id,
    );
    expectReplay(await ask(), first);

    await grant(actor, { type_permissions: { "core.note": "read" } });
    const refused = await ask();
    expectRefused(refused, 403, "type_not_permitted");
    for (const row of rows) expect(text(refused)).not.toContain(row.id);

    await grant(actor, { type_permissions: { "core.note": "write" } });
    expectReplay(await ask(), first);
  });

  it("judges a replay by the row's current type after a retype", async () => {
    const actor = await mint();
    const item = await note();
    const ask = keyed(actor, "PATCH", `/items/${item.id}`, {
      version: item.version,
      properties: { title: "Changed" },
    });
    const first = await ask();
    expectFirst(first, 200);
    const moved = await client.updateItem(item.id, {
      version: itemOf(first).version,
      type: "core.task",
      retype: true,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expectReplay(await ask(), first);

    await grant(actor, { type_permissions: { "core.note": "write" } });
    expect((await actor.client.getItem(item.id)).status).toBe(404);
    expectRefused(await ask(), 404, "item_not_found");

    await grant(actor, { type_permissions: { "core.task": "write" } });
    expect((await actor.client.getItem(item.id)).status).toBe(200);
    expectRefused(await ask(), 404, "item_not_found");

    await grant(actor, {
      type_permissions: { "core.note": "write", "core.task": "read" },
    });
    expectRefused(await ask(), 403, "type_not_permitted");

    await grant(actor, {
      type_permissions: { "core.note": "write", "core.task": "write" },
    });
    expectReplay(await ask(), first);
  });

  it("judges an edge replay by the edge's current source", async () => {
    const actor = await mint();
    const [from, to] = [await note(), await note()];
    const edge = await link(from.id, to.id, "parent-of");
    const ask = keyed(actor, "PATCH", `/edges/${edge.id}`, {
      version: edge.version,
      properties: {},
    });
    const first = await ask();
    expectFirst(first, 200);
    expectReplay(await ask(), first);
    const moved = await client.updateEdge(edge.id, {
      version: edgeOf(first).version,
      source_id: (await task()).id,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);

    await grant(actor, { type_permissions: { "core.note": "write" } });
    expect((await actor.client.getEdge(edge.id)).status).toBe(404);
    expectRefused(await ask(), 404, "edge_not_found");

    await grant(actor, {
      type_permissions: { "core.note": "write", "core.task": "read" },
    });
    expectRefused(await ask(), 403, "type_not_permitted");

    await grant(actor, { type_permissions: { "*": "write" } });
    expectReplay(await ask(), first);
  });

  it("judges a replay about a purged row by its original type and source", async () => {
    const actor = await mint();

    const item = await note();
    const askItem = keyed(actor, "DELETE", `/items/${item.id}`);
    const deleted = await askItem();
    expectFirst(deleted, 200);
    expect((await client.purgeItem(item.id)).status).toBe(200);
    expect((await client.getItem(item.id)).status).toBe(404);
    expectReplay(await askItem(), deleted);
    await grant(actor, { type_permissions: { "core.note": "read" } });
    expectRefused(await askItem(), 403, "type_not_permitted");
    await grant(actor, { type_permissions: { "core.note": "write" } });
    expectReplay(await askItem(), deleted);

    const [from, to] = [await note(), await note()];
    const edge = await link(from.id, to.id, "about");
    const askEdge = keyed(actor, "DELETE", `/edges/${edge.id}`);
    const removed = await askEdge();
    expectFirst(removed, 200);
    expect((await client.deleteItem(from.id)).status).toBe(200);
    expect((await client.purgeItem(from.id)).status).toBe(200);
    expect((await client.getEdge(edge.id)).status).toBe(404);
    expectReplay(await askEdge(), removed);
    await grant(actor, { type_permissions: { "core.note": "read" } });
    expectRefused(await askEdge(), 403, "type_not_permitted");
    await grant(actor, { type_permissions: { "core.note": "write" } });
    expectReplay(await askEdge(), removed);
  });

  it("refuses a blocking-edge refusal's replay once the key cannot read both ends", async () => {
    const edgeType = await blockingEdgeType();
    const actor = await mint();
    for (const direction of ["outbound", "inbound"] as const) {
      const root = await note();
      const other = await task(`Blocker ${direction}`);
      const edge =
        direction === "outbound"
          ? await link(root.id, other.id, edgeType)
          : await link(other.id, root.id, edgeType);
      const ask = keyed(actor, "DELETE", `/items/${root.id}`);
      const first = await ask();
      expectFirst(first, 400);
      expect(first.error?.error.code).toBe("edge_constraint_violation");
      expect(
        text(first),
        `${direction}: the answer names the blocker`,
      ).toContain(other.id);
      expectReplay(await ask(), first);

      await grant(actor, { type_permissions: { "core.note": "write" } });
      const fresh = await actor.client.deleteItem(root.id);
      expect(fresh.status, `${direction}: a fresh delete is still held`).toBe(
        400,
      );
      expect(JSON.stringify(fresh.error)).not.toContain(other.id);
      const refused = await ask();
      expectRefused(refused, 404, "edge_not_found");
      expect(text(refused)).not.toContain(other.id);
      expect(text(refused)).not.toContain(edge.id);

      await grant(actor, { type_permissions: { "*": "write" } });
      expectReplay(await ask(), first);
    }
  });

  it("replays a blocking-edge refusal whose hidden blocker the first answer never named", async () => {
    const edgeType = await blockingEdgeType();
    const actor = await mint();
    const root = await note();
    const hidden = await task("Hidden blocker");
    const edge = await link(root.id, hidden.id, edgeType);
    const visible = await actor.client.deleteItem(root.id);
    expect(visible.status).toBe(400);
    expect(
      JSON.stringify(visible.error),
      "the key names the blocker while it may read it",
    ).toContain(hidden.id);

    await grant(actor, { type_permissions: { "core.note": "write" } });
    const ask = keyed(actor, "DELETE", `/items/${root.id}`);
    const first = await ask();
    expectFirst(first, 400);
    expect(first.error?.error.code).toBe("edge_constraint_violation");
    expect(text(first)).not.toContain(hidden.id);
    expect(text(first)).not.toContain(edge.id);
    expectReplay(await ask(), first);

    await grant(actor, { edge_permissions: {} });
    const replay = await ask();
    expectReplay(replay, first);
    expect(replay.headers.get("X-Error-Code")).toBe(
      "edge_constraint_violation",
    );
  });

  it("replays an edge answer without read on its target", async () => {
    const actor = await mint();
    const target = await task("Unreadable target");
    const source = await note();
    await link(source.id, target.id, "about");
    await grant(actor, { type_permissions: { "core.note": "write" } });
    expect(
      (await actor.client.getItem(target.id)).status,
      "the key cannot read the target",
    ).toBe(404);
    const askItem = keyed(actor, "PATCH", `/items/${source.id}`, {
      version: source.version,
      properties: { title: "Changed" },
    });
    const patched = await askItem();
    expectFirst(patched, 200);
    expect(text(patched), "the answer names the target").toContain(target.id);
    expectReplay(await askItem(), patched);

    const edge = await link(source.id, target.id, "parent-of");
    const askEdge = keyed(actor, "PATCH", `/edges/${edge.id}`, {
      version: edge.version,
      properties: {},
    });
    const patchedEdge = await askEdge();
    expectFirst(patchedEdge, 200);
    expect(edgeOf(patchedEdge).target_id).toBe(target.id);
    expectReplay(await askEdge(), patchedEdge);
  });

  it("withholds a disclosed source once the key cannot read the row", async () => {
    const actor = await mint();
    const source = `${ctx.source}-withheld`;
    await grant(actor, { sources: [source] }, operator);
    const made = await actor.client.createItem({
      type: "core.note",
      source,
      source_id: "original-natural-key",
      properties: { title: "Subject", body: "Valid body" },
    });
    expect(made.status).toBe(201);
    trackItem(ctx, made.data.item.id);
    const item = made.data.item;
    const ask = keyed(actor, "PATCH", `/items/${item.id}`, {
      version: item.version,
      source_id: "changed-natural-key",
    });
    const first = await ask();
    expectFirst(first, 200);
    expect(text(first), "the answer discloses the source").toContain(source);
    expectReplay(await ask(), first);

    await grant(
      actor,
      { sources: [], type_permissions: { "core.task": "read" } },
      operator,
    );
    const refused = await ask();
    expectRefused(refused, 404, "item_not_found");
    expect(refused.error?.error.details).toBeUndefined();
    expect(text(refused)).not.toContain(source);

    await grant(
      actor,
      { sources: [source], type_permissions: { "*": "write" } },
      operator,
    );
    expectReplay(await ask(), first);
  });

  it("keeps the source refusal's details for a source the key still reads", async () => {
    const actor = await mint();
    const source = `${ctx.source}-kept`;
    await grant(actor, { sources: [source] }, operator);
    const made = await actor.client.createItem({
      type: "core.note",
      source,
      source_id: "original-natural-key",
      properties: { title: "Subject", body: "Valid body" },
    });
    expect(made.status).toBe(201);
    trackItem(ctx, made.data.item.id);
    const item = made.data.item;
    const ask = keyed(actor, "PATCH", `/items/${item.id}`, {
      version: item.version,
      source_id: "changed-natural-key",
    });
    const first = await ask();
    expectFirst(first, 200);
    expect(text(first)).toContain(source);

    await grant(actor, { sources: [] }, operator);
    expect(
      (await actor.client.getItem(item.id)).status,
      "the key still reads the row",
    ).toBe(200);
    const refused = await ask();
    expectRefused(refused, 403, "forbidden");
    expect(refused.error?.error.details).toEqual({ source });

    await grant(actor, { sources: [source] }, operator);
    expectReplay(await ask(), first);
  });

  it("reauthorizes a retained cascade mark after the row it names is purged", async () => {
    const actor = await mint();
    for (const purgedBeforeFirst of [false, true]) {
      const child = await note();
      const parent = await task("Cascade root");
      await link(parent.id, child.id, "parent-of");
      expect((await client.deleteItem(parent.id)).status).toBe(200);
      if (purgedBeforeFirst)
        expect((await client.purgeItem(parent.id)).status).toBe(200);
      const ask = keyed(actor, "POST", "/items", {
        id: child.id,
        type: "core.note",
        properties: child.properties,
      });
      const first = await ask();
      expectFirst(first, 200);
      expect(
        itemOf(first).trashed_with,
        "the acknowledged create names the row whose trash took the child",
      ).toBe(parent.id);
      expectReplay(await ask(), first);
      if (!purgedBeforeFirst)
        expect((await client.purgeItem(parent.id)).status).toBe(200);
      expect((await client.getItem(parent.id)).status).toBe(404);
      expectReplay(await ask(), first);

      await grant(actor, { type_permissions: { "core.note": "write" } });
      expectRefused(await ask(), 404, "item_not_found");

      await grant(actor, {
        type_permissions: { "core.note": "write", "core.task": "read" },
      });
      expectReplay(await ask(), first);
      await grant(actor, { type_permissions: { "*": "write" } });
    }
  });
});

const DOORS = [
  "POST /items",
  "PATCH /items/{id}",
  "DELETE /items/{id}",
  "POST /items/{id}/purge",
  "POST /items/{id}/transition",
  "POST /items/{id}/restore",
  "POST /edges",
  "PATCH /edges/{id}",
  "DELETE /edges/{id}",
  "POST /folders",
  "PATCH /folders/{id}",
  "POST /folders/{id}/revoke",
  "POST /items/bulk-actions",
];

interface Prepared {
  method: Method;
  path: string;
  body?: unknown;
}

/** The request one door answers, with whatever rows it acts on made first. */
async function prepare(door: string): Promise<Prepared> {
  const [method, template] = door.split(" ") as [Method, string];
  const trashed = async (): Promise<MarfaItem> => {
    const item = await note();
    expect((await client.deleteItem(item.id)).status).toBe(200);
    return item;
  };
  const folder = async (): Promise<MarfaItem> => {
    const made = await client.createFolder({ title: "A folder" });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackFolder(ctx, made.data.item.id);
    return made.data.item;
  };
  const edge = async (): Promise<MarfaEdge> =>
    link((await note()).id, (await note()).id, "about");
  switch (door) {
    case "POST /items":
      return {
        method,
        path: template,
        body: { type: "core.note", properties: { body: "Created" } },
      };
    case "PATCH /items/{id}": {
      const item = await note();
      return {
        method,
        path: `/items/${item.id}`,
        body: { version: item.version, properties: { title: "Changed" } },
      };
    }
    case "DELETE /items/{id}":
      return { method, path: `/items/${(await note()).id}` };
    case "POST /items/{id}/purge":
      return { method, path: `/items/${(await trashed()).id}/purge` };
    case "POST /items/{id}/transition":
      return {
        method,
        path: `/items/${(await note()).id}/transition`,
        body: { state: "trashed" },
      };
    case "POST /items/{id}/restore":
      return { method, path: `/items/${(await trashed()).id}/restore` };
    case "POST /edges":
      return {
        method,
        path: template,
        body: {
          source_id: (await note()).id,
          target_id: (await note()).id,
          edge_type: "about",
        },
      };
    case "PATCH /edges/{id}": {
      const made = await edge();
      return {
        method,
        path: `/edges/${made.id}`,
        body: { version: made.version, properties: { label: "Changed" } },
      };
    }
    case "DELETE /edges/{id}":
      return { method, path: `/edges/${(await edge()).id}` };
    case "POST /folders":
      return { method, path: template, body: { title: "A folder" } };
    case "PATCH /folders/{id}": {
      const made = await folder();
      return {
        method,
        path: `/folders/${made.id}`,
        body: { version: made.version, title: "Changed folder" },
      };
    }
    case "POST /folders/{id}/revoke":
      return { method, path: `/folders/${(await folder()).id}/revoke` };
    case "POST /items/bulk-actions": {
      const tag = `replay-door-${randomUUID()}`;
      await note({ title: "Matched", body: "row" }, { tags: [tag] });
      return {
        method,
        path: template,
        body: {
          action: "update_tags",
          add: ["replay-door"],
          filter: { tags: [tag] },
          dry_run: true,
        },
      };
    }
    default:
      throw new Error(`no request is written for ${door}`);
  }
}

describe("guards the replay on every idempotent write operation", () => {
  beforeAll(async () => {
    // The cases below are the operations that take the header and no others,
    // read from the document the server serves.
    const document = await client.openApiDocument();
    expect(document.ok).toBe(true);
    const listing = Object.entries(document.data.paths).flatMap(
      ([path, operations]) =>
        Object.keys(operations as Record<string, unknown>)
          .filter((method) =>
            listsIdempotencyKey(document.data.paths, path, method),
          )
          .map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(listing.sort()).toEqual([...DOORS].sort());
  });

  it.each(DOORS)("%s", async (door) => {
    const actor = await mint();
    const spec = await prepare(door);
    const ask = keyed(actor, spec.method, spec.path, spec.body);
    const first = await ask();
    expect(first.status, JSON.stringify(first.error)).toBeLessThan(300);
    expect(replayedHeader(first)).toBeNull();
    expectReplay(await ask(), first);

    await grant(actor, { type_permissions: { "*": "read" } });
    expectRefused(await ask(), 403, "type_not_permitted");

    await grant(actor, { type_permissions: { "*": "write" } });
    expectReplay(await ask(), first);
  });
});

describe("the key on operations that do not take it, and on a refused write", () => {
  it("takes no Idempotency-Key on the operations that do not list it, and runs each repeat", async () => {
    const document = await client.openApiDocument();
    const actor = await mint();
    const ask = (method: Method, path: string, body: unknown) =>
      keyed(actor, method, path, body);

    // POST /items/bulk: each repeat is a create, so two rows.
    const tag = `replay-bulk-${ctx.runId}`;
    expect(
      listsIdempotencyKey(document.data.paths, "/items/bulk", "POST"),
    ).toBe(false);
    const bulk = ask("POST", "/items/bulk", {
      items: [
        { type: "core.note", properties: { body: "bulk row" }, tags: [tag] },
      ],
    });
    const bulkFirst = await bulk();
    const bulkSecond = await bulk();
    for (const answer of [bulkFirst, bulkSecond]) {
      expect(answer.status, JSON.stringify(answer.error)).toBe(200);
      expect(replayedHeader(answer)).toBeNull();
      for (const entry of (answer.data as BulkResponse).results)
        if (entry.id) trackItem(ctx, entry.id);
    }
    const rows = await client.listItems({ tags: [tag], limit: 100 });
    expect(rows.data.next_cursor).toBeNull();
    expect(
      rows.data.data,
      "a repeat of POST /items/bulk under one key was served from a record",
    ).toHaveLength(2);

    // POST /items/{id}/tags: the tag is removed between the two, so a repeat
    // that ran puts it back and one served from a record leaves it off.
    const tagged = await note();
    expect(
      listsIdempotencyKey(document.data.paths, "/items/{id}/tags", "POST"),
    ).toBe(false);
    const addTag = ask("POST", `/items/${tagged.id}/tags`, {
      tags: ["replay-tag"],
    });
    const tagFirst = await addTag();
    expect(tagFirst.status).toBe(200);
    expect((await client.removeTag(tagged.id, "replay-tag")).status).toBe(200);
    const tagSecond = await addTag();
    expect(tagSecond.status).toBe(200);
    expect(replayedHeader(tagSecond)).toBeNull();
    expect(
      (await client.getMetadata(tagged.id)).data.metadata.tags,
      "a repeat of POST /items/{id}/tags under one key was served from a record",
    ).toContain("replay-tag");

    // PUT /items/{id}/extensions/{namespace}: the extension is deleted
    // between the two, on the same reasoning.
    const extended = await note();
    expect(
      listsIdempotencyKey(
        document.data.paths,
        "/items/{id}/extensions/{namespace}",
        "PUT",
      ),
    ).toBe(false);
    const putExtension = ask(
      "PUT",
      `/items/${extended.id}/extensions/replay-ext`,
      { kept: true },
    );
    const extensionFirst = await putExtension();
    expect(extensionFirst.status).toBe(200);
    expect(
      (await client.deleteItemExtension(extended.id, "replay-ext")).status,
    ).toBe(200);
    const extensionSecond = await putExtension();
    expect(extensionSecond.status).toBe(200);
    expect(replayedHeader(extensionSecond)).toBeNull();
    const stored = await client.getItemExtension(extended.id, "replay-ext");
    expect(
      stored.status,
      "a repeat of PUT /items/{id}/extensions/{namespace} under one key was served from a record",
    ).toBe(200);
    expect(stored.data.data).toEqual({ kept: true });
  });

  it("does not keep a 403 answer, so the key works once the grant is added", async () => {
    const actor = await mint({ type_permissions: { "core.note": "read" } });
    const ask = keyed(actor, "POST", "/items", {
      type: "core.note",
      properties: { body: "Needs the grant" },
    });
    expectRefused(await ask(), 403, "type_not_permitted");

    await grant(actor, { type_permissions: { "core.note": "write" } });
    const created = await ask();
    expectFirst(created, 201);
    trackItem(ctx, itemOf(created).id);

    // The witness: an answer that was written is kept under the same key.
    expectReplay(await ask(), created);
  });

  it("refuses a key longer than 255 characters, and takes one of 255", async () => {
    const actor = await mint();
    const keyOf = (length: number) =>
      randomUUID().padEnd(length, "k").slice(0, length);
    const create = (key: string, tag: string) =>
      actor.client.rawRequest<unknown>("/items", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: {
          type: "core.note",
          properties: { body: "Keyed" },
          tags: [tag],
        },
      });

    const longest = keyOf(255);
    expect(longest).toHaveLength(255);
    const taken = await create(longest, `replay-255-${ctx.runId}`);
    expectFirst(taken, 201);
    trackItem(ctx, itemOf(taken).id);
    expectReplay(await create(longest, `replay-255-${ctx.runId}`), taken);

    const tag = `replay-256-${ctx.runId}`;
    const refused = await create(keyOf(256), tag);
    expectRefused(refused, 400, "validation_error");
    const written = await client.listItems({ tags: [tag], limit: 100 });
    expect(written.data.data, "the refused request wrote nothing").toEqual([]);
  });
});
