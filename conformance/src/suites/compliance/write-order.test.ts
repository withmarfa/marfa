import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { DISK_ONLY } from "../../utils/own-blob-server.js";
import { collectUntil, withStream } from "../../utils/stream.js";

let server: FreshServer;
let client: MarfaClient;
beforeAll(async () => {
  server = await bootFreshServer("write-order", DISK_ONLY);
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);
afterEach(async () => {
  await server.clearFault();
});
afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function note(body: string, type = "core.note") {
  const made = await client.createItem({ type, properties: { body } });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item;
}
const fields = { body: { type: "string" as const } };
async function register(id: string, parent?: string) {
  const made = await client.registerType({
    id,
    fields: parent ? {} : fields,
    ...(parent && { parent }),
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
}

it("judges an item update after a trash against the trashed row", async () => {
  const item = await note("before trash");
  const update = () =>
    client.updateItem(item.id, {
      version: item.version,
      properties: { body: "edited" },
    });
  await server.setFault("hold:write=item.update@1");
  const pending = update();
  await server.waitForHold("hold:write");
  expect((await client.deleteItem(item.id)).status).toBe(200);
  await server.clearFault("hold:write");
  const refused = await pending;
  const serial = await update();
  expect(refused.status).toBe(serial.status);
  expect(refused.error?.error.code).toBe(serial.error?.error.code);
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect((await client.restoreItem(item.id)).status).toBe(200);
  const restored = await client.getItem(item.id);
  expect(
    (
      await client.updateItem(item.id, {
        version: restored.data.item.version,
        properties: { body: "edited" },
      })
    ).status,
  ).toBe(200);
});

it("judges an exact item update after a move against the current version", async () => {
  const item = await note("before move");
  const update = () =>
    client.updateItem(item.id, {
      version: item.version,
      version_match: "exact",
      properties: { body: "delayed" },
    });
  await server.setFault("hold:write=item.update@1");
  const pending = update();
  await server.waitForHold("hold:write");
  expect(
    (
      await client.updateItem(item.id, {
        version: item.version,
        source_id: "moved-natural-key",
      })
    ).status,
  ).toBe(200);
  await server.clearFault();
  const refused = await pending;
  const serial = await update();
  expect(refused.status).toBe(409);
  expect(refused.error?.error.code).toBe("version_conflict");
  expect(refused.error).toEqual(serial.error);
  expect((await client.getItem(item.id)).data.item.properties.body).toBe(
    "before move",
  );
});

it("judges an item update after retyping against the current type", async () => {
  await register("custom.order_before");
  await register("custom.order_after");
  const item = await note("before retype", "custom.order_before");
  const minted = await client.createKey({
    label: "write-order-limited",
    source: "write-order-limited",
    permissions: [],
    type_permissions: {
      "custom.order_before": "write",
      "custom.order_after": "read",
    },
  });
  expect(minted.status).toBe(201);
  const limited = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: minted.data.key,
  });
  expect(
    (
      await limited.updateItem(item.id, {
        version: 1,
        properties: { body: "witness" },
      })
    ).status,
  ).toBe(200);
  await server.setFault("hold:write=item.update@1");
  const pending = limited.updateItem(item.id, {
    version: 2,
    properties: { body: "refused" },
  });
  await server.waitForHold("hold:write");
  expect(
    (
      await client.updateItem(item.id, {
        version: 2,
        type: "custom.order_after",
        retype: true,
      })
    ).status,
  ).toBe(200);
  await server.clearFault("hold:write");
  const refused = await pending;
  expect(refused.status).toBe(403);
  expect(refused.error?.error.code).toBe("type_not_permitted");
  expect((await client.getItem(item.id)).data.item.properties.body).toBe(
    "witness",
  );
});

it("refuses a child whose parent was deleted while registration waited", async () => {
  await register("custom.order_parent");
  await server.setFault("hold:write=type.register@1");
  const pending = client.registerType({
    id: "custom.order_child",
    parent: "custom.order_parent",
    fields: {},
  });
  await server.waitForHold("hold:write");
  expect((await client.deleteType("custom.order_parent")).status).toBe(200);
  await server.clearFault("hold:write");
  const refused = await pending;
  expect(refused.status).toBe(400);
  expect(refused.error?.error.code).toBe("validation_error");
  expect((await client.getType("custom.order_child")).status).toBe(404);
  await register("custom.order_parent");
  await register("custom.order_child", "custom.order_parent");
});

it("refuses a parent deletion after a child registers", async () => {
  await register("custom.order_delete_parent");
  await server.setFault("hold:write=type.delete@1");
  const pending = client.deleteType("custom.order_delete_parent");
  await server.waitForHold("hold:write");
  await register("custom.order_delete_child", "custom.order_delete_parent");
  await server.clearFault("hold:write");
  const refused = await pending;
  expect(refused.status).toBe(409);
  expect(refused.error?.error.code).toBe("type_has_subtypes");
  expect((await client.deleteType("custom.order_delete_child")).status).toBe(
    200,
  );
  expect((await client.deleteType("custom.order_delete_parent")).status).toBe(
    200,
  );
});

it("refuses the second reparent that would close a loop", async () => {
  await register("custom.order_loop_a");
  await register("custom.order_loop_b");
  await server.setFault("hold:write=type.replace@1");
  const pending = client.replaceType("custom.order_loop_a", {
    fields,
    parent: "custom.order_loop_b",
  });
  await server.waitForHold("hold:write");
  expect(
    (
      await client.replaceType("custom.order_loop_b", {
        fields,
        parent: "custom.order_loop_a",
      })
    ).status,
  ).toBe(200);
  await server.clearFault("hold:write");
  expect((await pending).status).toBe(400);
  expect(
    (await client.replaceType("custom.order_loop_b", { fields })).status,
  ).toBe(200);
  expect(
    (
      await client.replaceType("custom.order_loop_a", {
        fields,
        parent: "custom.order_loop_b",
      })
    ).status,
  ).toBe(200);
});

it("counts an item that lands before a waiting type deletion", async () => {
  await register("custom.order_in_use");
  await server.setFault("hold:write=type.delete@1");
  const pending = client.deleteType("custom.order_in_use");
  await server.waitForHold("hold:write");
  await note("count me", "custom.order_in_use");
  await server.clearFault("hold:write");
  const refused = await pending;
  expect(refused.status).toBe(409);
  expect(refused.error?.error.code).toBe("type_in_use");
});

it("refuses an item whose type was deleted before its write starts", async () => {
  await register("custom.order_gone");
  await server.setFault("hold:write=1");
  const pending = client.createItem({
    type: "custom.order_gone",
    properties: { body: "too late" },
  });
  await server.waitForHold("hold:write");
  expect((await client.deleteType("custom.order_gone")).status).toBe(200);
  await server.clearFault("hold:write");
  const refused = await pending;
  expect(refused.status).toBe(400);
  expect(refused.error?.error.code).toBe("unknown_type");
  await register("custom.order_gone");
  await note("too late", "custom.order_gone");
});

it("refuses edge creation after its source is retyped outside write reach", async () => {
  await register("custom.edge_before");
  await register("custom.edge_after");
  const source = await note("edge source", "custom.edge_before");
  const target = await note("edge target");
  const minted = await client.createKey({
    label: "edge-order",
    source: "edge-order",
    permissions: [],
    type_permissions: {
      "custom.edge_before": "write",
      "custom.edge_after": "read",
      "core.note": "read",
    },
    edge_permissions: { references: "write" },
  });
  expect(minted.status).toBe(201);
  const limited = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: minted.data.key,
  });
  const body = {
    source_id: source.id,
    target_id: target.id,
    edge_type: "references",
  };
  const witness = await limited.createEdge(body);
  expect(witness.status).toBe(201);
  expect((await limited.deleteEdge(witness.data.edge.id)).status).toBe(200);
  await server.setFault("hold:write=edge.create@1");
  const pending = limited.createEdge(body);
  await server.waitForHold("hold:write");
  expect(
    (
      await client.updateItem(source.id, {
        version: source.version,
        type: "custom.edge_after",
        retype: true,
      })
    ).status,
  ).toBe(200);
  await server.clearFault("hold:write");
  const refused = await pending;
  expect(refused.status).toBe(403);
  expect(refused.error?.error.code).toBe("type_not_permitted");
  expect((await client.listItemEdges(source.id)).data.data).toHaveLength(0);
});

it("announces the moved endpoints when a waiting delete removes the edge", async ({
  signal,
}) => {
  const source = await note("event source");
  const first = await note("first end");
  const second = await note("second end");
  await withStream(server.apiUrl, server.workingKey, {}, async (stream) => {
    await collectUntil(
      stream,
      (events) => events.some((event) => event.event === "stream_live"),
      "stream readiness",
      signal,
    );
    const made = await client.createEdge({
      source_id: source.id,
      target_id: first.id,
      edge_type: "in-thread",
    });
    expect(made.status).toBe(201);
    await server.setFault("hold:write=edge.delete@1");
    const pending = client.deleteEdge(made.data.edge.id);
    await server.waitForHold("hold:write");
    const moved = await client.updateEdge(made.data.edge.id, {
      version: made.data.edge.version,
      target_id: second.id,
    });
    expect(moved.status).toBe(200);
    await server.clearFault("hold:write");
    expect((await pending).status).toBe(200);
    const { events } = await collectUntil(
      stream,
      (seen) => seen.some((event) => event.event === "edge.deleted"),
      "edge deletion",
      signal,
    );
    const edges = events
      .filter((event) => event.event.startsWith("edge."))
      .map((event) => ({
        event: event.event,
        edge: (event.data as { edge: { source_id: string; target_id: string } })
          .edge,
      }));
    expect(
      edges.map(({ event, edge }) => [event, edge.source_id, edge.target_id]),
    ).toEqual([
      ["edge.created", source.id, first.id],
      ["edge.updated", source.id, second.id],
      ["edge.deleted", source.id, second.id],
    ]);
  });
});

it("clears a write hold across restart and can arm it again", async () => {
  await register("custom.order_before_restart");
  await server.setFault("hold:write=type.delete@1");
  const interrupted = client.deleteType("custom.order_before_restart");
  await server.waitForHold("hold:write");
  const ended = await server.restart();
  expect(ended.code).toBe(0);
  await interrupted;
  expect(await server.faults()).toEqual([]);
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  await register("custom.order_restart");
  await server.setFault("hold:write=type.delete@1");
  const pending = client.deleteType("custom.order_restart");
  await server.waitForHold("hold:write");
  await server.clearFault();
  expect((await pending).status).toBe(200);
});

it(
  "stops with a held request after the fixture's wait times out",
  async () => {
    const own = await bootFreshServer("write-order-stop", DISK_ONLY);
    try {
      const writer = new MarfaClient({
        baseUrl: own.apiUrl,
        apiKey: own.workingKey,
      });
      await own.setFault("hold:write=1");
      const pending = writer.createItem({
        type: "core.note",
        properties: { body: "held at teardown" },
      });
      await own.waitForHold("hold:write");
      await expect(own.waitForHold("hold:write", 2, 1)).rejects.toThrow(
        "1 of 2 callers",
      );
      await own.stop();
      await pending;
      await own.stop();
    } finally {
      await own.stop();
    }
  },
  FRESH_SERVER_TIMEOUT_MS,
);
