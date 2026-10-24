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
 * with enrichment and OCR on and a local language model, so recognition
 * does not depend on a download during a sweep.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

let server: FreshServer;
let client: MarfaClient;
let operator: MarfaClient;
let tessdata: string;

beforeAll(async () => {
  tessdata = mkdtempSync(join(tmpdir(), "malformed-image-tessdata-"));
  const model = createRequire(import.meta.url).resolve(
    "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
  );
  writeFileSync(
    join(tessdata, "eng.traineddata"),
    gunzipSync(readFileSync(model)),
  );
  server = await bootFreshServer("malformed-image", {
    MARFA_ENRICHMENT_ENABLED: "true",
    MARFA_ENRICHMENT_OCR_ENABLED: "true",
    MARFA_ENRICHMENT_TESSDATA_DIR: tessdata,
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
  if (tessdata) rmSync(tessdata, { recursive: true, force: true });
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
  it("lists the enrichment sweep on a server with enrichment on", async () => {
    const listed = await operator.listHousekeeping();
    expect(listed.status).toBe(200);
    expect(listed.data.data.map((row) => row.name)).toContain(
      "enrichment-sweep",
    );
  });

  it("is recorded as a failed enrichment, and the server goes on answering", async () => {
    // The control: a real image on the same server, which the first sweep
    // reads with OCR and whose size it writes, so the failure and the
    // absent size below are this image's and not a broken engine's.
    const realBytes = readFileSync(
      fileURLToPath(new URL("./fixtures/ocr-sample.png", import.meta.url)),
    );
    const real = await imageItem(realBytes, "a real image");
    const broken = await imageItem(malformedPng(), "not an image");

    // The fourth sweep must leave this item's exhausted attempts alone,
    // regardless of what other items the sweep processes.
    let exhausted: unknown;
    for (const [i, attempts] of [1, 2, 3, 3].entries()) {
      // A fresh control makes the final sweep observable even though the
      // malformed item's attempts have run out.
      const controlId =
        i === 3 ? await imageItem(realBytes, "a later real image") : real;
      const run = await operator.runHousekeeping("enrichment-sweep");
      const label = `sweep ${String(i + 1)}`;
      expect(run.status, label).toBe(200);
      expect(run.data.outcome, label).toBe("ok");
      const state = withInstanceDatabase(server.sqlitePath, (db) =>
        db
          .prepare("SELECT * FROM enrichment_state WHERE item_id = ?")
          .get(broken),
      );
      expect(state, label).toMatchObject({ status: "failed", attempts });
      expect(state?.error, label).toContain("Error attempting to read image");
      if (i === 2) exhausted = state;
      if (i === 3) expect(state, label).toEqual(exhausted);
      const control = await client.getItem(controlId);
      expect(control.status, label).toBe(200);
      expect(control.data.item.properties.width, label).toBe(1700);
      expect(control.data.item.properties.height, label).toBe(2200);
      expect(
        String(control.data.item.properties.extracted_text),
        label,
      ).toContain("quokkapng");
    }

    const health = await fetch(`${server.apiUrl}/health`);
    expect(health.status).toBe(200);

    const read = await client.getItem(broken);
    expect(read.status).toBe(200);
    expect(read.data.item.properties.title).toBe("not an image");
    expect(read.data.item.properties.width).toBeUndefined();
    expect(read.data.item.properties.height).toBeUndefined();
    expect(read.data.item.properties.extracted_text).toBeUndefined();
  }, 240_000);
});
