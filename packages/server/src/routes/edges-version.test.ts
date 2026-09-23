/**
 * An edge carries the version a client read.
 *
 * Without one, two devices editing one edge would overwrite each other in
 * silence: a write that replaces properties unconditionally never tells
 * the loser and never asks the winner. So an edge carries a version, and
 * `PATCH /edges/{id}` accepts it as a precondition.
 *
 * **The version is a property of the statement, not of the door.** Only
 * one statement in this codebase changes an edge row in place, so the bump
 * lives in it and every door that reaches it inherits the bump. The tests
 * that matter therefore check what a client can observe — that the number
 * moves, that a stale one is refused, and that the refusal hands back
 * enough to retry — rather than enumerating callers.
 *
 * The bulk door is the exception worth an explicit test: it reaches the
 * same statement through a different route file, and a bump written into
 * `PATCH` rather than into the store would pass every other case here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  nextEdgeEvent,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface WireEdge {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties: Record<string, unknown>;
  version: number;
}

function first<T>(rows: T[] | undefined): T {
  const row = rows?.[0];
  if (row === undefined) throw new Error("expected at least one row");
  return row;
}

async function note(body: string, key = ctx.workingKey): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function edge(
  properties: Record<string, unknown> = {},
  key = ctx.workingKey,
): Promise<WireEdge> {
  const source = await note(`src-${Math.random().toString(36).slice(2)}`, key);
  const target = await note(`tgt-${Math.random().toString(36).slice(2)}`, key);
  const res = await request(ctx.app, "POST", "/edges", {
    key,
    body: {
      source_id: source,
      target_id: target,
      edge_type: "references",
      properties,
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { edge: WireEdge }).edge;
}

describe("an edge carries a version", () => {
  it("starts at 1 and moves on with every update", async () => {
    // The whole point of the number: a client that reads twice and sees
    // the same version knows nothing changed underneath. A bump that
    // stalls makes that claim false while every response still says 200.
    const created = await edge({ note: "first" });
    expect(created.version).toBe(1);

    const second = await request(ctx.app, "PATCH", `/edges/${created.id}`, {
      key: ctx.workingKey,
      body: { version: created.version, properties: { note: "second" } },
    });
    expect(second.status).toBe(200);
    const edited = ((await second.json()) as { edge: WireEdge }).edge;
    expect(edited.version).toBe(2);

    const third = await request(ctx.app, "PATCH", `/edges/${created.id}`, {
      key: ctx.workingKey,
      body: { version: edited.version, properties: { note: "third" } },
    });
    expect(third.status).toBe(200);
    expect(((await third.json()) as { edge: WireEdge }).edge.version).toBe(3);
  });

  it("refuses a stale version with the current edge, and writes nothing", async () => {
    // The overwrite this exists to stop. Both clients read version 1; the
    // first lands, the second must not. The second half — that the refusal
    // left no trace — is the half a compare-and-swap can get wrong while
    // still returning 409, by writing and then reporting the conflict.
    const created = await edge({ note: "base" });
    expect(created.version).toBe(1);

    const winner = await request(ctx.app, "PATCH", `/edges/${created.id}`, {
      key: ctx.workingKey,
      body: { version: 1, properties: { note: "winner" } },
    });
    expect(winner.status).toBe(200);

    const loser = await request(ctx.app, "PATCH", `/edges/${created.id}`, {
      key: ctx.workingKey,
      body: { version: 1, properties: { note: "loser" } },
    });
    expect(loser.status).toBe(409);
    const refusal = (await loser.json()) as {
      error: { code: string; status: number };
      current: WireEdge;
      edge?: WireEdge;
    };
    expect(refusal.error.code).toBe("version_conflict");
    // `error.status`, because a `version_conflict` carries it on every door
    // and `errors.md` 1 exempts exactly those envelopes from the rule that
    // the error object holds no status.
    expect(refusal.error.status).toBe(409);
    // Under `current`, the key every `version_conflict` uses. A client
    // reading `body.current.version` off the item door reads it here too.
    expect(refusal.current.id).toBe(created.id);
    expect(refusal.current.version).toBe(2);
    expect(refusal.current.properties).toEqual({ note: "winner" });
    // And under nothing else. `edge` is the 200's key, and a refusal
    // answering both would leave a client free to read either — which is
    // how the two doors drift apart again.
    expect(refusal.edge).toBeUndefined();

    const after = await request(
      ctx.app,
      "GET",
      `/items/${created.source_id}/edges`,
      { key: ctx.workingKey },
    );
    const stored = first(((await after.json()) as { data: WireEdge[] }).data);
    expect(stored.properties).toEqual({ note: "winner" });
    expect(stored.version).toBe(2);
  });

  it("announces the version the write produced", async () => {
    // A subscriber applies an inbound edge only if it is not older than
    // the row it holds, which it cannot do if the frame carries no
    // version — or carries the version from before the write.
    const created = await edge({ note: "base" });
    const announced = nextEdgeEvent(
      (e) => e.type === "edge_updated" && e.edge.id === created.id,
    );
    const res = await request(ctx.app, "PATCH", `/edges/${created.id}`, {
      key: ctx.workingKey,
      body: { version: created.version, properties: { note: "edited" } },
    });
    expect(res.status).toBe(200);

    const event = await announced;
    expect((event.edge as unknown as WireEdge).version).toBe(2);
    expect(event.edge.properties).toEqual({ note: "edited" });
  });

  it("hands a precondition back from the doors that read edges directly", async () => {
    // A version a client cannot obtain is no use.
    //
    // These three resolve through the query builder, which selects every
    // mapped column, so none of them can drop the field without the
    // create above dropping it too. They are here as the statement of what
    // a client may rely on rather than as three independent guards, and
    // they are deliberately not the door most at risk — that one is split
    // into its own case below, so a failure here cannot mask it.
    const created = await edge({ note: "readable" });

    const outbound = await request(
      ctx.app,
      "GET",
      `/items/${created.source_id}/edges`,
      { key: ctx.workingKey },
    );
    expect(
      first(((await outbound.json()) as { data: WireEdge[] }).data).version,
    ).toBe(1);

    const inbound = await request(
      ctx.app,
      "GET",
      `/items/${created.target_id}/backrefs`,
      { key: ctx.workingKey },
    );
    expect(
      first(((await inbound.json()) as { data: WireEdge[] }).data).version,
    ).toBe(1);

    const listed = await request(
      ctx.app,
      "GET",
      "/edges?edge_type=references",
      {
        key: ctx.workingKey,
      },
    );
    const match = ((await listed.json()) as { data: WireEdge[] }).data.find(
      (e) => e.id === created.id,
    );
    expect(match?.version).toBe(1);
  });

  it("hands a precondition back from an edge hydrated onto its item", async () => {
    // The door that can actually regress, and the reason the previous
    // case exists at all. An item's inline edge blocks are built by
    // hand-written SQL that names its columns, so a column added to the
    // table and to every mapped read still has to be added here by
    // somebody remembering. A client walking a graph through items would
    // otherwise get edges it cannot write back to safely.
    const created = await edge({ note: "readable" });

    const hydrated = await request(
      ctx.app,
      "GET",
      `/items/${created.source_id}`,
      { key: ctx.workingKey },
    );
    const blocks = (
      (await hydrated.json()) as {
        item: {
          edges?: Record<
            string,
            { data: WireEdge[]; next_cursor: string | null }
          >;
        };
      }
    ).item.edges;
    expect(first(blocks?.references?.data).version).toBe(1);
  });
});

describe("the bulk door reaches the same statement", () => {
  it("moves the version on when it upserts an existing edge", async () => {
    // `POST /edges/bulk` takes no precondition — a per-entry one is a
    // different contract from the single door's, and nobody has asked for
    // it. It must still bump, and this is the assertion that tells a bump
    // written in the store from one written into `PATCH`.
    const created = await edge({ note: "before bulk" });

    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.workingKey,
      body: {
        edges: [
          {
            source_id: created.source_id,
            target_id: created.target_id,
            edge_type: "references",
            properties: { note: "after bulk" },
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { outcome: string; id: string }[];
    };
    expect(first(body.results).outcome).toBe("updated");
    expect(first(body.results).id).toBe(created.id);

    const after = await request(
      ctx.app,
      "GET",
      `/items/${created.source_id}/edges`,
      { key: ctx.workingKey },
    );
    const stored = first(((await after.json()) as { data: WireEdge[] }).data);
    expect(stored.properties).toEqual({ note: "after bulk" });
    expect(stored.version).toBe(2);
  });
});
