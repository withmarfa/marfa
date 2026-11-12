import { afterAll, beforeAll, expect, it } from "vitest";
import { dirname } from "node:path";
import { rmSync } from "node:fs";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackType,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
let valuesType: string;
let store: string;

beforeAll(async () => {
  const context = await createTestContext(
    "device",
    "property-validation-edges",
  );
  ({ client, ctx } = context);
  valuesType = `fixture.${ctx.runId}.values`;
  expect(
    (
      await client.registerType({
        id: valuesType,
        fields: {
          title: { type: "string", required: true },
          weight: { type: "number" },
        },
      })
    ).ok,
  ).toBe(true);
  trackType(ctx, valuesType);
  store = newStore("property-validation-edges");
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: context.apiUrl,
    key: context.apiKey,
  });
  expect((await device.hydrate([valuesType], "library")).ok).toBe(true);
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
  if (store) rmSync(dirname(store), { recursive: true, force: true });
});

/** The digits a float is served as, for each number a write is refused for. */
const KEPT_AS: Record<string, string> = {
  "1500000000000000001": "1500000000000000000",
  "1152921504606846976": "1152921504606847000",
  "1000000000000000000000": "1e+21",
  "-0": "0",
};

const message = (digits: string) =>
  `Must be a whole number that Marfa serves back with the same digits, not ${digits}, which it serves as ${KEPT_AS[digits]}. Send it as a string.`;

let linked: { from: string; to: string; edge: string; version: number };
async function linkedItems() {
  if (linked) return linked;
  const made = [];
  for (const title of ["from", "to"]) {
    const item = await device.create({
      type: valuesType,
      properties: { title },
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error("the device refused an item");
    trackItem(ctx, item.value.item_id!);
    made.push(item.value.item_id!);
  }
  const edge = await device.createEdge({
    source: made[0]!,
    target: made[1]!,
    type: "references",
  });
  expect(edge.ok).toBe(true);
  expect((await device.drain()).ok).toBe(true);
  const held = await device.edgesFrom(made[0]!);
  expect(held.ok && held.value).toHaveLength(1);
  if (!held.ok) throw new Error("the device holds no edge");
  linked = {
    from: made[0]!,
    to: made[1]!,
    edge: held.value[0]!.id,
    version: held.value[0]!.version,
  };
  return linked;
}

it.each([
  ["1500000000000000001"],
  ["1152921504606846976"],
  ["1000000000000000000000"],
  ["-0"],
])(
  "refuses %s in the properties of an edge and the data of an extension on both paths with one message",
  async (digits) => {
    const { from, to, edge, version } = await linkedItems();
    const nested = `{"weight":${digits},"list":[1,${digits}]}`;
    const before = await device.queue();
    const refusedOnBoth = async (
      server: Awaited<ReturnType<typeof client.rawRequest>>,
      local: { ok: boolean; refusal?: { raw: string } },
      field: string,
    ) => {
      expect(server.ok).toBe(false);
      expect((server.error as { error: { code: string } }).error.code).toBe(
        "invalid_properties",
      );
      expect(
        (
          server.error as {
            error: { details?: { errors?: unknown } };
          }
        ).error.details?.errors,
      ).toEqual([{ field, message: message(digits) }]);
      expect(local.ok).toBe(false);
      expect(local.refusal?.raw).toContain(`${field}: ${message(digits)}`);
    };
    const json = { "Content-Type": "application/json" };
    await refusedOnBoth(
      await client.rawRequest("/edges", {
        method: "POST",
        headers: json,
        body: `{"source_id":"${from}","target_id":"${to}","edge_type":"about","properties":${nested}}`,
      }),
      await device.createEdge({
        source: from,
        target: to,
        type: "about",
        propertiesText: nested,
      }),
      "weight",
    );
    await refusedOnBoth(
      await client.rawRequest(`/edges/${edge}`, {
        method: "PATCH",
        headers: json,
        body: `{"version":${version},"properties":${nested}}`,
      }),
      await device.updateEdge(edge, {
        properties: {},
        propertiesText: nested,
        version,
      }),
      "weight",
    );
    await refusedOnBoth(
      await client.rawRequest(`/items/${from}/extensions/fixture.digits`, {
        method: "PUT",
        headers: json,
        body: nested,
      }),
      await device.writeExtensionText(from, "fixture.digits", nested),
      "weight",
    );
    expect(await device.queue()).toEqual(before);
  },
);
