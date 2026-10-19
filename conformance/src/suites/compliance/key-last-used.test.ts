import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let server: FreshServer;
let client: MarfaClient;
let management: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("key-last-used");
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  management = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
});

async function mint(source: string) {
  const response = await client.createKey({
    label: source,
    source,
    type_permissions: { "*": "read" },
  });
  expect(response.status).toBe(201);
  expect(response.data.last_used_at).toBeNull();
  return response.data;
}

async function use(key: string) {
  const scoped = new MarfaClient({ baseUrl: server.apiUrl, apiKey: key });
  const response = await scoped.listItems({ limit: 1 });
  expect(response.status).toBe(200);
}

async function recorded(id: string) {
  const list = await management.listKeys();
  expect(list.status).toBe(200);
  const found = list.data.data.find((key) => key.id === id);
  expect(found).toBeDefined();
  return found!.last_used_at;
}

describe("API key last_used_at compliance", () => {
  it("new key has null or absent last_used_at", async () => {
    const key = await mint("klu-new");
    expect(await recorded(key.id)).toBeNull();
  });

  it("last_used_at is set after first use", async () => {
    const key = await mint("klu-used");
    const before = Date.now();
    await use(key.key);
    const after = Date.now();
    await expect
      .poll(() => recorded(key.id), { timeout: 5000 })
      .toEqual(expect.any(String));
    const stamp = Date.parse((await recorded(key.id))!);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });

  it("last_used_at is a valid ISO 8601 timestamp", async () => {
    const key = await mint("klu-valid");
    await use(key.key);
    await expect
      .poll(() => recorded(key.id), { timeout: 5000 })
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Number.isNaN(Date.parse((await recorded(key.id))!))).toBe(false);
  });

  it("last_used_at appears in list response", async () => {
    const key = await mint("klu-list");
    await use(key.key);
    await expect
      .poll(() => recorded(key.id), { timeout: 5000 })
      .toEqual(expect.any(String));
  });
});
