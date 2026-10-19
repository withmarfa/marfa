import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * An archive export of a row that a restore would refuse. A replacement of a
 * type is allowed to leave the rows already stored under it as they were, so
 * a row the new schema no longer accepts is the instance's own, and the way
 * to make one through the HTTP API alone.
 */
let server: FreshServer | undefined;
let working: MarfaClient;
let owner: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("export-rows-refused");
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  owner = new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

const TYPE = "conformance.refused-row";

async function archive(): Promise<Response> {
  return fetch(
    `${server!.apiUrl}/export?format=archive&type=${encodeURIComponent(TYPE)}`,
    { headers: { Authorization: `Bearer ${server!.workingKey}` } },
  );
}

describe("an archive export of a row a restore would refuse", () => {
  it("answers 409 naming the row, and exports once the row is corrected", async () => {
    const registered = await working.registerType({
      id: TYPE,
      version: 1,
      fields: { value: { type: "string", required: true } },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const created = await working.createItem({
      type: TYPE,
      properties: { value: "original" },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const id = created.data.item.id;

    const replaced = await working.replaceType(TYPE, {
      version: 2,
      fields: { value: { type: "number", required: true } },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);

    const refused = await archive();
    expect(refused.status).toBe(409);
    expect(refused.headers.get("content-type")).toContain("application/json");
    expect(await refused.json()).toMatchObject({
      error: {
        code: "export_rows_unrestorable",
        details: {
          row: {
            kind: "item",
            id,
            type: TYPE,
            field: "properties.value",
            code: "invalid_properties",
          },
        },
      },
    });

    const corrected = await working.updateItem(id, {
      version: created.data.item.version,
      properties: { value: 42 },
    });
    expect(corrected.ok, JSON.stringify(corrected.error)).toBe(true);

    const accepted = await archive();
    expect(accepted.status).toBe(200);
    const bytes = new Uint8Array(await accepted.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    const restored = await owner.restoreArchive(bytes);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
  });
});
