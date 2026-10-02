/**
 * The enrichment sweep reads bytes only for a file whose own reference
 * lends them, so this boots its own server: enrichment is off on the shared
 * one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let server: FreshServer;
let owner: MarfaClient;
let operator: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("enrichment-reach", {
    MARFA_ENRICHMENT_ENABLED: "true",
    // Driven through the housekeeping door rather than the scheduler.
    MARFA_ENRICHMENT_INTERVAL_MS: "3600000",
  });
  owner = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.operatorKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function sweep(): Promise<void> {
  const run = await operator.runHousekeeping("enrichment-sweep");
  expect(run.status).toBe(200);
  expect(run.data.outcome, run.data.error ?? "").toBe("ok");
}

async function extracted(client: MarfaClient, id: string): Promise<unknown> {
  const read = await client.getItem(id);
  expect(read.status).toBe(200);
  return read.data.item.properties.extracted_text;
}

describe("the enrichment sweep and a blob's reach", () => {
  it("extracts only from bytes the file's own reference lends", async () => {
    const hidden = new TextEncoder().encode("the quokka ledger, page one");
    const shown = new TextEncoder().encode("the wombat ledger, page one");
    const hiddenUpload = await owner.uploadBlob(hidden, "text/plain");
    const shownUpload = await owner.uploadBlob(shown, "text/plain");
    expect(hiddenUpload.status).toBe(201);
    expect(shownUpload.status).toBe(201);
    // The owner's note lends the hidden bytes to note readers only.
    const linked = await owner.createItem({
      type: "core.note",
      properties: { body: `![it](${hiddenUpload.data.hash})` },
    });
    expect(linked.status).toBe(201);

    const minted = await owner.createKey({
      label: "files only",
      source: "enrichment-reach-files",
      type_permissions: { "core.file": "write" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    const fileWriter = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.data.key,
    });
    expect((await fileWriter.downloadBlob(hiddenUpload.data.hash)).status).toBe(
      404,
    );

    const named = await fileWriter.createItem({
      type: "core.file",
      properties: {
        blob_ref: hiddenUpload.data.hash,
        mime_type: "text/plain",
        title: "named, never sent",
      },
    });
    expect(named.status, JSON.stringify(named.error)).toBe(201);
    // The witness: the same sweep extracts from a file whose writer sent
    // its bytes.
    const own = await owner.createItem({
      type: "core.file",
      properties: {
        blob_ref: shownUpload.data.hash,
        mime_type: "text/plain",
        title: "sent by its writer",
      },
    });
    expect(own.status, JSON.stringify(own.error)).toBe(201);

    await sweep();
    expect(await extracted(owner, own.data.item.id)).toBe(
      "the wombat ledger, page one",
    );
    expect(await extracted(fileWriter, named.data.item.id)).toBeUndefined();

    // Once the file's writer has sent the bytes, a file it writes naming
    // them lends them, and the next sweep reads them; the first file's
    // reference stays unproven while it names the digest.
    expect((await fileWriter.uploadBlob(hidden, "text/plain")).status).toBe(
      201,
    );
    const proven = await fileWriter.createItem({
      type: "core.file",
      properties: {
        blob_ref: hiddenUpload.data.hash,
        mime_type: "text/plain",
        title: "named after sending",
      },
    });
    expect(proven.status, JSON.stringify(proven.error)).toBe(201);
    await sweep();
    expect(await extracted(fileWriter, proven.data.item.id)).toBe(
      "the quokka ledger, page one",
    );
    expect(await extracted(fileWriter, named.data.item.id)).toBeUndefined();
  });
});
