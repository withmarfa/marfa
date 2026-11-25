import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { DrainReport, Outcome } from "../../device/protocol.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const stores: string[] = [];

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "archived",
  ));
});

afterAll(async () => {
  for (const store of stores)
    rmSync(dirname(store), { recursive: true, force: true });
  if (ctx) await cleanup(ctx);
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

function accepted(report: DrainReport, ids: string[]) {
  const told = ids.map((id) =>
    report.verdicts.filter((entry) => entry.id === id).map((v) => v.verdict),
  );
  expect(told, JSON.stringify(report)).toEqual(ids.map(() => ["accepted"]));
}

async function note(state: "active" | "archived", body: string) {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title: body, body },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  if (state === "archived") {
    expect(
      (await client.transitionItem(made.data.item.id, "archived")).status,
    ).toBe(200);
  }
  return made.data.item.id;
}

async function deviceHolding(label: string) {
  const store = newStore(label);
  stores.push(store);
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: apiKey,
  });
  value(await device.hydrate(["core.note"], "library"));
  return device;
}

it("queues and sends an edit, tags, an extension and edges for an archived item as for an active one, and leaves its state", async () => {
  for (const held of ["active", "archived"] as const) {
    const mine = await note(held, `mine-${held}`);
    const other = await note("active", `other-${held}`);
    expect((await client.addTags(mine, ["first"])).status).toBe(200);
    const device = await deviceHolding(`archived-writes-${held}`);
    expect(value(await device.get(mine)).state, held).toBe(held);
    const version = value(await device.get(mine)).version;

    const queued = [
      value(
        await device.update(mine, {
          properties: { body: `edited-${held}` },
          version,
        }),
      ),
      value(await device.addTag(mine, "added")),
      value(await device.writeExtension(mine, "app.archived", { v: held })),
      value(
        await device.createEdge({
          source: mine,
          target: other,
          type: "parent-of",
          properties: { since: held },
        }),
      ),
    ];
    accepted(
      value(await device.drain()),
      queued.map((write) => write.id),
    );
    const back = await client.getItem(mine);
    expect(back.data.item.properties.body, held).toBe(`edited-${held}`);
    expect([...back.data.metadata.tags].sort(), held).toEqual([
      "added",
      "first",
    ]);
    expect(
      (await client.getItemExtension(mine, "app.archived")).data.document,
    ).toEqual({ v: held });
    const edgeId = queued[3]!.edge_id!;
    expect((await client.getEdge(edgeId)).data.edge.to_id).toBe(other);

    const edge = value(await device.edge(edgeId));
    const later = [
      value(
        await device.updateEdge(edgeId, {
          properties: { note: held },
          version: edge.version,
        }),
      )!,
      value(await device.replaceTags(mine, ["replaced"])),
      value(await device.removeTag(mine, "replaced")),
      value(await device.deleteExtension(mine, "app.archived")),
      value(await device.deleteEdge(edgeId)),
    ];
    accepted(
      value(await device.drain()),
      later.map((write) => write.id),
    );
    const after = await client.getItem(mine);
    expect(after.data.metadata.tags, held).toEqual([]);
    expect(
      (await client.getItemExtension(mine, "app.archived")).data.document,
    ).toBeNull();
    expect((await client.getEdge(edgeId)).status).toBe(404);
    expect(after.data.item.state, held).toBe(held);
    expect(value(await device.get(mine)).state, held).toBe(held);
  }
});

it("moves no other item the copy holds when it archives an item holding parent-of children", async () => {
  const parent = await note("active", "host");
  const child = await note("active", "child");
  const grandchild = await note("active", "grandchild");
  for (const [from_id, to_id] of [
    [parent, child],
    [child, grandchild],
  ] as const) {
    const edge = await client.createEdge({
      from_id,
      to_id,
      edge_type: "parent-of",
    });
    expect(edge.status, JSON.stringify(edge.error)).toBe(201);
  }
  const device = await deviceHolding("archived-no-cascade");

  const binned = await note("active", "binned host");
  const binnedChild = await note("active", "binned child");
  expect(
    (
      await client.createEdge({
        from_id: binned,
        to_id: binnedChild,
        edge_type: "parent-of",
      })
    ).status,
  ).toBe(201);
  const witness = await deviceHolding("archived-no-cascade-witness");

  const move = value(await device.transitionItem(parent, "archived"));
  expect(value(await device.get(parent)).state).toBe("archived");
  expect(value(await device.get(child)).state).toBe("active");
  expect(value(await device.get(grandchild)).state).toBe("active");
  accepted(value(await device.drain()), [move.id]);
  for (const id of [child, grandchild]) {
    expect((await client.getItem(id)).data.item.state).toBe("active");
  }
  expect((await client.getItem(parent)).data.item.state).toBe("archived");

  const deleted = value(await witness.deleteItem(binned));
  accepted(value(await witness.drain()), [deleted.id]);
  expect((await client.getItem(binnedChild)).status).toBe(404);
});
