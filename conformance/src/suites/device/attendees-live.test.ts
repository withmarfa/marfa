import { afterAll, beforeAll, expect, it } from "vitest";
import { dirname } from "node:path";
import { rmSync } from "node:fs";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
let store: string;

beforeAll(async () => {
  const context = await createTestContext("device", "attendees");
  ({ client, ctx } = context);
  store = newStore("attendees-live");
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: context.apiUrl,
    key: context.apiKey,
  });
  // Opens the copy without hydrating a type, so the device judges `core.event`
  // by the catalog it ships with.
  expect((await device.status()).ok).toBe(true);
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
  if (store) rmSync(dirname(store), { recursive: true, force: true });
});

it("refuses on the device the attendee the server refuses", async () => {
  const starts_at = "2032-05-10T10:00:00.000Z";
  const taken = {
    title: "Planning",
    starts_at,
    attendees: [
      { email: "sam@example.test", response: "accepted" },
      { name: "Alex" },
    ],
  };
  const serverTook = await client.createItem({
    type: "core.event",
    properties: taken,
  });
  expect(serverTook.ok, JSON.stringify(serverTook.error)).toBe(true);
  if (serverTook.ok) trackItem(ctx, serverTook.data.item.id);
  const deviceTook = await device.create({
    type: "core.event",
    properties: taken,
  });
  expect(deviceTook.ok, JSON.stringify(deviceTook)).toBe(true);
  const before = await device.queue();

  const bad: [string, string, unknown][] = [
    ["attendees.0.response", "Item 0: response:", [{ response: "maybe" }]],
    [
      "attendees.1.email",
      "Item 1: email:",
      [{ name: "Sam" }, { email: "not an email" }],
    ],
    ["attendees.0.role", "Item 0: role:", [{ name: "Sam", role: "chair" }]],
    ["attendees.0", "Item 0: Must have at least one member", [{}]],
  ];
  for (const [named, message, attendees] of bad) {
    const properties = { title: "Planning", starts_at, attendees };
    const server = await client.createItem({ type: "core.event", properties });
    expect(server.ok, named).toBe(false);
    expect(server.error?.error.code).toBe("invalid_properties");
    const local = await device.create({ type: "core.event", properties });
    expect(local.ok, named).toBe(false);
    if (!local.ok) expect(local.refusal.raw, named).toContain(message);
  }
  expect(await device.queue()).toEqual(before);
});
