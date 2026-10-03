import { afterAll, beforeAll, expect, it } from "vitest";
import { dirname } from "node:path";
import { rmSync } from "node:fs";
import type { MarfaClient } from "../../client/api.js";
import type { FieldDefinition, TestContext } from "../../client/types.js";
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
let type: string;
let store: string;
const fields: Record<string, FieldDefinition> = {
  title: { type: "string", required: true, maxLength: 5 },
  read: { type: "boolean" },
  count: { type: "integer" },
  choice: { type: "enum", enum_values: ["yes", "no"] },
  list: { type: "array", maxItems: 2, items_type: "string" },
  date: { type: "date" },
  time: { type: "datetime" },
  email: { type: "email" },
  url: { type: "url" },
  image: { type: "thumbnail" },
};

beforeAll(async () => {
  const context = await createTestContext("device", "property-validation");
  ({ client, ctx } = context);
  type = `fixture.${ctx.runId}.fields`;
  expect((await client.registerType({ id: type, fields })).ok).toBe(true);
  trackType(ctx, type);
  store = newStore("property-validation-live");
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: context.apiUrl,
    key: context.apiKey,
  });
  expect((await device.hydrate([type], "library")).ok).toBe(true);
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
  if (store) rmSync(dirname(store), { recursive: true, force: true });
});

it("matches a real server's field decisions and keeps queued writes across a catalog change", async () => {
  const good = {
    title: "😀abc",
    read: null,
    count: 9007199254740991,
    choice: "yes",
    list: [false, {}],
    date: "0000-02-29",
    time: "2026-01-01T23:59+23:59",
    email: "reader+tag@example.test",
    url: "mailto:reader@example.test",
    image: "data:image/png;base64,iVBORw0KGgo=",
    custom: true,
  };
  const accepted = await client.createItem({ type, properties: good });
  expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
  trackItem(ctx, accepted.data.item.id);
  const local = await device.create({ type, properties: good });
  expect(local.ok).toBe(true);
  if (!local.ok) return;
  trackItem(ctx, local.value.item_id!);
  const drained = await device.drain();
  expect(drained.ok && drained.value.verdicts[0]?.verdict).toBe("accepted");
  const before = await device.queue();
  for (const [field, value] of [
    ["title", null],
    ["title", "😀abcd"],
    ["title", "a\u0000b"],
    ["read", "yes"],
    ["count", 9007199254740992],
    ["count", 1.5],
    ["choice", "maybe"],
    ["list", [1, 2, 3]],
    ["date", "1900-02-29"],
    ["time", "2026-01-01T12:00:00"],
    ["time", "2026-01-01T12:00+24:00"],
    ["email", "a..b@example.test"],
    ["url", "relative"],
    ["image", "data:image/png;base64,iVBORw0KGgp="],
  ] as Array<[string, unknown]>) {
    const properties = { title: "valid", [field]: value };
    const server = await client.createItem({ type, properties });
    expect(server.ok, `${field}: ${JSON.stringify(server.error)}`).toBe(false);
    expect(server.error?.error.code).toBe("invalid_properties");
    const refused = await device.create({ type, properties });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.raw).toContain(`${field}:`);
  }
  expect(await device.queue()).toEqual(before);
  const pending = await device.create({ type, properties: { title: "valid" } });
  expect(pending.ok).toBe(true);
  const schema = await client.getType(type);
  expect(schema.ok).toBe(true);
  expect(
    (
      await client.updateType(type, {
        version: schema.data.version,
        fields: { ...fields, added: { type: "string", required: true } },
      })
    ).ok,
  ).toBe(true);
  expect((await device.catchUp()).ok).toBe(true);
  const unchanged = await device.queue();
  expect(unchanged.ok && unchanged.value.at(-1)?.verdict).toBe(null);
  const refusal = await device.drain();
  expect(refusal.ok).toBe(true);
  if (refusal.ok) {
    expect(refusal.value.verdicts[0]?.verdict).toBe("refused");
    expect(
      refusal.value.verdicts[0]?.refusal?.fields.some(
        (field) => field.field === "added",
      ),
    ).toBe(true);
  }
  const kept = await device.queue();
  expect(kept.ok && kept.value.at(-1)?.body).toMatchObject({
    properties: { title: "valid" },
  });
});
