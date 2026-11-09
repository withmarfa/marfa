/**
 * The enrichment sweep's write is announced, so this boots its own server:
 * enrichment is off on the shared one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { QUIET_SCHEDULE } from "../../utils/moved-clock.js";
import { createNote } from "../../generators/items.js";
import { collectUntil, withStream } from "../../utils/stream.js";

let server: FreshServer;
let client: MarfaClient;
let operator: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("enrichment-announced", {
    ...QUIET_SCHEDULE,
    MARFA_ENRICHMENT_ENABLED: "true",
  });
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("the enrichment sweep", () => {
  it("announces item.updated for the file item whose text it writes", async ({
    signal,
  }) => {
    const uploaded = await client.uploadBlob(
      Buffer.from("text the sweep reads"),
      "text/plain",
    );
    expect(uploaded.status).toBe(201);
    const created = await client.createItem({
      type: "core.file",
      properties: {
        blob_ref: uploaded.data.hash,
        mime_type: "text/plain",
        title: "announced",
      },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = created.data.item.id;
    const before = created.data.item.version;

    const frames = await withStream(
      server.apiUrl,
      server.workingKey,
      {},
      async (stream) => {
        await new Promise((r) => setTimeout(r, 250));
        const run = await operator.runHousekeeping("enrichment-sweep");
        expect(run.status).toBe(200);
        expect(run.data.outcome).toBe("ok");
        // The witness: a write after the sweep, so a frame the sweep did not
        // send is absent and not late.
        const witness = await client.createItem(createNote());
        expect(witness.status).toBe(201);
        const { events } = await collectUntil(
          stream,
          (evts) =>
            evts.some(
              (e) =>
                (e.data as { item?: { id?: string } }).item?.id ===
                witness.data.item.id,
            ),
          `the witness ${witness.data.item.id}`,
          signal,
        );
        return events;
      },
    );

    const mine = frames.filter(
      (e) => (e.data as { item?: { id?: string } }).item?.id === id,
    );
    expect(mine.map((e) => e.event)).toEqual(["item.updated"]);
    const item = (
      mine[0]?.data as {
        item: { version: number; properties: { extracted_text?: string } };
      }
    ).item;
    expect(item.properties.extracted_text).toBe("text the sweep reads");
    expect(item.version).toBeGreaterThan(before);
  });
});
