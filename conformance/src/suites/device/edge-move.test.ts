import { afterEach, describe, expect, it } from "vitest";
import {
  answers,
  refusal,
  wireEdge,
  wireItem,
  writeAnswers,
  type WireEdgeOptions,
} from "../../device/marfa-answers.js";
import type {
  DeviceUnderTest,
  Outcome,
  QueuedWrite,
} from "../../device/protocol.js";
import type { Responder } from "../../device/scripted-server.js";
import {
  queuedEdit,
  scriptHydration,
  startHarness,
  type Harness,
} from "./harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const NEWER = "01a00000-0000-7000-8000-0000000000f1";
const OLDER = "01a00000-0000-7000-8000-0000000000f2";
const OLDEST = "01a00000-0000-7000-8000-0000000000f3";
const SUCCESSION = "01a00000-0000-7000-8000-0000000000e1";
const PARENT = "01a00000-0000-7000-8000-0000000000e2";
const LINK = "01a00000-0000-7000-8000-0000000000e3";

/**
 * A move of a target, which the server answers without changing its read
 * view (`read-views/view-keeps-edge-writes`), so the copy reads the moved edge back. A move of
 * a source expires the copy once answered; `edge-move-live.test.ts` holds
 * that against the real server.
 */
const succession: WireEdgeOptions = {
  id: SUCCESSION,
  source_id: NEWER,
  target_id: OLDER,
  edge_type: "supersedes",
  properties: { rank: 1 },
};
const parent: WireEdgeOptions = {
  id: PARENT,
  source_id: NEWER,
  target_id: OLDEST,
  edge_type: "parent-of",
};
const link: WireEdgeOptions = {
  id: LINK,
  source_id: NEWER,
  target_id: OLDER,
  edge_type: "references",
};

async function hydrated(label: string): Promise<Harness> {
  const started = await startHarness(label);
  const block = (edge: WireEdgeOptions) => ({
    data: [wireEdge(edge)],
    next_cursor: null,
  });
  scriptHydration(started.server, {
    head: "10",
    rows: {
      "core.note": [
        {
          item: {
            id: NEWER,
            edges: {
              supersedes: block(succession),
              "parent-of": block(parent),
              references: block(link),
            },
          },
        },
        { item: { id: OLDER } },
        { item: { id: OLDEST } },
      ],
    },
  });
  const done = await started.device.hydrate(["core.note"], "library");
  expect(done.ok, JSON.stringify(done)).toBe(true);
  return started;
}

function value<T>(outcome: Outcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.refusal.raw);
  return outcome.value;
}

/** Refused as the server refuses: the `validation` class, carrying its code. */
function refusedAs(outcome: Outcome<unknown>, code: string, what: string) {
  expect(outcome.ok, `${what} was queued`).toBe(false);
  if (outcome.ok) return;
  const envelope = JSON.parse(outcome.refusal.raw) as {
    error: { code: string; server: { code: string | null } | null };
  };
  expect(
    [envelope.error.code, envelope.error.server?.code],
    `${what} was refused, but not as the server refuses it: ${outcome.refusal.raw}`,
  ).toEqual(["validation", code]);
}

/** The ids of the edges of `type` the copy holds to `item`. */
async function drawnTo(
  device: DeviceUnderTest,
  item: string,
  type = "supersedes",
): Promise<string[]> {
  return value(await device.edgesTo(item))
    .filter((edge) => edge.edge_type === type)
    .map((edge) => edge.id);
}

/** The succession's door and its certified read, answering it as it stands. */
function scriptSuccession(
  harnessUnderTest: Harness,
  current: () => WireEdgeOptions,
  ...patch: Responder[]
): void {
  harnessUnderTest.server.answer("PATCH", `/edges/${SUCCESSION}`, ...patch);
  harnessUnderTest.server.copyAnswer("GET", `/edges/${SUCCESSION}`, () =>
    writeAnswers.edge(current(), 200),
  );
}

describe("an edit that moves an edge's end", () => {
  it("sends a move as one update of the edge, on the version the copy holds", async () => {
    harness = await hydrated("edge-move-one-write");
    const { server, device } = harness;
    let stands: WireEdgeOptions = { ...succession, version: 1 };
    scriptSuccession(
      harness,
      () => stands,
      () => {
        stands = { ...succession, target_id: OLDEST, version: 2 };
        return writeAnswers.edge(stands, 200);
      },
    );

    const queued = value(
      queuedEdit(
        await device.updateEdge(SUCCESSION, {
          properties: {},
          version: 1,
          target_id: OLDEST,
        }),
      ),
    );
    expect(
      [queued.kind, queued.item_id, queued.target_id],
      "the queued row does not name the edge as the copy held it",
    ).toEqual(["update_edge", NEWER, OLDER]);
    expect(
      await drawnTo(device, OLDEST),
      "the move was not shown at once",
    ).toEqual([SUCCESSION]);
    expect(await drawnTo(device, OLDER)).toEqual([]);

    const report = value(await device.drain());
    expect(report.verdicts.map((row) => row.verdict)).toEqual(["accepted"]);
    const edgeWrites = server.requests.filter(
      (request) =>
        request.pathname.startsWith("/edges") && request.method !== "GET",
    );
    expect(
      edgeWrites.map((request) => [request.method, request.pathname]),
      "the move went as something other than one update of the edge",
    ).toEqual([["PATCH", `/edges/${SUCCESSION}`]]);
    expect(JSON.parse(edgeWrites[0]!.body)).toEqual({
      properties: {},
      version: 1,
      target_id: OLDEST,
    });
    const held = value(await device.edgesTo(OLDEST)).filter(
      (edge) => edge.id === SUCCESSION,
    );
    expect(held.map((edge) => [edge.target_id, edge.version])).toEqual([
      [OLDEST, 2],
    ]);
    expect(await drawnTo(device, OLDER)).toEqual([]);
  });

  it("holds a move onto its own create refused onto a row no read has found yet, and sends it naming that row once found", async () => {
    harness = await hydrated("edge-move-onto-landing");
    const { server, device } = harness;
    const THEIRS = "01a00000-0000-7000-8000-0000000000f4";
    const created = value(
      await device.create({
        type: "core.note",
        properties: { title: "mine", body: "mine" },
        source: "notes",
        sourceId: "moved-onto.md",
        version: 0,
      }),
    );
    const local = created.item_id ?? "";
    const theirs = {
      id: THEIRS,
      version: 1,
      properties: { title: "theirs", body: "theirs" },
      tier: "library" as const,
      occurred_at: "2026-01-01T00:00:00.000Z",
      source_id: "moved-onto.md",
      type: "core.note",
    };
    let found = false;
    server.answer("POST", "/items", answers.ancestorUnavailable(theirs, 0));
    server.answer(
      "POST",
      "/items/lookup",
      answers.lookup([
        wireItem({
          id: THEIRS,
          properties: theirs.properties,
          source: "notes",
          source_id: "moved-onto.md",
        }),
      ]),
    );
    server.copyAnswer("GET", `/items/${THEIRS}`, () =>
      found
        ? answers.updated(
            wireItem({
              id: THEIRS,
              version: 1,
              properties: theirs.properties,
              source: "notes",
              source_id: "moved-onto.md",
            }),
          )
        : refusal(404, "item_not_found", "Item not found"),
    );
    let stands: WireEdgeOptions = { ...succession, version: 1 };
    scriptSuccession(
      harness,
      () => stands,
      () => {
        stands = { ...succession, target_id: THEIRS, version: 2 };
        return writeAnswers.edge(stands, 200);
      },
    );
    expect(value(await device.drain()).verdicts[0]?.verdict).toBe("refused");
    const moved = value(
      queuedEdit(
        await device.updateEdge(SUCCESSION, {
          properties: {},
          version: 1,
          target_id: local,
        }),
      ),
    );
    expect(
      moved.depends_on,
      "a move onto the row of a create refused onto a row no read has found did not wait on that create",
    ).toEqual([created.id]);
    value(await device.drain());
    const patches = () =>
      server.requests.filter(
        (request) =>
          request.pathname === `/edges/${SUCCESSION}` &&
          request.method === "PATCH",
      );
    expect(
      patches(),
      "the move went to the server naming an id the server never held",
    ).toEqual([]);
    found = true;
    value(await device.drain());
    expect(
      patches().map((request) => JSON.parse(request.body).target_id),
      "once the row was found, the move did not go naming it",
    ).toEqual([THEIRS]);
  });

  it("queues nothing for an edge edit that changes nothing, and sends only the property of one that names the end the edge holds", async () => {
    harness = await hydrated("edge-edit-no-change");
    const { server, device } = harness;
    let stands: WireEdgeOptions = { ...succession, version: 1 };
    scriptSuccession(
      harness,
      () => stands,
      () => {
        stands = { ...succession, properties: { rank: 2 }, version: 2 };
        return writeAnswers.edge(stands, 200);
      },
    );
    const before = value(await device.queue());
    const patches = () =>
      server.requests.filter(
        (request) =>
          request.pathname === `/edges/${SUCCESSION}` &&
          request.method === "PATCH",
      );

    for (const [what, edit] of [
      [
        "a move to the target the edge holds",
        { properties: {}, version: 1, target_id: OLDER },
      ],
      [
        "a move to the source the edge holds",
        { properties: {}, version: 1, source_id: NEWER },
      ],
      ["an edit naming nothing", { properties: {}, version: 1 }],
    ] as const) {
      expect(
        value(await device.updateEdge(SUCCESSION, edit)),
        `${what} was queued as a write`,
      ).toBeNull();
    }
    expect(
      value(await device.queue()),
      "an edit that changes nothing is in the queue",
    ).toEqual(before);
    value(await device.drain());
    expect(
      patches(),
      "an edit that changes nothing went to the server, which would bump the edge's version and announce it",
    ).toEqual([]);

    // The witness: the same edit with a property is queued, and its body
    // carries the property and the version alone.
    const edited = value(
      await device.updateEdge(SUCCESSION, {
        properties: { rank: 2 },
        version: 1,
        target_id: OLDER,
      }),
    );
    expect(edited?.kind).toBe("update_edge");
    expect(
      value(await device.drain()).verdicts.map((row) => row.verdict),
    ).toEqual(["accepted"]);
    expect(patches().map((request) => JSON.parse(request.body))).toEqual([
      { properties: { rank: 2 }, version: 1 },
    ]);
  });

  it("shows a waiting move at its new end from both ends, over the answer to the edit ahead of it", async () => {
    harness = await hydrated("edge-move-behind-edit");
    const { server, device } = harness;
    let stands: WireEdgeOptions = { ...succession, version: 1 };
    scriptSuccession(
      harness,
      () => stands,
      () => {
        stands = { ...succession, properties: { rank: 2 }, version: 2 };
        return writeAnswers.edge(stands, 200);
      },
      answers.dropped(),
    );

    value(
      await device.updateEdge(SUCCESSION, {
        properties: { rank: 2 },
        version: 1,
      }),
    );
    value(
      await device.updateEdge(SUCCESSION, {
        properties: {},
        version: 1,
        target_id: OLDEST,
      }),
    );
    value(await device.drain());

    const patches = server.requests.filter(
      (request) => request.method === "PATCH",
    );
    expect(
      patches.map((request) => JSON.parse(request.body).version),
      "the move did not go out on the version the edit ahead was answered with",
    ).toEqual([1, 2]);
    expect(
      value(await device.queue())
        .filter((row: QueuedWrite) => row.kind === "update_edge")
        .map((row) => row.verdict),
    ).toEqual(["accepted", null]);
    const held = value(await device.edgesFrom(NEWER)).filter(
      (edge) => edge.id === SUCCESSION,
    );
    expect(
      held.map((edge) => [edge.target_id, edge.properties.rank]),
      "the answer to the edit ahead put the edge back at the end it is moving from",
    ).toEqual([[OLDEST, 2]]);
    expect(await drawnTo(device, OLDEST)).toEqual([SUCCESSION]);
    expect(await drawnTo(device, OLDER)).toEqual([]);
  });

  it("refuses a move the server refuses whatever its rows hold, queueing nothing", async () => {
    harness = await hydrated("edge-move-refused-locally");
    const { device } = harness;
    const before = value(await device.queue());

    for (const [id, edit, code] of [
      [
        SUCCESSION,
        { properties: {}, version: 1, source_id: OLDEST, target_id: NEWER },
        "validation_error",
      ],
      [
        PARENT,
        { properties: {}, version: 1, target_id: OLDER },
        "validation_error",
      ],
      [
        LINK,
        { properties: {}, version: 1, source_id: OLDEST },
        "validation_error",
      ],
      [
        SUCCESSION,
        { properties: {}, version: 1, target_id: NEWER },
        "edge_cycle",
      ],
    ] as const) {
      refusedAs(await device.updateEdge(id, edit), code, JSON.stringify(edit));
    }
    refusedAs(
      await device.createEdge({
        source: OLDER,
        target: OLDER,
        type: "references",
      }),
      "edge_cycle",
      "a self-loop create",
    );

    expect(value(await device.queue())).toEqual(before);
    expect(await drawnTo(device, OLDER)).toEqual([SUCCESSION]);
    // The witness: an end named as the edge has it moves nothing, so the
    // same edge moves its other end.
    const moved = value(
      queuedEdit(
        await device.updateEdge(SUCCESSION, {
          properties: {},
          version: 1,
          source_id: NEWER,
          target_id: OLDEST,
        }),
      ),
    );
    expect(moved.kind).toBe("update_edge");
    expect(
      Object.keys(moved.body as Record<string, unknown>).sort(),
      "the end the edge already holds went into the update, which the server reads as a move of both ends",
    ).toEqual(["properties", "target_id", "version"]);
    expect(await drawnTo(device, OLDEST)).toEqual([SUCCESSION]);
  });
});

const PARENT_A = "01a00000-0000-7000-8000-0000000000d1";
const PARENT_B = "01a00000-0000-7000-8000-0000000000d2";
const CHILDREN = [
  "01a00000-0000-7000-8000-0000000000c1",
  "01a00000-0000-7000-8000-0000000000c2",
  "01a00000-0000-7000-8000-0000000000c3",
] as const;
const CHILD_EDGES = [
  "01a00000-0000-7000-8000-0000000000b1",
  "01a00000-0000-7000-8000-0000000000b2",
  "01a00000-0000-7000-8000-0000000000b3",
] as const;

function childEdge(at: number, source: string, version = 1): WireEdgeOptions {
  return {
    id: CHILD_EDGES[at]!,
    source_id: source,
    target_id: CHILDREN[at]!,
    edge_type: "parent-of",
    version,
  };
}

/** A copy holding a parent with a child under it for each of `CHILDREN`, and a second parent to move them to. */
async function reparentable(label: string): Promise<Harness> {
  const started = await startHarness(label);
  scriptHydration(started.server, {
    head: "10",
    rows: {
      "core.note": [
        {
          item: {
            id: PARENT_A,
            edges: {
              "parent-of": {
                data: CHILDREN.map((_, at) =>
                  wireEdge(childEdge(at, PARENT_A)),
                ),
                next_cursor: null,
              },
            },
          },
        },
        { item: { id: PARENT_B } },
        ...CHILDREN.map((id) => ({ item: { id } })),
      ],
    },
  });
  const done = await started.device.hydrate(["core.note"], "library");
  expect(done.ok, JSON.stringify(done)).toBe(true);
  return started;
}

/** How many times the device asked for a copy stream to hydrate from. */
function hydrations(started: Harness): number {
  return started.server.requests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathname === "/events" &&
      request.query.get("copy") === "1" &&
      request.headers["last-event-id"] === undefined,
  ).length;
}

/** The writes sent to an edge's door, and the reads of it made under the copy's read view. */
function edgeCalls(started: Harness, edge: string) {
  const asked = started.server.requests.filter(
    (request) => request.pathname === `/edges/${edge}`,
  );
  return {
    writes: asked.filter((request) => request.method === "PATCH"),
    reads: asked.filter(
      (request) =>
        request.method === "GET" &&
        request.headers["x-marfa-read-view"] !== undefined,
    ),
  };
}

describe("a drain that sends moves of an edge's source", () => {
  it("sends every move queued and expires the copy once, at the end", async () => {
    harness = await reparentable("edge-source-move-batch");
    const { server, device } = harness;
    CHILD_EDGES.forEach((id, at) => {
      server.answer("PATCH", `/edges/${id}`, () =>
        writeAnswers.edge(childEdge(at, PARENT_B, 2), 200),
      );
      // The read of the edge a move was answered with is made under the view
      // the move changed (`read-views/view-moves-edge-source`), and refused.
      server.answer(
        "GET",
        `/edges/${id}`,
        refusal(409, "read_view_changed", "the read view has changed"),
      );
    });
    const moves: QueuedWrite[] = [];
    for (const id of CHILD_EDGES) {
      moves.push(
        value(
          queuedEdit(
            await device.updateEdge(id, {
              properties: {},
              version: 1,
              source_id: PARENT_B,
            }),
          ),
        ),
      );
    }

    const drained = await device.drain();
    expect(drained.ok, "the drain did not end with the copy expired").toBe(
      false,
    );
    if (!drained.ok) expect(drained.refusal.code).toBe("copy_expired");
    expect(
      value(await device.queue()).map((row) => [row.id, row.verdict]),
      "a move queued behind the one that changed the view was not judged",
    ).toEqual(moves.map((row) => [row.id, "accepted"]));
    for (const [at, id] of CHILD_EDGES.entries()) {
      const calls = edgeCalls(harness, id);
      expect(calls.writes, `the move of child ${String(at)}`).toHaveLength(1);
      // The witness is the first: the move that changed the view was read
      // back under it, and the server refused. The reads after it were left
      // unmade, since the server would refuse each the same way.
      expect(calls.reads, `the read of child ${String(at)}`).toHaveLength(
        at === 0 ? 1 : 0,
      );
    }
    expect(value(await device.status()).hydration).toBe("expired");
    expect(hydrations(harness)).toBe(1);

    value(await device.hydrate(["core.note"], "library"));
    expect(hydrations(harness), "one hydration covers the batch").toBe(2);
    const after = value(await device.drain());
    expect(
      [after.answered, after.verdicts],
      "a hydration left the answered moves to be sent again",
    ).toEqual([0, []]);
    expect(
      CHILD_EDGES.map((id) => edgeCalls(harness!, id).writes.length),
      "an answered move was sent again",
    ).toEqual([1, 1, 1]);
    expect(
      hydrations(harness),
      "a drain after the hydration expired it again",
    ).toBe(2);
  });

  it("judges each write behind the move as it would have been", async () => {
    harness = await reparentable("edge-source-move-behind");
    const { server, device } = harness;
    const [first, second, third] = CHILD_EDGES;
    server.answer(
      "PATCH",
      `/edges/${first}`,
      () => writeAnswers.edge(childEdge(0, PARENT_B, 2), 200),
      () =>
        writeAnswers.edge(
          { ...childEdge(0, PARENT_B, 3), properties: { rank: 1 } },
          200,
        ),
    );
    server.answer(
      "GET",
      `/edges/${first}`,
      refusal(409, "read_view_changed", "the read view has changed"),
    );
    server.answer(
      "PATCH",
      `/edges/${second}`,
      refusal(404, "item_not_found", "no such item"),
    );
    server.answer("PATCH", `/edges/${third}`, () =>
      writeAnswers.edge(childEdge(2, PARENT_B, 2), 200),
    );
    for (const [id, edit] of [
      [first, { source_id: PARENT_B }],
      [first, { properties: { rank: 1 } }],
      [second, { source_id: PARENT_B }],
      [third, { source_id: PARENT_B }],
    ] as const) {
      value(
        queuedEdit(
          await device.updateEdge(id, {
            properties: {},
            version: 1,
            ...edit,
          }),
        ),
      );
    }

    const drained = await device.drain();
    expect(drained.ok).toBe(false);
    if (!drained.ok) expect(drained.refusal.code).toBe("copy_expired");
    expect(
      value(await device.queue()).map((row) => [row.verdict, row.reason]),
      "a write behind the move was not judged as the server answered it",
    ).toEqual([
      ["accepted", null],
      ["accepted", null],
      ["refused", "item_not_found"],
      ["accepted", null],
    ]);
    expect(
      edgeCalls(harness, first).writes.map(
        (request) => (JSON.parse(request.body) as { version: number }).version,
      ),
      "the edit behind the move did not go on the version the move made",
    ).toEqual([1, 2]);
    expect(
      CHILD_EDGES.map((id) => edgeCalls(harness!, id).reads.length),
      "a read was made under a view already known to have changed",
    ).toEqual([1, 0, 0]);
  });

  it("ends at once where the read of a write that moves no source meets a changed read view", async () => {
    harness = await reparentable("edge-source-move-other");
    const { server, device } = harness;
    const [first, second] = CHILD_EDGES;
    server.answer("PATCH", `/edges/${first}`, () =>
      writeAnswers.edge(
        { ...childEdge(0, PARENT_A, 2), properties: { rank: 1 } },
        200,
      ),
    );
    server.answer(
      "GET",
      `/edges/${first}`,
      refusal(409, "read_view_changed", "the read view has changed"),
    );
    server.answer("PATCH", `/edges/${second}`, () =>
      writeAnswers.edge(
        { ...childEdge(1, PARENT_A, 2), properties: { rank: 2 } },
        200,
      ),
    );
    for (const [id, rank] of [
      [first, 1],
      [second, 2],
    ] as const) {
      value(
        queuedEdit(
          await device.updateEdge(id, { properties: { rank }, version: 1 }),
        ),
      );
    }

    const drained = await device.drain();
    expect(drained.ok).toBe(false);
    if (!drained.ok) expect(drained.refusal.code).toBe("copy_expired");
    expect(
      value(await device.queue()).map((row) => row.verdict),
      "a write was sent behind one whose answer showed the view changed under no source move",
    ).toEqual(["accepted", null]);
    expect(edgeCalls(harness, second).writes).toHaveLength(0);
    // The witness: the read was made and refused, so it is the refusal that
    // ended the drain, and the same refusal to the read of a move of a
    // source does not (the first test).
    expect(edgeCalls(harness, first).reads).toHaveLength(1);
  });
});
