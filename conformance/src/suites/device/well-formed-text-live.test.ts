import { afterAll, beforeAll, expect, it } from "vitest";
import { dirname } from "node:path";
import { rmSync } from "node:fs";
import { v7 as uuidv7 } from "uuid";
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
let apiUrl: string;
let apiKey: string;
let type: string;
let first: string;
let second: string;

beforeAll(async () => {
  const context = await createTestContext("device", "well-formed-text");
  ({ client, ctx, apiUrl, apiKey } = context);
  type = `fixture.${ctx.runId}.wellformed`;
  expect(
    (
      await client.registerType({
        id: type,
        fields: { body: { type: "string" } },
      })
    ).ok,
  ).toBe(true);
  trackType(ctx, type);
  first = newStore("well-formed-text-first");
  second = newStore("well-formed-text-second");
});

afterAll(async () => {
  if (ctx) await cleanup(ctx);
  for (const store of [first, second]) {
    if (store) rmSync(dirname(store), { recursive: true, force: true });
  }
});

function device(store: string): CliDevice {
  return new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: apiKey,
  });
}

/** The wire text of a create whose property name and value hold `text`. */
function create(id: string, text: string): string {
  return JSON.stringify({
    id,
    type,
    source: ctx.source,
    properties: { body: `a ${text}`, [`name ${text}`]: [text] },
  });
}

async function post(body: string): Promise<Response> {
  return fetch(`${apiUrl}/items`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body,
  });
}

it("refuses text that is not well-formed UTF-16 and leaves a device able to hydrate and catch up over the row that is", async () => {
  const caughtUp = device(first);
  expect((await caughtUp.hydrate([type], "library")).ok).toBe(true);

  const lone = uuidv7();
  const refused = await post(create(lone, "\ud83d"));
  expect(refused.status).toBe(400);
  expect(
    ((await refused.json()) as { error: { code: string } }).error.code,
  ).toBe("validation_error");
  expect((await client.getItem(lone)).status).toBe(404);

  const pair = uuidv7();
  const accepted = await post(create(pair, "😀"));
  expect(accepted.status, await accepted.clone().text()).toBe(201);
  trackItem(ctx, pair);

  const caught = await caughtUp.catchUp();
  expect(caught.ok, JSON.stringify(caught)).toBe(true);
  if (caught.ok) expect(caught.value.applied).toBeGreaterThan(0);
  const held = await caughtUp.get(pair);
  expect(held.ok, JSON.stringify(held)).toBe(true);
  if (held.ok) {
    expect(held.value.properties).toMatchObject({
      body: "a 😀",
      "name 😀": ["😀"],
    });
  }

  const hydrated = await device(second).hydrate([type], "library");
  expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
  if (hydrated.ok) expect(hydrated.value.items).toBe(1);
  expect((await device(second).get(lone)).ok).toBe(false);
});
