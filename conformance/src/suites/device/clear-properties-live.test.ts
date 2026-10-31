import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * Removing named properties from an item through the copy, before the drain
 * and after, against what the server does with the same write.
 */

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
beforeAll(async () => {
  let apiUrl: string;
  ({ client, ctx, apiUrl } = await createTestContext("device", "clears"));
  const minted = await client.createKey({
    label: `${ctx.source}-clears`,
    source: `${ctx.source}-clears`,
    default_tier: "library",
    type_permissions: { "core.note": "write", "core.message": "write" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  device = new CliDevice({
    binary: requireBinary(),
    store: newStore("clears"),
    url: apiUrl,
    key: minted.data.key,
  });
  value(await device.hydrate(["core.note", "core.message"], "library"));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

async function shown(id: string): Promise<Record<string, unknown>> {
  return value(await device.get(id)).properties;
}

async function answered(id: string) {
  const read = await client.getItem(id);
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  return read.data.item;
}

async function synced(
  type: string,
  properties: Record<string, unknown>,
): Promise<{ id: string; version: number }> {
  const id = value(await device.create({ type, properties })).item_id ?? "";
  trackItem(ctx, id);
  value(await device.drain());
  return { id, version: value(await device.get(id)).version };
}

it("shows a clear at once, sends it as clear_properties, and keeps every property it does not name", async () => {
  const { id, version } = await synced("core.note", {
    body: "kept",
    notes: "gone",
    courier: { nested: ["undeclared", 1] },
  });
  const queued = value(
    await device.update(id, {
      properties: {},
      version,
      clear: ["notes", "never-held"],
    }),
  );
  expect(queued.body).toMatchObject({
    clear_properties: ["notes", "never-held"],
    version,
  });
  const kept = { body: "kept", courier: { nested: ["undeclared", 1] } };
  expect(await shown(id), "the copy still showed what it cleared").toEqual(
    kept,
  );
  value(await device.drain());
  expect((await answered(id)).properties).toEqual(kept);
  expect(await shown(id)).toEqual(kept);
});

it("refuses a property both set and cleared, and a required field, queuing nothing", async () => {
  const { id, version } = await synced("core.message", {
    from: "Sender",
    to: ["Recipient"],
  });
  const before = value(await device.queue()).length;
  const both = await device.update(id, {
    properties: { to: ["Other"] },
    version,
    clear: ["to"],
  });
  expect(!both.ok && both.refusal.code).toBe("validation");
  expect(!both.ok && both.refusal.raw).toContain("validation_error");
  const required = await device.update(id, {
    properties: {},
    version,
    clear: ["from"],
  });
  expect(!required.ok && required.refusal.code).toBe("validation");
  expect(!required.ok && required.refusal.raw).toContain("invalid_properties");
  expect(value(await device.queue()).length).toBe(before);
  expect(await shown(id)).toEqual({ from: "Sender", to: ["Recipient"] });

  // The witness: an optional field clears.
  value(await device.update(id, { properties: {}, version, clear: ["to"] }));
  value(await device.drain());
  expect((await answered(id)).properties).toEqual({ from: "Sender" });
});

it("lands a queued clear over another writer's change to a different property", async () => {
  const { id, version } = await synced("core.note", {
    title: "Original",
    body: "kept",
    notes: "gone",
  });
  value(await device.update(id, { properties: {}, version, clear: ["notes"] }));
  const elsewhere = await client.updateItem(id, {
    properties: { title: "Changed elsewhere", added: "since" },
    version,
  });
  expect(elsewhere.ok, JSON.stringify(elsewhere.error)).toBe(true);

  value(await device.drain());
  const merged = {
    title: "Changed elsewhere",
    body: "kept",
    added: "since",
  };
  expect((await answered(id)).properties).toEqual(merged);
  expect(await shown(id)).toEqual(merged);
});

it("keeps another writer's change to the property a queued clear names", async () => {
  const { id, version } = await synced("core.note", {
    title: "Original",
    body: "kept",
    notes: "mine",
  });
  value(await device.update(id, { properties: {}, version, clear: ["notes"] }));
  const elsewhere = await client.updateItem(id, {
    properties: { notes: "changed elsewhere" },
    version,
  });
  expect(elsewhere.ok, JSON.stringify(elsewhere.error)).toBe(true);

  value(await device.drain());
  const server = await answered(id);
  // The other writer's value is not lost to a removal made before it.
  expect(server.properties.notes).toBe("changed elsewhere");
  expect(await shown(id)).toEqual(server.properties);
  const [row] = value(await device.queue()).filter(
    (write) => write.item_id === id && write.kind === "update_item",
  );
  // Settled under `conflict=auto`: the device's removal is set aside as a
  // conflicted copy, not dropped.
  expect(row?.verdict, JSON.stringify(row)).toBe("conflicted");
  const copyId = row?.conflicted_copy_id ?? "";
  expect(copyId).not.toBe("");
  trackItem(ctx, copyId);
  const copy = await client.getItem(copyId);
  expect(copy.ok, JSON.stringify(copy.error)).toBe(true);
  expect(copy.data.item.properties.notes).toBeUndefined();
  expect(copy.data.item.properties.body).toBe("kept");
});

it("sends a clear made on a version read earlier, and the server judges it there", async () => {
  const { id, version } = await synced("core.note", {
    title: "Original",
    body: "kept",
    notes: "gone",
  });
  const elsewhere = await client.updateItem(id, {
    properties: { title: "Changed elsewhere" },
    version,
  });
  expect(elsewhere.ok, JSON.stringify(elsewhere.error)).toBe(true);
  value(await device.catchUp());
  expect(value(await device.get(id)).version).toBe(version + 1);

  value(
    await device.update(id, {
      properties: {},
      version,
      asRead: true,
      clear: ["notes"],
    }),
  );
  expect(await shown(id)).toEqual({ title: "Changed elsewhere", body: "kept" });
  value(await device.drain());
  expect((await answered(id)).properties).toEqual({
    title: "Changed elsewhere",
    body: "kept",
  });
});

it("drops from a moved clear a property it read no value for", async () => {
  const { id, version } = await synced("core.note", {
    title: "Original",
    body: "kept",
    notes: "gone",
  });
  value(await device.update(id, { properties: { body: "first" }, version }));
  const behind = value(
    await device.update(id, {
      properties: {},
      version,
      clear: ["notes", "added"],
    }),
  );
  // Another writer adds the property the second edit names but never saw.
  const elsewhere = await client.updateItem(id, {
    properties: { added: "since" },
    version,
  });
  expect(elsewhere.ok, JSON.stringify(elsewhere.error)).toBe(true);

  value(await device.drain());
  const [moved] = value(await device.queue()).filter(
    (write) => write.id === behind.id,
  );
  expect(
    moved?.base_version,
    "the clear did not move onto the answer to the edit ahead of it, so nothing below is about a move",
  ).toBe(version + 2);
  expect(moved?.body).toMatchObject({ clear_properties: ["notes"] });
  const server = await answered(id);
  expect(server.properties).toEqual({
    title: "Original",
    body: "first",
    added: "since",
  });
  expect(await shown(id)).toEqual(server.properties);
});
