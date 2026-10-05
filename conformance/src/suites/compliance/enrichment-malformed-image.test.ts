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
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

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
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** A PNG's signature, then bytes that are no image and no PNG header. */
function malformedPng(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4096, 0x5a),
  ]);
}

/** An image file item for `bytes`, answering its id. */
async function imageItem(bytes: Buffer, title: string): Promise<string> {
  const upload = await client.uploadBlob(bytes, "image/png");
  expect(upload.status).toBe(201);
  const created = await client.createItem({
    type: "core.file.image",
    properties: { blob_ref: upload.data.hash, mime_type: "image/png", title },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

describe("a malformed image", () => {
  it("is recorded as a failed enrichment, and the server goes on answering", async () => {
    // The control: a real image on the same server, which the first sweep
    // reads with OCR and whose size it writes, so the failure and the
    // absent size below are this image's and not a broken engine's.
    const real = await imageItem(
      readFileSync(
        fileURLToPath(new URL("./fixtures/ocr-sample.png", import.meta.url)),
      ),
      "a real image",
    );
    const broken = await imageItem(malformedPng(), "not an image");

    // Offered until its attempts, three, run out, then left: the fourth
    // sweep finds nothing to do. The later meetings with the same bytes are
    // where a process that survived the first by luck would end.
    const expected = [
      { extracted: 1, skipped: 0, failed: 1 },
      { extracted: 0, skipped: 0, failed: 1 },
      { extracted: 0, skipped: 0, failed: 1 },
      { extracted: 0, skipped: 0, failed: 0 },
    ];
    for (const [i, result] of expected.entries()) {
      const run = await operator.runHousekeeping("enrichment-sweep");
      const label = `sweep ${String(i + 1)}`;
      expect(run.status, label).toBe(200);
      expect(run.data.outcome, label).toBe("ok");
      expect(run.data.result, label).toEqual(result);
    }

    const health = await fetch(`${server.apiUrl}/health`);
    expect(health.status).toBe(200);

    const control = await client.getItem(real);
    expect(control.status).toBe(200);
    expect(control.data.item.properties.width).toBe(1700);
    expect(control.data.item.properties.height).toBe(2200);
    expect(String(control.data.item.properties.extracted_text)).toContain(
      "quokkapng",
    );

    const read = await client.getItem(broken);
    expect(read.status).toBe(200);
    expect(read.data.item.properties.title).toBe("not an image");
    expect(read.data.item.properties.width).toBeUndefined();
    expect(read.data.item.properties.height).toBeUndefined();
    expect(read.data.item.properties.extracted_text).toBeUndefined();
  }, 240_000);
});
