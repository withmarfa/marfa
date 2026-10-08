/**
 * An item that stops the server is not offered to the sweep for ever.
 *
 * A document can end the process that reads it, or the server's own, partway
 * through extraction. If the sweep recorded an attempt only when extraction
 * finished, nothing would remember the attempt, and the item would be offered
 * again at every start and stop the server each time. So the attempt is
 * recorded before extraction begins, and an item that has used the attempts
 * allowed is left.
 *
 * The server here is stopped with `SIGKILL` while it reads a document that
 * takes it well over a second, with a single attempt allowed. A second item
 * with the same bytes, added after the restart, is the witness: it is read
 * on the same server, so the first item's absence of text is the sweep
 * leaving it and not a document or a server that cannot be read.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DOCX_MIME,
  docx,
  longParagraph,
} from "../../utils/office-documents.js";

const MIB = 1024 * 1024;

let server: FreshServer;
let client: MarfaClient;
let operator: MarfaClient;

function clients(): void {
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}

beforeAll(async () => {
  server = await bootFreshServer("interrupted-extraction", {
    MARFA_ENRICHMENT_ENABLED: "true",
    MARFA_ENRICHMENT_OCR_ENABLED: "false",
    MARFA_ENRICHMENT_MAX_ATTEMPTS: "1",
    MARFA_ENRICHMENT_MAX_INFLATED_BYTES: String(512 * MIB),
    MARFA_ENRICHMENT_MAX_MEMORY_BYTES: String(1024 * MIB),
    // Driven through the housekeeping door rather than the scheduler.
    MARFA_ENRICHMENT_INTERVAL_MS: "3600000",
  });
  clients();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function documentItem(hash: string, title: string): Promise<string> {
  const created = await client.createItem({
    type: "core.file",
    properties: { blob_ref: hash, mime_type: DOCX_MIME, title },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

async function text(id: string): Promise<unknown> {
  const read = await client.getItem(id);
  expect(read.status).toBe(200);
  return read.data.item.properties.extracted_text;
}

describe("an item the server was stopped while reading", () => {
  it("is not offered to the next sweep once its attempts are used, beside an item that reads", async () => {
    // 100 MiB of text takes the better part of a second to read.
    const upload = await client.uploadBlob(
      docx(longParagraph(100 * MIB)),
      DOCX_MIME,
    );
    expect(upload.status).toBe(201);
    const interrupted = await documentItem(upload.data.hash, "interrupted");

    const sweeping = operator
      .runHousekeeping("enrichment-sweep")
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await server.restart({ signal: "SIGKILL" });
    await sweeping;
    clients();

    const witness = await documentItem(upload.data.hash, "not interrupted");
    const run = await operator.runHousekeeping("enrichment-sweep");
    expect(run.status).toBe(200);
    expect(run.data.result).toEqual({ extracted: 1, skipped: 0, failed: 0 });

    expect(String(await text(witness))).toMatch(/^aaaa/);
    expect(await text(interrupted)).toBeUndefined();
  }, 240_000);
});
