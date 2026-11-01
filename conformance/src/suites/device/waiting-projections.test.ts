import { afterEach, expect, it } from "vitest";
import {
  answers,
  refusal,
  edgeEvent,
  copyItemEvent,
  copyReplay,
  wireEdge,
  wireItem,
} from "../../device/marfa-answers.js";
import type { Answer } from "../../device/scripted-server.js";
import {
  hydratedHarness,
  queuedEdit,
  scriptHydration,
  scriptWrites,
  startHarness,
  type Harness,
} from "./harness.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const id = "01a00000-0000-7000-8000-00000000000a";

it.each(["dead", "released"] as const)(
  "keeps a %s edit visible after a newer server row arrives",
  async (state) => {
    harness = await startHarness(`projection-${state}`);
    scriptHydration(harness.server, {
      head: "1",
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 3,
              properties: { title: "held", body: "held" },
            },
          },
        ],
      },
    });
    const { device, server } = harness;
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("2", [
        copyItemEvent(
          "2",
          "item.updated",
          wireItem({
            id,
            version: 4,
            properties: { title: "new elsewhere", body: "held" },
          }),
        ),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const edit = await device.update(id, {
      version: 3,
      properties: { body: "still mine" },
    });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    scriptWrites(server, {
      update: [{ kind: "json", status: 200, body: "unreadable answer" }],
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await device.drain()).ok).toBe(true);
    }
    const queue = await device.queue();
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(queue.value.find((row) => row.id === edit.value.id)?.verdict).toBe(
      "dead",
    );
    const caught = await device.catchUp();
    expect(caught.ok && caught.value.applied).toBe(1);
    const sent = server.requests.filter(
      (request) => request.method === "PATCH",
    ).length;
    if (state === "released") {
      const released = await device.release({ id: edit.value.id });
      expect(released.ok && released.value).toBe(1);
    }
    const held = await device.get(id);
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    expect(held.value.properties.title).toBe("new elsewhere");
    expect(held.value.properties.body).toBe("still mine");
    expect(
      server.requests.filter((request) => request.method === "PATCH").length,
    ).toBe(sent);
  },
);

it.each(["parent-first", "dependent-first"] as const)(
  "sends an unsent dependent edit after release in %s order",
  async (order) => {
    harness = await hydratedHarness("projection-release-dependents", {
      rows: {},
    });
    const { device, server } = harness;
    const create = await device.create({
      type: "core.note",
      properties: { title: "first", body: "held" },
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const made = create.value.item_id!;
    const edit = await device.update(made, {
      version: 0,
      properties: { title: "edited" },
    });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const acceptedCreate = wireItem({
      id: made,
      version: 1,
      properties: { title: "first", body: "held" },
    });
    const acceptedEdit = wireItem({
      id: made,
      version: 2,
      properties: { title: "edited", body: "held" },
    });
    let editAccepted = false;
    scriptWrites(server, {
      create: [
        ...Array.from({ length: 5 }, () => ({
          kind: "json" as const,
          status: 200,
          body: "unreadable answer",
        })),
        answers.created(acceptedCreate),
      ],
      update: [
        () => {
          editAccepted = true;
          return answers.updated(acceptedEdit);
        },
      ],
      read: [
        () => answers.updated(editAccepted ? acceptedEdit : acceptedCreate),
      ],
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await device.drain()).ok).toBe(true);
    }
    const queue = await device.queue();
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(queue.value.map((row) => row.verdict)).toEqual(["dead", "refused"]);
    const before = await device.get(made);
    expect(before.ok && before.value.properties.title).toBe("first");
    expect(queue.value[1]?.depends_on).toEqual([create.value.id]);
    expect(
      server.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      ),
    ).toHaveLength(5);
    expect(
      server.requests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(0);
    if (order === "dependent-first") {
      const dependent = await device.release({ id: edit.value.id });
      expect(dependent.ok && dependent.value).toBe(1);
      const partial = await device.queue();
      expect(partial.ok && partial.value.map((row) => row.verdict)).toEqual([
        "dead",
        null,
      ]);
    }
    const released = await device.release({ id: create.value.id });
    expect(released.ok && released.value).toBe(1);
    const after = await device.get(made);
    expect(after.ok && after.value.properties.title).toBe("edited");
    expect(
      server.requests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(0);
    const releasedQueue = await device.queue();
    expect(
      releasedQueue.ok && releasedQueue.value.map((row) => row.verdict),
      "the edit refused for its dead create was not released with it",
    ).toEqual([null, null]);
    const beforeSend = server.requests.length;
    const drained = await device.drain();
    expect(
      drained.ok && drained.value.verdicts.map((row) => [row.id, row.verdict]),
    ).toEqual([
      [create.value.id, "accepted"],
      [edit.value.id, "accepted"],
    ]);
    const sent = server.requests
      .slice(beforeSend)
      .filter(
        (request) =>
          request.method === "PATCH" ||
          (request.method === "POST" && request.pathname === "/items"),
      );
    expect(sent.map((request) => [request.method, request.pathname])).toEqual([
      ["POST", "/items"],
      ["PATCH", `/items/${made}`],
    ]);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      id: made,
      properties: { title: "first", body: "held" },
    });
    expect(JSON.parse(sent[1]!.body)).toMatchObject({
      version: 1,
      properties: { title: "edited" },
    });
    const settled = await device.queue();
    expect(settled.ok && settled.value.map((row) => row.verdict)).toEqual([
      "accepted",
      "accepted",
    ]);
    const visible = await device.get(made);
    expect(
      visible.ok && [visible.value.version, visible.value.properties],
    ).toEqual([2, { title: "edited", body: "held" }]);
  },
);

it("keeps a dead create visible through hydration", async () => {
  harness = await hydratedHarness("projection-dead-create", { rows: {} });
  const { device, server } = harness;
  const create = await device.create({
    type: "core.note",
    properties: { title: "still here", body: "held" },
  });
  expect(create.ok).toBe(true);
  if (!create.ok) return;
  scriptWrites(server, {
    create: [{ kind: "json", status: 200, body: "unreadable answer" }],
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await device.drain()).ok).toBe(true);
  }
  expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
  const held = await device.get(create.value.item_id!);
  expect(held.ok && held.value.properties.title).toBe("still here");
});

it("keeps a dead edge edit over a newer edge event", async () => {
  harness = await startHarness("projection-dead-edge");
  const { device, server } = harness;
  const edge = wireEdge({
    id: "link",
    source_id: id,
    target_id: "target",
    properties: { weight: 1 },
  });
  scriptHydration(server, {
    head: "1",
    rows: {
      "core.note": [
        {
          item: {
            id,
            edges: { references: { data: [edge], next_cursor: null } },
          },
        },
        { item: { id: "target" } },
      ],
    },
  });
  server.copyAnswer(
    "GET",
    "/events",
    copyReplay("2", [
      edgeEvent("2", "edge.updated", {
        ...edge,
        version: 2,
        properties: { weight: 1, note: "new elsewhere" },
      }),
    ]),
  );
  expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
  const edit = queuedEdit(
    await device.updateEdge("link", {
      version: 1,
      properties: { weight: 2 },
    }),
  );
  expect(edit.ok).toBe(true);
  if (!edit.ok) return;
  scriptWrites(server, {
    edges: [{ kind: "json", status: 200, body: "unreadable answer" }],
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await device.drain()).ok).toBe(true);
  }
  const queue = await device.queue();
  expect(
    queue.ok && queue.value.find((row) => row.id === edit.value.id)?.verdict,
  ).toBe("dead");
  const caught = await device.catchUp();
  expect(caught.ok && caught.value.applied).toBe(1);
  const edges = await device.edgesFrom(id);
  expect(
    edges.ok && edges.value.find((row) => row.id === "link")?.properties,
  ).toEqual({ weight: 2, note: "new elsewhere" });
});

it("keeps a dead edge create over an existing server edge", async () => {
  harness = await startHarness("projection-dead-edge-create");
  const { device, server } = harness;
  let edgeId = "";
  scriptHydration(server, {
    head: "1",
    rows: { "core.note": [{ item: { id } }, { item: { id: "target" } }] },
  });
  server.copyAnswer("GET", "/events", () =>
    copyReplay("2", [
      edgeEvent(
        "2",
        "edge.updated",
        wireEdge({
          id: edgeId,
          source_id: id,
          target_id: "target",
          version: 2,
          properties: { weight: 1, note: "new elsewhere" },
        }),
      ),
    ]),
  );
  expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
  const create = await device.createEdge({
    source: id,
    target: "target",
    type: "references",
    properties: { weight: 2 },
  });
  expect(create.ok).toBe(true);
  if (!create.ok) return;
  edgeId = create.value.edge_id!;
  scriptWrites(server, {
    edges: [{ kind: "json", status: 201, body: "unreadable answer" }],
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await device.drain()).ok).toBe(true);
  }
  const queue = await device.queue();
  expect(
    queue.ok && queue.value.find((row) => row.id === create.value.id)?.verdict,
  ).toBe("dead");
  const caught = await device.catchUp();
  expect(caught.ok && caught.value.applied).toBe(1);
  const edges = await device.edgesFrom(id);
  expect(
    edges.ok && edges.value.find((row) => row.id === edgeId),
  ).toMatchObject({
    version: 2,
    properties: { weight: 2, note: "new elsewhere" },
  });
});

const drawnTarget = "01a00000-0000-7000-8000-0000000000d1";
const servedEdge = "01a00000-0000-7000-8000-0000000000d2";

/**
 * A create drawn to one target, which the server accepts with an answer that
 * carries no block of its edges, so the device owes a read of them. Each read
 * of the item's edges answers what `listing` holds then.
 */
async function createdWithUnreadEdge(
  label: string,
  listing: () => Answer,
): Promise<{ harness: Harness; made: string; drawn: string; created: string }> {
  const started = await hydratedHarness(label, {
    rows: { "core.note": [{ item: { id: drawnTarget } }] },
  });
  const { device, server } = started;
  const create = await device.create({
    type: "core.note",
    properties: { title: "drawn", body: "drawn" },
    edges: { references: [drawnTarget] },
  });
  expect(create.ok, JSON.stringify(create)).toBe(true);
  if (!create.ok) throw new Error(create.refusal.raw);
  const made = create.value.item_id!;
  const accepted = wireItem({ id: made, version: 1 });
  scriptWrites(server, {
    create: [answers.created(accepted)],
    read: [answers.updated(accepted)],
  });
  server.copyAnswer("GET", `/items/${made}/edges`, () => listing());
  const shown = await device.edgesFrom(made);
  expect(shown.ok, JSON.stringify(shown)).toBe(true);
  const drawn = shown.ok ? (shown.value[0]?.id ?? "") : "";
  return { harness: started, made, drawn, created: create.value.id };
}

function listingReads(server: Harness["server"], made: string): number {
  return server.requests.filter(
    (request) =>
      request.method === "GET" && request.pathname === `/items/${made}/edges`,
  ).length;
}

it("keeps showing a created item's edge while the read of its edges fails, until one succeeds", async () => {
  let listing: Answer = refusal(503, "unavailable", "try again later");
  const created = await createdWithUnreadEdge(
    "create-edges-kept-short",
    () => listing,
  );
  harness = created.harness;
  const { device, server } = harness;
  const first = await device.drain();
  expect(
    first.ok && first.value.verdicts.map((row) => [row.id, row.verdict]),
  ).toEqual([[created.created, "accepted"]]);
  expect(listingReads(server, created.made)).toBe(1);
  const kept = await device.edgesFrom(created.made);
  expect(
    kept.ok && kept.value.map((edge) => [edge.id, edge.target_id]),
    "the edge went before a read brought the server's",
  ).toEqual([[created.drawn, drawnTarget]]);

  // The witness: once a read succeeds, the server's edge takes its place.
  listing = {
    kind: "json",
    status: 200,
    body: {
      data: [
        wireEdge({
          id: servedEdge,
          source_id: created.made,
          target_id: drawnTarget,
        }),
      ],
      next_cursor: null,
    },
  };
  expect((await device.drain()).ok).toBe(true);
  expect(listingReads(server, created.made)).toBe(2);
  const read = await device.edgesFrom(created.made);
  expect(read.ok && read.value.map((edge) => edge.id)).toEqual([servedEdge]);
  expect(created.drawn).not.toBe(servedEdge);
});

it("keeps a created item's edge and refuses its waiting delete unsent when the read of its edges is refused", async () => {
  const created = await createdWithUnreadEdge("create-edges-read-failed", () =>
    answers.validation("validation_error", "the request is not valid"),
  );
  harness = created.harness;
  const { device, server } = harness;
  const deleted = await device.deleteEdge(created.drawn);
  expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
  if (!deleted.ok) return;
  const first = await device.drain();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  expect(
    first.value.verdicts.find((row) => row.id === created.created)?.verdict,
    "the create's verdict was lost with the read",
  ).toBe("accepted");
  expect(listingReads(server, created.made)).toBe(1);
  expect(
    server.requests.filter((request) => request.method === "DELETE"),
    "the delete was sent to an id the server never gave",
  ).toEqual([]);
  const queue = await device.queue();
  expect(queue.ok, JSON.stringify(queue)).toBe(true);
  if (!queue.ok) return;
  const write = queue.value.find((row) => row.id === deleted.value.id);
  expect(write?.verdict).toBe("refused");
  expect(write?.answer, JSON.stringify(write)).toBeNull();
  const kept = await device.edgesFrom(created.made);
  expect(
    kept.ok && kept.value.map((edge) => [edge.id, edge.target_id]),
  ).toEqual([[created.drawn, drawnTarget]]);

  // The read is not asked again.
  expect((await device.drain()).ok).toBe(true);
  expect(listingReads(server, created.made)).toBe(1);
});
