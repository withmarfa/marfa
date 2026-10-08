/**
 * Enrichment is off on the run's own server, so this boots one of its own
 * with enrichment on and OCR off, which leaves the size as the only thing
 * the sweep reads from an image.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
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
  server = await bootFreshServer("enrichment-image-headers", {
    MARFA_ENRICHMENT_ENABLED: "true",
    // Driven through the housekeeping door rather than the scheduler.
    MARFA_ENRICHMENT_INTERVAL_MS: "3600000",
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

const sample = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

/** An image file item for `bytes`, answering its id. */
async function imageItem(bytes: Buffer, mimeType: string): Promise<string> {
  const upload = await client.uploadBlob(bytes, mimeType);
  expect(upload.status).toBe(201);
  const created = await client.createItem({
    type: "core.file.image",
    properties: { blob_ref: upload.data.hash, mime_type: mimeType },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

describe("an image whose header is malformed", () => {
  it("gets no size from a GIF, JPEG or WebP signature over garbage", async () => {
    const garbage = Buffer.alloc(64, 0x5a);
    const formats: { mime: string; real: Buffer; malformed: Buffer }[] = [
      {
        mime: "image/gif",
        real: sample("image-sample.gif"),
        malformed: Buffer.concat([Buffer.from("GIF89a"), garbage]),
      },
      {
        mime: "image/jpeg",
        real: sample("image-sample.jpg"),
        malformed: Buffer.concat([
          Buffer.from([0xff, 0xd8, 0xff, 0xc0]),
          garbage,
        ]),
      },
      {
        mime: "image/webp",
        real: sample("image-sample.webp"),
        malformed: Buffer.concat([
          sample("image-sample.webp").subarray(0, 16),
          garbage,
        ]),
      },
    ];

    // Each real image is the witness that the sweep reads its format at all,
    // so the absent size beside it is the malformed header's.
    const items: { mime: string; real: string; malformed: string }[] = [];
    for (const format of formats) {
      items.push({
        mime: format.mime,
        real: await imageItem(format.real, format.mime),
        malformed: await imageItem(format.malformed, format.mime),
      });
    }

    const run = await operator.runHousekeeping("enrichment-sweep");
    expect(run.status).toBe(200);
    expect(run.data.outcome).toBe("ok");
    expect(run.data.result).toEqual({ extracted: 3, skipped: 3, failed: 0 });

    for (const item of items) {
      const real = await client.getItem(item.real);
      expect(real.status).toBe(200);
      expect(real.data.item.properties.width, item.mime).toBe(30);
      expect(real.data.item.properties.height, item.mime).toBe(20);

      const malformed = await client.getItem(item.malformed);
      expect(malformed.status).toBe(200);
      expect(malformed.data.item.properties.width, item.mime).toBeUndefined();
      expect(malformed.data.item.properties.height, item.mime).toBeUndefined();
    }
  }, 120_000);
});
