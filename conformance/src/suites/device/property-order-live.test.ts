import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext, TypeSchema } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
  trackType,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * A row a device writes shows its properties in the order the server answers
 * them (`items/property-order-create`, `items/property-order-merge` and
 * `items/property-order-replace`), before the server has answered and after:
 * run against a real server and the real binary, through an offline create, a
 * merging edit, a whole edit and the drains that send them.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let device: CliDevice;
let type: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "order",
  ));
  // A subtype whose parent declares two fields and which declares two more
  // and one of its parent's again, none in alphabetical order.
  const suffix = ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const parent = `user.order_parent_${suffix}`;
  type = `user.order_child_${suffix}`;
  const schemas: TypeSchema[] = [
    {
      id: parent,
      fields: { zeta: { type: "string" }, alpha: { type: "string" } },
    },
    {
      id: type,
      parent,
      fields: {
        mid: { type: "string" },
        beta: { type: "string" },
        alpha: { type: "string", description: "again" },
      },
    },
  ];
  for (const schema of schemas) {
    const registered = await client.registerType(schema);
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackType(ctx, schema.id, client);
  }
  const minted = await client.createKey({
    label: `${ctx.source}-order`,
    source: `${ctx.source}-order`,
    default_tier: "library",
    type_permissions: { [type]: "write" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  device = new CliDevice({
    binary: requireBinary(),
    store: newStore("order"),
    url: apiUrl,
    key: minted.data.key,
  });
  value(await device.hydrate([type], "library"));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

async function shown(id: string): Promise<string[]> {
  return Object.keys(value(await device.get(id)).properties);
}

async function answered(id: string): Promise<string[]> {
  const read = await client.getItem(id);
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  return Object.keys(read.data.item.properties);
}

it("shows a create in the order the server answers it, before the answer and after", async () => {
  const sent = {
    extra1: "x",
    beta: "b",
    alpha: "a",
    extra0: "y",
    zeta: "z",
  };
  const queued = value(await device.create({ type, properties: sent }));
  const id = queued.item_id ?? "";
  trackItem(ctx, id);
  // The declared fields first, then the rest as sent.
  const order = ["zeta", "alpha", "beta", "extra1", "extra0"];
  // The witness: the order sent is neither this one nor alphabetical.
  expect(Object.keys(sent)).not.toEqual(order);
  expect(
    await shown(id),
    "the copy showed the create in another order than the server answers",
  ).toEqual(order);

  expect(
    value(await device.drain()).verdicts.map((verdict) => verdict.verdict),
  ).toEqual(["accepted"]);
  expect(await answered(id)).toEqual(order);
  expect(await shown(id)).toEqual(order);
});

/** The names in the order a text holds them, which a parsed object cannot show for a name such as `10`. */
function writtenOrder(text: string, names: string[]): string[] {
  return names
    .map((name) => ({ name, at: text.indexOf(`"${name}":`) }))
    .filter(({ at }) => at >= 0)
    .sort((x, y) => x.at - y.at)
    .map(({ name }) => name);
}

it("holds a property named by a number in the order it was written, as the server answers it", async () => {
  // Text, since a JavaScript object writes `10` and `2` out ahead of the rest.
  const propertiesText = '{"beta":"b","10":"ten","2":"two","extra":"x"}';
  const names = Object.keys(JSON.parse(propertiesText));
  const queued = value(await device.create({ type, propertiesText }));
  const id = queued.item_id ?? "";
  trackItem(ctx, id);
  // The declared field first, then the rest as sent: no name moves ahead
  // of another for reading as a number.
  const order = ["beta", "10", "2", "extra"];
  expect(
    writtenOrder(value(await device.getText(id)), names),
    "the copy moved a property named by a number",
  ).toEqual(order);
  expect(
    value(await device.drain()).verdicts.map((verdict) => verdict.verdict),
  ).toEqual(["accepted"]);
  const served = await fetch(`${apiUrl}/items/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  expect(writtenOrder(await served.text(), names)).toEqual(order);
  expect(writtenOrder(value(await device.getText(id)), names)).toEqual(order);
});

it("shows an edit in the order the server answers it, before the answer and after", async () => {
  const queued = value(
    await device.create({ type, properties: { extra1: "x", beta: "b" } }),
  );
  const id = queued.item_id ?? "";
  trackItem(ctx, id);
  value(await device.drain());
  const created = value(await device.get(id));
  expect(Object.keys(created.properties)).toEqual(["beta", "extra1"]);

  // A merge moves no key the row holds, and a declared field it adds goes
  // after them as any other does.
  value(
    await device.update(id, {
      properties: { anchor: "n", zeta: "z" },
      version: created.version,
    }),
  );
  const merged = ["beta", "extra1", "anchor", "zeta"];
  expect(await shown(id)).toEqual(merged);
  value(await device.drain());
  expect(await answered(id)).toEqual(merged);
  expect(await shown(id)).toEqual(merged);

  // A whole edit holds the properties in the order it sends them.
  const read = value(await device.get(id));
  value(
    await device.update(id, {
      properties: { mid: "m", anchor: "n", beta: "b" },
      version: read.version,
      replace: true,
    }),
  );
  const whole = ["mid", "anchor", "beta"];
  expect(await shown(id)).toEqual(whole);
  value(await device.drain());
  expect(await answered(id)).toEqual(whole);
  expect(await shown(id)).toEqual(whole);
});

it("keeps a whole edit's order through a hydration and onto an answer ahead of it", async () => {
  const queued = value(
    await device.create({
      type,
      properties: { extra1: "x", beta: "b", mid: "m" },
    }),
  );
  const id = queued.item_id ?? "";
  trackItem(ctx, id);
  value(await device.drain());
  const read = value(await device.get(id));

  // A whole edit laid back over the refilled copy keeps the order it sends.
  value(
    await device.update(id, {
      properties: { mid: "m", extra1: "x", beta: "b2" },
      version: read.version,
      replace: true,
    }),
  );
  value(await device.hydrate([type], "library"));
  const sent = ["mid", "extra1", "beta"];
  expect(await shown(id), "a hydration reordered a whole edit").toEqual(sent);
  value(await device.drain());
  expect(await answered(id)).toEqual(sent);
  expect(await shown(id)).toEqual(sent);

  // Two whole edits made before a drain: the second, moved onto the first's
  // answer, still goes in the order it was made in.
  const again = value(await device.get(id));
  value(
    await device.update(id, {
      properties: { mid: "m", extra1: "x2", beta: "b2" },
      version: again.version,
      replace: true,
    }),
  );
  value(
    await device.update(id, {
      properties: { beta: "b3", mid: "m", extra1: "x2" },
      version: again.version,
      replace: true,
    }),
  );
  const second = ["beta", "mid", "extra1"];
  expect(await shown(id)).toEqual(second);
  expect(
    value(await device.drain()).verdicts.map((verdict) => verdict.verdict),
  ).toEqual(["accepted", "accepted"]);
  expect(
    await answered(id),
    "the second edit's order was lost when it moved onto the first's answer",
  ).toEqual(second);
  expect(await shown(id)).toEqual(second);
});
