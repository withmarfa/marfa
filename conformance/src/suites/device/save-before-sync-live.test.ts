import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackType,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * "A copy saves before it has reached a server, and joins one later."
 *
 * Run against a real server and the real binary: a note saved with no server,
 * a type the app declared, a first hydration that registers it where the key
 * may and says so where it may not, and the queued write sent after the join.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext(
    "device",
    "save-before-sync",
  ));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

/** A key of the app's own: its namespace, and whether it may register a type. */
async function appKey(label: string, registers: boolean, namespace: string) {
  const minted = await client.createKey({
    label: `${ctx.source}-${label}`,
    source: `${ctx.source}-${label}`,
    default_tier: "library",
    type_permissions: { "core.note": "write", [namespace]: "write" },
    ...(registers ? { metadata_permissions: { types: "write" } } : {}),
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  ctx.trackedKeys.push(minted.data.id);
  return minted.data.key;
}

it("sends what it saved with no server once it has joined, after registering the type the key may", async () => {
  const type = `user.recipe_${ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const key = await appKey("registers", true, type);
  const store = newStore("save-live");
  const offline = new CliDevice({ binary: requireBinary(), store });
  value(await offline.status());
  value(
    await offline.declareTypes([
      {
        id: type,
        label: "Recipe",
        fields: {
          title: { type: "string", required: true },
          servings: { type: "number" },
        },
      },
    ]),
  );
  const refused = await offline.create({ type, properties: { servings: 4 } });
  expect(refused.ok ? "queued" : refused.refusal.code).toBe("validation");
  const saved = value(
    await offline.create({ type, properties: { title: "Soup", servings: 4 } }),
  );
  const kept = value(await offline.get(saved.item_id ?? ""));
  expect([kept.type, kept.tier]).toEqual([type, "library"]);
  expect(kept.source).toBe("device");

  // Joining: the first hydration registers the type the instance lacks.
  expect((await client.getType(type)).ok).toBe(false);
  const joined = offline.reopen({ url: apiUrl, key });
  const report = value(await joined.hydrate([type], "library"));
  expect(report.registered_types).toEqual([type]);
  expect(report.unregistered_types).toEqual([]);
  trackType(ctx, type, client);
  const registered = await client.getType(type);
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);

  // The queue survived the join, and a drain sends it.
  expect(value(await joined.queue()).map((row) => row.item_id)).toEqual([
    saved.item_id,
  ]);
  const drained = value(await joined.drain());
  expect(drained.verdicts.map((verdict) => verdict.verdict)).toEqual([
    "accepted",
  ]);
  const read = await client.getItem(saved.item_id ?? "");
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  trackItem(ctx, saved.item_id ?? "");
  expect(read.data.item.properties).toEqual({ title: "Soup", servings: 4 });
  expect(read.data.item.source).toBe(`${ctx.source}-registers`);
  expect(value(await joined.get(saved.item_id ?? "")).source).toBe(
    `${ctx.source}-registers`,
  );
});

it("says which declared types the key could not register, and the server refuses the write that names one", async () => {
  const type = `user.unregistered_${ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const key = await appKey("cannot-register", false, type);
  const store = newStore("save-live-unregistered");
  const offline = new CliDevice({ binary: requireBinary(), store });
  value(await offline.status());
  value(
    await offline.declareTypes([
      { id: type, fields: { title: { type: "string", required: true } } },
    ]),
  );
  const saved = value(
    await offline.create({ type, properties: { title: "Held back" } }),
  );
  const joined = offline.reopen({ url: apiUrl, key });
  // The slice cannot name a type the instance does not hold, so it names one
  // it does.
  const report = value(await joined.hydrate(["core.note"], "library"));
  expect(report.registered_types).toEqual([]);
  expect(report.unregistered_types.map((held) => held.id)).toEqual([type]);
  expect(report.unregistered_types[0]?.code).toBe("forbidden");
  expect((await client.getType(type)).ok).toBe(false);

  // The write waits for the server's own verdict, and the verdict is a refusal.
  const drained = value(await joined.drain());
  expect(drained.verdicts.map((verdict) => verdict.verdict)).toEqual([
    "refused",
  ]);
  expect(
    value(await joined.queue()).find((row) => row.item_id === saved.item_id)
      ?.verdict,
  ).toBe("refused");
});
