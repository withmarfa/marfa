/**
 * A document that asks for more than text extraction may use never ends the
 * process or holds the server.
 *
 * Office documents are zip files, and a small one can inflate to far more
 * than it weighs, or hold so many small parts that reading it fills a heap.
 * The enrichment sweep's answer is a skip recorded for that item, with the
 * limit it met as the reason: the server goes on answering, the item goes on
 * reading with no text made up, and the sweep leaves it until a limit is
 * raised.
 *
 * Enrichment is off on the run's own server, so this boots one of its own
 * with the limits set low, and boots it again with the defaults to show the
 * same documents read. A document that is refused only because extraction is
 * broken on this server would show the same absence, so the second boot is
 * the witness.
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
  manyParagraphs,
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
  server = await bootFreshServer("document-bounds", {
    MARFA_ENRICHMENT_ENABLED: "true",
    MARFA_ENRICHMENT_OCR_ENABLED: "false",
    MARFA_ENRICHMENT_MAX_INFLATED_BYTES: String(MIB),
    MARFA_ENRICHMENT_MAX_MEMORY_BYTES: String(64 * MIB),
    // Driven through the housekeeping door rather than the scheduler.
    MARFA_ENRICHMENT_INTERVAL_MS: "3600000",
  });
  clients();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function documentItem(bytes: Buffer, title: string): Promise<string> {
  const upload = await client.uploadBlob(bytes, DOCX_MIME);
  expect(upload.status).toBe(201);
  const created = await client.createItem({
    type: "core.file",
    properties: { blob_ref: upload.data.hash, mime_type: DOCX_MIME, title },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

async function sweep() {
  const run = await operator.runHousekeeping("enrichment-sweep");
  expect(run.status).toBe(200);
  expect(run.data.outcome).toBe("ok");
  return run.data.result;
}

async function text(id: string): Promise<unknown> {
  const read = await client.getItem(id);
  expect(read.status).toBe(200);
  return read.data.item.properties.extracted_text;
}

describe("a document that asks for more than extraction may use", () => {
  let plain: string;
  let inflating: string;
  let heavy: string;

  it("is skipped, writes no text, and leaves the server answering, beside a document that reads", async () => {
    plain = await documentItem(docx(longParagraph(10)), "an ordinary document");
    // Small on the wire and 62 MiB once inflated.
    const bomb = docx(longParagraph(62 * MIB));
    expect(bomb.length).toBeLessThan(200 * 1024);
    inflating = await documentItem(bomb, "inflates");
    // Far inside any inflated limit, and more than the memory limit above
    // can hold once the parser has built it.
    heavy = await documentItem(docx(manyParagraphs(50_000)), "needs memory");

    expect(await sweep()).toEqual({ extracted: 1, skipped: 2, failed: 0 });

    expect(await text(plain)).toBe("aaaaaaaaaa");
    expect(await text(inflating)).toBeUndefined();
    expect(await text(heavy)).toBeUndefined();
    expect((await fetch(`${server.apiUrl}/health`)).status).toBe(200);
    expect((await client.getItem(inflating)).status).toBe(200);

    // Skipped is left: the next sweep finds nothing to do.
    expect(await sweep()).toEqual({ extracted: 0, skipped: 0, failed: 0 });
  }, 240_000);

  it("is read once the limits are raised", async () => {
    await server.restart({
      env: {
        MARFA_ENRICHMENT_MAX_INFLATED_BYTES: String(64 * MIB),
        MARFA_ENRICHMENT_MAX_MEMORY_BYTES: String(256 * MIB),
      },
    });
    clients();

    const result = await sweep();

    expect(result).toEqual({ extracted: 2, skipped: 0, failed: 0 });
    expect(String(await text(inflating))).toMatch(/^aaaa/);
    expect(String(await text(heavy))).toMatch(/^word/);
  }, 240_000);
});
