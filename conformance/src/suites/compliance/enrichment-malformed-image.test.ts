/**
 * A malformed image never ends the process.
 *
 * The enrichment sweep reads an image file item's bytes with OCR. An image
 * whose bytes are not an image is the ordinary case of a broken upload, and
 * the sweep's answer to it is a failure recorded for that item: the server
 * goes on answering, the item goes on reading with no size made up from
 * its bytes, and the next sweep meets the same bytes the same way.
 *
 * Enrichment is off on the run's own server, so this boots one of its own
 * with enrichment and OCR on. The language model OCR loads is cached where
 * the run says, or under the home directory, so a second run fetches
 * nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { MarfaClient } from "../../client/api.js";
import { bootFreshServer, type FreshServer } from "../../utils/fresh-server.js";

let server: FreshServer;
let client: MarfaClient;
let operator: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("malformed-image", {
    MARFA_ENRICHMENT_ENABLED: "true",
    MARFA_ENRICHMENT_OCR_ENABLED: "true",
    MARFA_ENRICHMENT_TESSDATA_DIR:
      process.env.MARFA_ENRICHMENT_TESSDATA_DIR ??
      join(homedir(), ".cache", "marfa-tessdata"),
    // Driven through the housekeeping door rather than the scheduler.
    MARFA_ENRICHMENT_INTERVAL_MS: "3600000",
  });
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.operatorKey,
  });
}, 120_000);

afterAll(() => {
  server?.stop();
});

/** A PNG's signature, then bytes that are no image. */
function malformedPng(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(4096),
  ]);
}

describe("a malformed image", () => {
  it("is recorded as a failed enrichment, and the server goes on answering", async () => {
    const upload = await client.uploadBlob(malformedPng(), "image/png");
    expect(upload.status).toBe(201);
    const created = await client.createItem({
      type: "core.file.image",
      properties: {
        blob_ref: upload.data.hash,
        mime_type: "image/png",
        title: "not an image",
      },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = created.data.item.id;

    // Twice: a failure is re-offered until its attempts run out, and a
    // second meeting with the same bytes is where a process that survived
    // the first by luck would end.
    for (const attempt of [1, 2]) {
      const run = await operator.runHousekeeping("enrichment-sweep");
      expect(run.status, `sweep ${String(attempt)}`).toBe(200);
      expect(run.data.outcome, `sweep ${String(attempt)}`).toBe("ok");
      // Failed, and the only way to failure this item has is the OCR
      // refusing the bytes: the blob is there, the sweep's time budget is a
      // minute, and a size read from them would have counted as extracted.
      expect(run.data.result, `sweep ${String(attempt)}`).toEqual({
        extracted: 0,
        skipped: 0,
        failed: 1,
      });
    }

    const health = await fetch(`${server.apiUrl}/health`);
    expect(health.status).toBe(200);
    const read = await client.getItem(id);
    expect(read.status).toBe(200);
    // Witness that the read is the item: its own blob is there.
    expect(read.data.item.properties.blob_ref).toBe(upload.data.hash);
    expect(read.data.item.properties.width).toBeUndefined();
    expect(read.data.item.properties.height).toBeUndefined();
  }, 180_000);
});
