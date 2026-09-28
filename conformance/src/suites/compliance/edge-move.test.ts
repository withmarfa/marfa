import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  ApiResponse,
  MarfaEdge,
  TestContext,
} from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackEdgeType,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createBookmark, createNote } from "../../generators/items.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * Moving an edge's end (`edges.md` 10) is judged as the create of the edge it
 * becomes would be, announced as one change, and replayed from its record
 * under an `Idempotency-Key` like every other write to an edge.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "edge-move",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeItem(
  label: string,
  as: MarfaClient = client,
): Promise<string> {
  // A scoped key writes under its own source.
  const r = await as.createItem(
    createNote({
      ...(as === client ? { source: ctx.source } : {}),
      properties: { body: `move-${label}` },
    }),
  );
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function makeBookmark(): Promise<string> {
  const r = await client.createItem(createBookmark({ source: ctx.source }));
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function makeEdge(
  source_id: string,
  target_id: string,
  edge_type: string,
  as: MarfaClient = client,
): Promise<MarfaEdge> {
  const r = await as.createEdge({ source_id, target_id, edge_type });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  trackEdge(ctx, r.data.edge.id);
  return r.data.edge;
}

/** The edge as the server holds it now. */
async function stored(id: string): Promise<MarfaEdge> {
  const r = await client.getEdge(id);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.data.edge;
}

function refusal(r: ApiResponse<unknown>): {
  status: number;
  code: unknown;
  details: unknown;
} {
  const body = r.error as
    { error?: { code?: unknown; details?: unknown } } | undefined;
  return {
    status: r.status,
    code: body?.error?.code,
    details: body?.error?.details,
  };
}

describe("moving an edge's end", () => {
  it("announces a move as one edge.updated, with nothing between", async ({
    signal,
  }) => {
    await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 200));
      const first = await makeItem("stream-first");
      const second = await makeItem("stream-second");
      const child = await makeItem("stream-child");
      const held = await makeEdge(first, child, "parent-of");
      const moved = await client.updateEdge(held.id, {
        source_id: second,
        version: held.version,
      });
      expect(moved.status, JSON.stringify(moved.error)).toBe(200);

      // The witness: the same change as a delete and a create is two frames,
      // so the stream carries them where they happen.
      const other = await makeItem("stream-other-child");
      const doomed = await makeEdge(first, other, "parent-of");
      expect((await client.deleteEdge(doomed.id)).ok).toBe(true);
      const replaced = await makeEdge(second, other, "parent-of");
      const sentinel = await makeItem("stream-sentinel");

      const { events } = await collectUntil(
        stream,
        (seen) =>
          seen.some(
            (e) => (e.data as { item?: { id?: string } }).item?.id === sentinel,
          ),
        `the sentinel ${sentinel} after the move`,
        signal,
      );
      const framesOf = (id: string): SseEvent[] =>
        events.filter(
          (e) => (e.data as { edge?: { id?: string } }).edge?.id === id,
        );
      expect(
        [...framesOf(doomed.id), ...framesOf(replaced.id)].map((e) => e.event),
        "the stream did not carry a delete and a create, so their absence below proves nothing",
      ).toEqual(["edge.created", "edge.deleted", "edge.created"]);
      const ours = framesOf(held.id);
      expect(
        ours.map((e) => e.event),
        "the move reached the stream as more than one change",
      ).toEqual(["edge.created", "edge.updated"]);
      const frame = ours[1]?.data as { edge: MarfaEdge };
      expect(frame.edge).toMatchObject({
        id: held.id,
        source_id: second,
        target_id: child,
        version: held.version + 1,
      });
      // The created frame carries the same keys, so any key more on the move
      // would be the old end.
      const keysOf = (event: SseEvent | undefined) => {
        const data = event?.data as { edge: Record<string, unknown> };
        return [Object.keys(data).sort(), Object.keys(data.edge).sort()];
      };
      expect(keysOf(ours[0])[1]).toContain("source_id");
      expect(
        keysOf(ours[1]),
        "the move's frame names something more than the edge as it stands",
      ).toEqual(keysOf(ours[0]));
      expect(JSON.stringify(ours[0]?.data)).toContain(first);
      expect(JSON.stringify(frame)).not.toContain(first);
    });
  });

  it("refuses a move onto an end that already holds its one edge, and moves nothing", async () => {
    const newer = await makeItem("card-newer");
    const older = await makeItem("card-older");
    const taken = await makeItem("card-taken");
    const free = await makeItem("card-free");
    const held = await makeEdge(newer, older, "supersedes");
    await makeEdge(await makeItem("card-rival"), taken, "supersedes");

    const refused = await client.updateEdge(held.id, {
      target_id: taken,
      version: held.version,
    });
    expect(refusal(refused)).toMatchObject({
      status: 400,
      code: "edge_constraint_violation",
      details: { constraint: "cardinality", target_id: taken },
    });
    expect(await stored(held.id)).toEqual(held);

    // The witness: the same move onto a target holding none is taken.
    const moved = await client.updateEdge(held.id, {
      target_id: free,
      version: held.version,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
  });

  it("refuses a move that would close a cycle, and moves nothing", async () => {
    const top = await makeItem("cycle-top");
    const middle = await makeItem("cycle-middle");
    const bottom = await makeItem("cycle-bottom");
    const aside = await makeItem("cycle-aside");
    const upper = await makeEdge(top, middle, "parent-of");
    await makeEdge(middle, bottom, "parent-of");

    // The middle moved under its own child: bottom parent-of middle, while
    // middle parent-of bottom stands.
    const deep = await client.updateEdge(upper.id, {
      source_id: bottom,
      version: upper.version,
    });
    expect(refusal(deep)).toMatchObject({ status: 400, code: "edge_cycle" });
    const loop = await client.updateEdge(upper.id, {
      source_id: middle,
      version: upper.version,
    });
    expect(refusal(loop)).toMatchObject({ status: 400, code: "edge_cycle" });
    expect(await stored(upper.id)).toEqual(upper);

    // A move onto its own source closes a loop on every type, not only the
    // ones a walk is run for.
    for (const edgeType of ["in-thread", "supersedes"]) {
      const source = await makeItem(`cycle-${edgeType}-source`);
      const held = await makeEdge(
        source,
        await makeItem(`cycle-${edgeType}-target`),
        edgeType,
      );
      const self = await client.updateEdge(held.id, {
        target_id: source,
        version: held.version,
      });
      expect(
        refusal(self),
        `an edge of type ${edgeType} was moved onto its own source`,
      ).toMatchObject({ status: 400, code: "edge_cycle" });
      expect(await stored(held.id)).toEqual(held);
      // The witness: the same edge moves onto another item.
      const elsewhere = await client.updateEdge(held.id, {
        target_id: aside,
        version: held.version,
      });
      expect(elsewhere.status, JSON.stringify(elsewhere.error)).toBe(200);
    }

    // The witness: a parent outside the chain is taken.
    const moved = await client.updateEdge(upper.id, {
      source_id: aside,
      version: upper.version,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
  });

  it("refuses a move onto a target its type's constraint refuses, and answers one the key cannot read exactly as a missing one", async () => {
    const edgeType = `mock.move.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      id: edgeType,
      cardinality: "many-to-one",
      target_type_constraints: ["core.note"],
      cascade_on_delete: "orphan",
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackEdgeType(ctx, edgeType);
    const minted = await client.createKey({
      label: "edge-move-notes",
      source: `${ctx.source}-edge-move-notes`,
      type_permissions: { "core.note": "write" },
      edge_permissions: { "*": "write" },
      permissions: [],
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const notesOnly = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });

    const source = await makeItem("constraint-source", notesOnly);
    const first = await makeItem("constraint-first", notesOnly);
    const readable = await makeItem("constraint-readable", notesOnly);
    const bookmark = await makeBookmark();
    const held = await makeEdge(source, first, edgeType, notesOnly);

    // The witness: a key that reads the bookmark is refused by the constraint,
    // which reads the target's type.
    const constrained = await client.updateEdge(held.id, {
      target_id: bookmark,
      version: held.version,
    });
    expect(refusal(constrained)).toMatchObject({
      status: 400,
      code: "edge_constraint_violation",
      details: { target_type: "core.bookmark" },
    });

    const masked = (r: ApiResponse<unknown>, id: string) =>
      JSON.parse(
        JSON.stringify({ status: r.status, body: r.error }).replaceAll(
          id,
          "<target>",
        ),
      ) as unknown;
    const missing = "01a00000-0000-7000-8000-00000000abcd";
    const toMissing = await notesOnly.updateEdge(held.id, {
      target_id: missing,
      version: held.version,
    });
    expect(refusal(toMissing)).toMatchObject({
      status: 404,
      code: "item_not_found",
    });
    const toUnreadable = await notesOnly.updateEdge(held.id, {
      target_id: bookmark,
      version: held.version,
    });
    expect(
      masked(toUnreadable, bookmark),
      "a target the key cannot read was answered differently from a missing one",
    ).toEqual(masked(toMissing, missing));
    expect(await stored(held.id)).toEqual(held);

    // The witness: the same key moves the edge onto a target it can read.
    const moved = await notesOnly.updateEdge(held.id, {
      target_id: readable,
      version: held.version,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
  });

  it("refuses a new source that does not exist, or whose type the key cannot write", async () => {
    const minted = await client.createKey({
      label: "edge-move-writer",
      source: `${ctx.source}-edge-move-writer`,
      type_permissions: { "core.note": "write", "core.bookmark": "read" },
      edge_permissions: { "*": "write" },
      permissions: [],
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const writer = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const parent = await makeItem("writer-parent", writer);
    const child = await makeItem("writer-child", writer);
    const bookmark = await makeBookmark();
    const note = await makeItem("writer-note", writer);
    const held = await makeEdge(parent, child, "parent-of", writer);

    const refused = await writer.updateEdge(held.id, {
      source_id: bookmark,
      version: held.version,
    });
    expect(refusal(refused)).toMatchObject({
      status: 403,
      code: "type_not_permitted",
    });
    const missing = await writer.updateEdge(held.id, {
      source_id: "01a00000-0000-7000-8000-00000000abce",
      version: held.version,
    });
    expect(refusal(missing)).toMatchObject({
      status: 404,
      code: "item_not_found",
    });
    expect(await stored(held.id)).toEqual(held);
    const moved = await writer.updateEdge(held.id, {
      source_id: note,
      version: held.version,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
  });

  it("refuses a move of an edge whose end that stays is in the bin, as its create is refused", async () => {
    const message = await makeItem("bin-message");
    const threads = [await makeItem("bin-a"), await makeItem("bin-b")];
    const held = await makeEdge(message, threads[0]!, "in-thread");
    expect((await client.deleteItem(message)).ok).toBe(true);

    const refused = await client.updateEdge(held.id, {
      target_id: threads[1]!,
      version: held.version,
    });
    expect(refusal(refused)).toMatchObject({
      status: 404,
      code: "item_not_found",
    });
    expect(await stored(held.id)).toEqual(held);
    const created = await client.createEdge({
      source_id: message,
      target_id: threads[1]!,
      edge_type: "in-thread",
    });
    expect(
      created.status,
      "a create from the same source in the bin was taken, so the move's refusal is not the create's",
    ).toBe(404);

    // The witness: restored, the same move is taken.
    expect((await client.restoreItem(message)).ok).toBe(true);
    const moved = await client.updateEdge(held.id, {
      target_id: threads[1]!,
      version: held.version,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
  });

  it("refuses a stale version with the edge as it stands, and moves nothing", async () => {
    const message = await makeItem("stale-message");
    const threads = [
      await makeItem("stale-a"),
      await makeItem("stale-b"),
      await makeItem("stale-c"),
    ];
    const held = await makeEdge(message, threads[0]!, "in-thread");
    const first = await client.updateEdge(held.id, {
      target_id: threads[1]!,
      version: held.version,
    });
    expect(first.status, JSON.stringify(first.error)).toBe(200);

    const stale = await client.updateEdge(held.id, {
      target_id: threads[2]!,
      version: held.version,
    });
    expect(stale.status).toBe(409);
    const body = stale.error as unknown as {
      error: { code: string };
      current: MarfaEdge;
    };
    expect(body.error.code).toBe("version_conflict");
    expect(body.current).toEqual(first.data.edge);
    expect(await stored(held.id)).toEqual(first.data.edge);
  });

  it("refuses a stale version before it judges the move", async () => {
    const message = await makeItem("stale-first-message");
    const threads = [
      await makeItem("stale-first-a"),
      await makeItem("stale-first-b"),
    ];
    const held = await makeEdge(message, threads[0]!, "in-thread");
    const about = await makeEdge(message, threads[1]!, "about");
    const missing = "01a00000-0000-7000-8000-00000000abcf";
    const cases = [
      { edge: held, body: { target_id: missing } },
      { edge: about, body: { target_id: threads[0]! } },
      { edge: held, body: { target_id: "not-an-id" } },
    ];

    // The witness: at the version held, each is refused for what it names.
    const current = [];
    for (const { edge, body } of cases) {
      current.push(
        refusal(
          await client.updateEdge(edge.id, { ...body, version: edge.version }),
        ),
      );
    }
    expect(current.map((answer) => [answer.status, answer.code])).toEqual([
      [404, "item_not_found"],
      [400, "validation_error"],
      [400, "invalid_id"],
    ]);

    for (const { edge, body } of cases) {
      const stale = await client.updateEdge(edge.id, {
        ...body,
        version: edge.version + 1,
      });
      expect(
        refusal(stale),
        `a stale move to ${JSON.stringify(body)} was judged before its version`,
      ).toMatchObject({ status: 409, code: "version_conflict" });
      expect(await stored(edge.id)).toEqual(edge);
    }
  });

  it("refuses an update that moves no end and names no properties", async () => {
    const message = await makeItem("nothing-message");
    const thread = await makeItem("nothing-thread");
    const held = await makeEdge(message, thread, "in-thread");
    for (const body of [
      { version: held.version },
      { target_id: thread, version: held.version },
    ]) {
      expect(
        refusal(await client.updateEdge(held.id, body)),
        `${JSON.stringify(body)} changes nothing and was taken`,
      ).toMatchObject({ status: 400, code: "missing_required_field" });
    }
    expect(await stored(held.id)).toEqual(held);

    // The witness: the same body naming a property is taken.
    const named = await client.updateEdge(held.id, {
      properties: { note: "named" },
      version: held.version,
    });
    expect(named.status, JSON.stringify(named.error)).toBe(200);
  });

  it("refuses to move an end of a type that holds many at the end that stays, or both ends at once", async () => {
    const a = await makeItem("many-a");
    const b = await makeItem("many-b");
    const c = await makeItem("many-c");
    const d = await makeItem("many-d");
    const about = await makeEdge(a, b, "about");
    for (const body of [
      { target_id: c, version: about.version },
      { source_id: c, version: about.version },
    ]) {
      const refused = await client.updateEdge(about.id, body);
      expect(refusal(refused)).toMatchObject({
        status: 400,
        code: "validation_error",
      });
    }
    expect(await stored(about.id)).toEqual(about);

    const parent = await makeEdge(a, c, "parent-of");
    // The child's end holds one parent-of, the parent's many.
    const childMoved = await client.updateEdge(parent.id, {
      target_id: d,
      version: parent.version,
    });
    expect(refusal(childMoved)).toMatchObject({
      status: 400,
      code: "validation_error",
    });
    const both = await client.updateEdge(parent.id, {
      source_id: b,
      target_id: d,
      version: parent.version,
    });
    expect(refusal(both)).toMatchObject({
      status: 400,
      code: "validation_error",
    });
    expect(await stored(parent.id)).toEqual(parent);

    // The witness: the end its type lets move does.
    const moved = await client.updateEdge(parent.id, {
      source_id: b,
      version: parent.version,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
  });

  it("answers a move repeated under one Idempotency-Key from its record", async () => {
    const message = await makeItem("replay-message");
    const from = await makeItem("replay-from");
    const to = await makeItem("replay-to");
    const held = await makeEdge(message, from, "in-thread");
    const headers = { "Idempotency-Key": `edge-move-${ctx.runId}` };
    const body = {
      target_id: to,
      properties: { via: "replay" },
      version: held.version,
    };

    const first = await client.updateEdge(held.id, body, headers);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const again = await client.updateEdge(held.id, body, headers);
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(again.data).toEqual(first.data);
    expect((await stored(held.id)).version).toBe(held.version + 1);

    // The witness: the same body sent without the key is refused as stale.
    const unkeyed = await client.updateEdge(held.id, body);
    expect(unkeyed.status).toBe(409);
  });
});
