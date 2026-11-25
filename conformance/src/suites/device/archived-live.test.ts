import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { DrainReport, Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackEdgeType,
  trackItem,
} from "../../utils/setup.js";
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

it("queues and sends an edit, tags and an extension for an archived item as for an active one, and leaves its state", async () => {
  for (const held of ["active", "archived"] as const) {
    const mine = await note(held, `mine-${held}`);
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
    const later = [
      value(await device.replaceTags(mine, ["replaced"])),
      value(await device.removeTag(mine, "replaced")),
      value(await device.deleteExtension(mine, "app.archived")),
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
    expect(after.data.item.state, held).toBe(held);
    expect(value(await device.get(mine)).state, held).toBe(held);
  }
});

it("queues and sends the creation, change, move and removal of an edge with an archived item at either end, as for an active one", async () => {
  // A one-to-one type, whose edge can move an end, since the end that stays holds only it.
  const movable = `mock.archived-move.${ctx.runId}`;
  const registered = await client.registerEdgeType({
    label: "Test edge type",
    id: movable,
    cardinality: "one-to-one",
  });
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  trackEdgeType(ctx, movable);

  for (const held of ["active", "archived"] as const) {
    for (const end of ["from", "to"] as const) {
      const label = `${held} at the ${end} end`;
      const mine = await note(held, `mine-${label}`);
      const other = await note("active", `other-${label}`);
      const third = await note("active", `third-${label}`);
      const device = await deviceHolding(`archived-edges-${held}-${end}`);
      const ends =
        end === "from"
          ? { source: mine, target: other }
          : { source: other, target: mine };

      const made = value(
        await device.createEdge({
          ...ends,
          type: "references",
          properties: { since: held },
        }),
      );
      const loose = value(
        await device.createEdge({
          source: other,
          target: third,
          type: movable,
        }),
      );
      accepted(value(await device.drain()), [made.id, loose.id]);
      const madeId = made.edge_id!;
      const looseId = loose.edge_id!;
      expect((await client.getEdge(madeId)).data.edge, label).toMatchObject({
        from_id: ends.source,
        to_id: ends.target,
      });

      const moved = value(
        await device.updateEdge(looseId, {
          properties: {},
          version: value(await device.edge(looseId)).version,
          ...(end === "from" ? { from_id: mine } : { to_id: mine }),
        }),
      )!;
      const answered = await device.drain();
      if (end === "from") {
        // A move of an edge's source changes the reach (`reach/moves-edge-from`):
        // the move is answered and the copy expires.
        expect(answered.ok, label).toBe(false);
        if (!answered.ok)
          expect(answered.refusal.code, label).toBe("copy_expired");
      } else {
        accepted(value(answered), [moved.id]);
      }
      expect((await client.getEdge(looseId)).data.edge, label).toMatchObject(
        end === "from"
          ? { from_id: mine, to_id: third }
          : { from_id: other, to_id: mine },
      );

      const later = await deviceHolding(`archived-edges-later-${held}-${end}`);
      const changed = value(
        await later.updateEdge(madeId, {
          properties: { note: held },
          version: value(await later.edge(madeId)).version,
        }),
      )!;
      accepted(value(await later.drain()), [changed.id]);
      expect(
        (await client.getEdge(madeId)).data.edge.properties,
        label,
      ).toEqual({ since: held, note: held });

      const removed = [
        value(await later.deleteEdge(madeId)),
        value(await later.deleteEdge(looseId)),
      ];
      accepted(
        value(await later.drain()),
        removed.map((write) => write.id),
      );
      expect((await client.getEdge(madeId)).status, label).toBe(404);
      expect((await client.getEdge(looseId)).status, label).toBe(404);
      expect((await client.getItem(mine)).data.item.state, label).toBe(held);
    }
  }
});

it("moves no other item the copy holds when it archives an item holding parent-of children", async () => {
  async function drained(state: "archived" | "trashed", label: string) {
    const host = await note("active", `host-${label}`);
    const child = await note("active", `child-${label}`);
    const grandchild = await note("active", `grandchild-${label}`);
    for (const [from_id, to_id] of [
      [host, child],
      [child, grandchild],
    ] as const) {
      const edge = await client.createEdge({
        from_id,
        to_id,
        edge_type: "parent-of",
      });
      expect(edge.status, JSON.stringify(edge.error)).toBe(201);
    }
    const device = await deviceHolding(`archived-no-cascade-${label}`);
    const move = value(await device.transitionItem(host, state));
    accepted(value(await device.drain()), [move.id]);
    return { device, host, child, grandchild };
  }

  // The witness: the same move into the bin, read at the same point, takes the children.
  const control = await drained("trashed", "bin");
  expect((await client.getItem(control.host)).status).toBe(404);
  for (const id of [control.child, control.grandchild]) {
    expect((await client.getItem(id)).status, id).toBe(404);
  }

  const archive = await drained("archived", "archive");
  expect((await client.getItem(archive.host)).data.item.state).toBe("archived");
  expect(value(await archive.device.get(archive.host)).state).toBe("archived");
  for (const id of [archive.child, archive.grandchild]) {
    expect((await client.getItem(id)).data.item.state, id).toBe("active");
    expect(value(await archive.device.get(id)).state, id).toBe("active");
  }
});
