import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * An archive export of a row a restore would refuse. A replacement of a type
 * is allowed to leave the rows already stored under it as they were, and one
 * that makes a type an event leaves a row whose rule no calendar read can
 * unfold: the way to make such a row through the HTTP API alone. The shape of
 * a type is no such way, because a restore does not hold a row to it
 * (`search-and-filters/restore-rows-shape-free`).
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
    const fields = {
      title: { type: "string" as const, required: true },
      starts_at: { type: "string" as const, format: "datetime" as const },
      recurrence: { type: "array" as const, items_type: "string" as const },
    };
    const registered = await working.registerType({
      id: TYPE,
      version: 1,
      fields,
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const created = await working.createItem({
      type: TYPE,
      properties: {
        title: "the series",
        starts_at: "2041-01-15T09:00:00.000Z",
        recurrence: ["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"],
      },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const id = created.data.item.id;

    // The witness: while the type is no event nothing reads the rule, and
    // the instance exports.
    const witness = await archive();
    expect(witness.status).toBe(200);
    await witness.arrayBuffer();

    const replaced = await working.replaceType(TYPE, {
      version: 2,
      parent: "core.event",
      fields,
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
            field: "properties.recurrence",
            code: "invalid_properties",
          },
        },
      },
    });

    const corrected = await working.updateItem(id, {
      version: created.data.item.version,
      properties: { recurrence: ["RRULE:FREQ=YEARLY"] },
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
