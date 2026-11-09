import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { localFetch } from "../../utils/control-request.js";

let server: FreshServer;
beforeAll(async () => {
  server = await bootFreshServer("item-summaries-display");
  vi.stubEnv("MARFA_API_URL", server.apiUrl);
}, 2 * FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
  vi.unstubAllEnvs();
}, 2 * FRESH_SERVER_TIMEOUT_MS);
function owner(path: string, init: RequestInit = {}) {
  return localFetch(server.controlSocket, `${server.apiUrl}${path}`, init);
}
function key(path: string, body?: unknown) {
  return fetch(`${server.apiUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${server.workingKey}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
interface Page {
  data: { id: string; name: string }[];
}

/** The names and previews a device is held to, beside the server's names. */
const SHARED = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/item-display.json", import.meta.url),
    "utf8",
  ),
) as {
  types: Record<string, unknown>[];
  cases: {
    description: string;
    type: string;
    properties: Record<string, unknown>;
    name: string | null;
  }[];
};

it("names every shared display case as a device does, and Untitled where a device answers no name", async () => {
  // In order: a parent before the types that inherit from it.
  for (const type of SHARED.types) {
    const registered = await key("/types", type);
    expect(registered.status, await registered.text()).toBe(201);
  }
  expect(SHARED.cases.length).toBeGreaterThan(0);
  for (const { description, type, properties, name } of SHARED.cases) {
    const made = await key("/items", { type, properties });
    expect(made.status, `${description}: ${await made.clone().text()}`).toBe(
      201,
    );
    const { item } = (await made.json()) as { item: { id: string } };
    const result = await owner(`/items/summaries?type=${type}&limit=100`);
    expect(result.status).toBe(200);
    expect(
      ((await result.json()) as Page).data.find((row) => row.id === item.id)
        ?.name,
      description,
    ).toBe(name ?? "Untitled");
  }
});
