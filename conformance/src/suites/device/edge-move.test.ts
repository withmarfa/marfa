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
import { scriptHydration, startHarness, type Harness } from "./harness.js";

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
      await device.updateEdge(SUCCESSION, {
        properties: {},
        version: 1,
        target_id: OLDEST,
      }),
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
      await device.updateEdge(SUCCESSION, {
        properties: {},
        version: 1,
        target_id: local,
      }),
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
      await device.updateEdge(SUCCESSION, {
        properties: {},
        version: 1,
        source_id: NEWER,
        target_id: OLDEST,
      }),
    );
    expect(moved.kind).toBe("update_edge");
    expect(await drawnTo(device, OLDEST)).toEqual([SUCCESSION]);
  });
});
