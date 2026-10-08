import { afterEach, expect, it } from "vitest";
import {
  answers,
  edgeEvent,
  copyItemEvent,
  copyReplay,
  wireEdge,
  wireItem,
} from "../../device/marfa-answers.js";
import {
  hydratedHarness,
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

it("shows an unsent dependent edit as soon as its dead create is released", async () => {
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
  scriptWrites(server, {
    create: [{ kind: "json", status: 200, body: "unreadable answer" }],
    read: [
      answers.updated(
        wireItem({
          id: made,
          version: 1,
          properties: { title: "first", body: "held" },
        }),
      ),
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
});

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
  const edit = await device.updateEdge("link", {
    version: 1,
    properties: { weight: 2 },
  });
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
