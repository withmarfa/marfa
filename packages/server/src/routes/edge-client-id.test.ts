/**
 * A client may mint the id of an edge it creates.
 *
 * `POST /items` has accepted a client-supplied `id` for as long as it has
 * had one, and `POST /edges/bulk` threads one through. The single-edge
 * door did not, so a client that minted an id locally, posted the edge and
 * then heard `edge.created` back under a different id had no way to join
 * the two: it held one edge and the server held another, wearing different
 * names. Every edge such a client created ended up twice on the device
 * that made it.
 *
 * The three properties below are separable, and each is its own way to get
 * this wrong: the id has to survive the write, a reused id has to fail as
 * a conflict rather than as a crash, and an id that is not an id has to be
 * refused at the door rather than stored.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateId } from "@withmarfa/shared";
import { subscribeEdges } from "../pubsub.js";
import type { EdgeEventWithId } from "../pubsub.js";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** One note, returned by id. */
async function seedItem(label: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: { type: "core.note", properties: { body: label } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

function collectEdgeEvents(signal: AbortSignal): {
  events: EdgeEventWithId[];
  done: Promise<void>;
} {
  const events: EdgeEventWithId[] = [];
  const done = (async () => {
    try {
      for await (const event of subscribeEdges({ signal })) {
        events.push(event);
      }
    } catch {
      // The abort ends the generator; nothing to report.
    }
  })();
  return { events, done };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("a client-supplied edge id", () => {
  it("is the id the server stores and the id it announces", async () => {
    const source = await seedItem("source");
    const target = await seedItem("target");
    const clientId = generateId();

    const controller = new AbortController();
    const { events, done } = collectEdgeEvents(controller.signal);
    await settle();

    const res = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        id: clientId,
        source_id: source,
        target_id: target,
        edge_type: "about",
      },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { edge: { id: string } }).edge.id).toBe(
      clientId,
    );
    await settle();
    controller.abort();
    await done;

    // Read back rather than trusting the response: the response could
    // echo the request while the row carries a generated id, which is
    // exactly the split this closes.
    const listed = await request(ctx.app, "GET", `/items/${source}/edges`, {
      key: ctx.adminKey,
    });
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as { data: { id: string }[] };
    expect(rows.data.map((e) => e.id)).toContain(clientId);

    // And the id a second device hears. The event is what the creating
    // client joins its local row to, so an id that survived the write but
    // not the announcement leaves the duplicate in place.
    const created = events.filter(
      (e) => e.type === "edge_created" && e.edge.id === clientId,
    );
    expect(created).toHaveLength(1);
  });

  it("is refused as a conflict when the id is already taken", async () => {
    const first = await seedItem("first-source");
    const firstTarget = await seedItem("first-target");
    const clientId = generateId();
    const created = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        id: clientId,
        source_id: first,
        target_id: firstTarget,
        edge_type: "about",
      },
    });
    expect(created.status).toBe(201);

    // A different pair, so the exact-duplicate constraint is not what
    // answers. Reusing the id alone has to be the thing that refuses,
    // and it has to refuse as a conflict rather than as an unhandled
    // constraint violation surfacing as a 500.
    const second = await seedItem("second-source");
    const secondTarget = await seedItem("second-target");
    const res = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        id: clientId,
        source_id: second,
        target_id: secondTarget,
        edge_type: "about",
      },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: { existing_id?: string } };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details?.existing_id).toBe(clientId);
  });

  it("is refused at the door when it is not a valid identifier", async () => {
    const source = await seedItem("bad-id-source");
    const target = await seedItem("bad-id-target");
    const res = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        id: "not-an-identifier",
        source_id: source,
        target_id: target,
        edge_type: "about",
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_id",
    );
  });
});
