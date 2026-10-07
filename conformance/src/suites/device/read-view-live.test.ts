import { afterAll, beforeAll, expect, it } from "vitest";
import { dirname } from "node:path";
import { rmSync } from "node:fs";
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

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext("device", "read-view"));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});
function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

it.each(["retyping", "grant narrowing"])(
  "expires on real %s and rebuilds without losing unsent work",
  async (change) => {
    const minted = await client.createKey({
      label: `${ctx.source}-${change}`,
      source: `${ctx.source}-${change}`,
      type_permissions: {
        "core.note": "read",
        "core.task": change === "grant narrowing" ? "read" : "none",
      },
      default_tier: "library",
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      tier: "library",
      properties: { title: "held", body: "server original" },
    });
    expect(seed.ok, JSON.stringify(seed.error)).toBe(true);
    trackItem(ctx, seed.data.item.id);
    const store = newStore("read-view-live");
    const device = new CliDevice({
      binary: requireBinary(),
      store,
      url: apiUrl,
      key: minted.data.key,
    });
    try {
      value(await device.hydrate(["core.note"], "library"));
      expect(value(await device.get(seed.data.item.id)).properties.body).toBe(
        "server original",
      );
      const changed = await client.updateItem(seed.data.item.id, {
        version: seed.data.item.version,
        properties: { body: "ordinary update" },
      });
      expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
      value(await device.catchUp());
      expect(value(await device.get(seed.data.item.id)).properties.body).toBe(
        "ordinary update",
      );
      value(
        await device.update(seed.data.item.id, {
          version: changed.data.item.version,
          properties: { body: "unsent local edit" },
        }),
      );
      value(
        await device.create({
          type: "core.note",
          properties: { title: "unsent new note", body: "unsent local create" },
        }),
      );
      const before = value(await device.queue());
      if (change === "retyping") {
        const moved = await client.updateItem(seed.data.item.id, {
          type: "core.task",
          retype: true,
          version: changed.data.item.version,
        });
        expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
      } else {
        const narrowed = await client.updateKey(minted.data.id, {
          type_permissions: { "core.task": "read" },
        });
        expect(narrowed.ok, JSON.stringify(narrowed.error)).toBe(true);
      }
      const remote = await fetch(`${apiUrl}/items/${seed.data.item.id}`, {
        headers: { Authorization: `Bearer ${minted.data.key}` },
      });
      expect(remote.status).toBe(404);
      const caught = await device.catchUp();
      expect(caught.ok).toBe(false);
      if (!caught.ok) {
        expect(caught.refusal.code).toBe("copy_expired");
        expect(caught.refusal.raw).toContain("read_view_changed");
      }
      expect(value(await device.status()).hydration).toBe("expired");
      expect((await device.list()).ok).toBe(false);
      expect(value(await device.queue())).toEqual(before);
      if (change === "retyping") {
        const current = await client.getItem(seed.data.item.id);
        expect(current.ok).toBe(true);
        const restored = await client.updateItem(seed.data.item.id, {
          type: "core.note",
          retype: true,
          version: current.data.item.version,
        });
        expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
      } else {
        const restored = await client.updateKey(minted.data.id, {
          type_permissions: { "core.note": "read", "core.task": "read" },
        });
        expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
      }
      value(await device.hydrate(["core.note"], "library"));
      expect(value(await device.queue())).toEqual(before);
      expect(value(await device.get(seed.data.item.id)).properties.body).toBe(
        "unsent local edit",
      );
      expect(
        value(await device.list()).some(
          (item) => item.properties.body === "unsent local create",
        ),
      ).toBe(true);
    } finally {
      rmSync(dirname(store), { recursive: true, force: true });
    }
  },
);

it("keeps real direct pins separate from source-filtered listing membership", async () => {
  const allowed = ctx.source;
  const excluded = `${ctx.source}-excluded`;
  const minted = await client.createKey({
    label: `${ctx.source}-filter`,
    source: `${ctx.source}-filter`,
    type_permissions: { "core.note": "read" },
    enforcement_override: {
      source_filter: { types: ["core.note"], sources: [allowed] },
    },
    default_tier: "library",
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  const writer = await client.createKey({ label: excluded, source: excluded });
  expect(writer.ok, JSON.stringify(writer.error)).toBe(true);
  trackKey(ctx, writer.data.id);
  const excludedClient = new MarfaClient({
    baseUrl: apiUrl,
    apiKey: writer.data.key,
  });
  const ids: string[] = [];
  for (const source of [allowed, excluded]) {
    const made = await (
      source === allowed ? client : excludedClient
    ).createItem({
      type: "core.note",
      source,
      tier: "library",
      properties: { title: source, body: source },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    ids.push(made.data.item.id);
  }
  const store = newStore("read-view-pins");
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: minted.data.key,
  });
  try {
    value(await device.hydrate(["core.note"], "library"));
    expect(value(await device.list()).map((item) => item.id)).toContain(ids[0]);
    expect((await device.get(ids[1]!)).ok).toBe(false);
    value(await device.pin(ids[1]!));
    expect(value(await device.get(ids[1]!)).properties.body).toBe(excluded);
    value(await device.unpin(ids[1]!));
    expect((await device.get(ids[1]!)).ok).toBe(false);
    const changed = await client.updateKey(minted.data.id, {
      enforcement_override: {
        source_filter: { types: ["core.note"], sources: [excluded] },
      },
    });
    expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
    const caught = await device.catchUp();
    expect(caught.ok).toBe(false);
    if (!caught.ok) expect(caught.refusal.code).toBe("copy_expired");
    value(await device.hydrate(["core.note"], "library"));
    const rebuilt = value(await device.list()).map((item) => item.id);
    expect(rebuilt).toContain(ids[1]);
    expect(rebuilt).not.toContain(ids[0]);
  } finally {
    rmSync(dirname(store), { recursive: true, force: true });
  }
});

it("ends a real held stream when grants narrow, keeping unsent work", async () => {
  const minted = await client.createKey({
    label: `${ctx.source}-follow`,
    source: `${ctx.source}-follow`,
    type_permissions: { "core.note": "read" },
    default_tier: "library",
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  const seed = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title: "follow witness", body: "before" },
  });
  expect(seed.ok, JSON.stringify(seed.error)).toBe(true);
  trackItem(ctx, seed.data.item.id);
  const store = newStore("read-view-follow");
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: minted.data.key,
  });
  let following: ReturnType<CliDevice["holdFollow"]> | undefined;
  try {
    value(await device.hydrate(["core.note"], "library"));
    value(
      await device.create({
        type: "core.note",
        properties: { title: "queued", body: "kept during follow" },
      }),
    );
    const before = value(await device.queue());
    following = device.holdFollow(90);
    const changed = await client.updateItem(seed.data.item.id, {
      version: seed.data.item.version,
      properties: { body: "delivery witness" },
    });
    expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
    await expect
      .poll(() => following!.stdout.includes(seed.data.item.id), {
        timeout: 30_000,
      })
      .toBe(true);
    const narrowed = await client.updateKey(minted.data.id, {
      type_permissions: {},
    });
    expect(narrowed.ok, JSON.stringify(narrowed.error)).toBe(true);
    await expect
      .poll(() => following!.running(), { timeout: 45_000 })
      .toBe(false);
    await following.exited();
    expect(JSON.parse(following.stderr).error.code).toBe("copy_expired");
    expect(value(await device.status()).hydration).toBe("expired");
    expect((await device.list()).ok).toBe(false);
    expect(value(await device.queue())).toEqual(before);
  } finally {
    await following?.stop();
    rmSync(dirname(store), { recursive: true, force: true });
  }
});
