import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * A queued transition names the state the copy showed for its item
 * (`queue-and-verdicts/transition-names-from`), so a device that was offline
 * cannot undo a state change another device made meanwhile. Against a real
 * server and the real binary, with a second device or a direct write as the
 * other device.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "transition-from",
  ));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

async function device(label: string): Promise<CliDevice> {
  const made = new CliDevice({
    binary: requireBinary(),
    store: newStore(`transition-from-${label}`),
    url: apiUrl,
    key: apiKey,
  });
  value(await made.hydrate(["core.note"], "library"));
  return made;
}

async function note(title: string): Promise<string> {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title, body: title },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function serverState(id: string): Promise<string | undefined> {
  const listed = await client.listItems({
    state: "any",
    filter: `id eq "${id}"`,
    limit: 10,
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  return listed.data.data[0]?.state;
}

it("refuses a queued unarchive once another device has trashed the item, and leaves it and what its trash took in the bin", async () => {
  const parent = await note("parent");
  const child = await note("child");
  const edge = await client.createEdge({
    from_id: parent,
    to_id: child,
    edge_type: "parent-of",
  });
  expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
  const a = await device("a");
  const b = await device("b");

  value(await a.transitionItem(parent, "archived"));
  value(await a.drain());
  expect(await serverState(parent)).toBe("archived");

  // Offline, A undoes its archive.
  const undo = value(await a.transitionItem(parent, "active"));
  expect(undo.body).toEqual({ state: "active", from: "archived" });
  expect(value(await a.get(parent)).state).toBe("active");

  // B, which held the item archived, moves it to the bin.
  value(await b.catchUp());
  value(await b.deleteItem(parent));
  value(await b.drain());
  expect(await serverState(parent)).toBe("trashed");
  // The witness: the trash took the child with it.
  expect(await serverState(child)).toBe("trashed");

  // A comes back online and sends its undo before it catches up.
  const report = value(await a.drain());
  expect(
    report.verdicts.find((row) => row.id === undo.id),
    JSON.stringify(report),
  ).toMatchObject({ verdict: "refused", reason: "state_conflict" });
  const row = value(await a.queue()).find((queued) => queued.id === undo.id);
  expect(row?.refusal).toMatchObject({ code: "state_conflict" });
  expect(await serverState(parent)).toBe("trashed");
  expect(await serverState(child)).toBe("trashed");
  expect(value(await a.get(parent)).state).toBe("trashed");

  // The refused undo is the person's to discard, as any refused write is.
  expect(value(await a.discard(undo.id))).toBe(true);
  expect(
    value(await a.queue()).some((queued) => queued.id === undo.id),
  ).toBe(false);
  expect(value(await a.get(parent)).state).toBe("trashed");

  // The witness: a transition out of the bin that names no state brings the
  // child back, so the bin above held what the trash took.
  const restored = await client.transitionItem(parent, "active");
  expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
  expect(await serverState(child)).toBe("active");
});

it("refuses a queued undo to active once another device has restored and archived the item, which stays archived", async () => {
  const id = await note("undo after restore and archive");
  const a = await device("undo");

  value(await a.deleteItem(id));
  value(await a.drain());
  expect(await serverState(id)).toBe("trashed");

  // Offline, A takes the item out of the bin by moving it to active.
  const undo = value(await a.transitionItem(id, "active"));
  expect(undo.body).toEqual({ state: "active", from: "trashed" });

  // Elsewhere the item is restored and archived.
  expect((await client.restoreItem(id)).ok).toBe(true);
  expect((await client.transitionItem(id, "archived")).ok).toBe(true);

  const report = value(await a.drain());
  expect(
    report.verdicts.find((row) => row.id === undo.id),
    JSON.stringify(report),
  ).toMatchObject({ verdict: "refused", reason: "state_conflict" });
  expect(await serverState(id)).toBe("archived");
  expect(value(await a.get(id)).state).toBe("archived");
});

it("shows the server's state beneath a waiting transition whose from the item has left", async () => {
  const id = await note("laid transition");
  const a = await device("laid");

  value(await a.transitionItem(id, "archived"));
  value(await a.drain());
  const undo = value(await a.transitionItem(id, "active"));
  // The witness: laid over the row as the server holds it, the undo shows.
  value(await a.catchUp());
  expect(value(await a.get(id)).state).toBe("active");

  expect((await client.deleteItem(id)).ok).toBe(true);
  value(await a.catchUp());
  expect(value(await a.get(id)).state).toBe("trashed");
  const row = value(await a.queue()).find((queued) => queued.id === undo.id);
  expect(row?.verdict).toBeNull();
});

it("refuses, queueing nothing, a transition whose expected state the copy does not show", async () => {
  const id = await note("expected state");
  const a = await device("expected");

  const refused = await a.transitionItem(id, "archived", "trashed");
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.refusal.code).toBe("state_conflict");
  expect(value(await a.queue())).toHaveLength(0);
  expect(value(await a.get(id)).state).toBe("active");

  // The witness: the same move expecting the state the copy shows is queued.
  const queued = value(await a.transitionItem(id, "archived", "active"));
  expect(queued.body).toEqual({ state: "archived", from: "active" });
});
