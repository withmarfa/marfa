/**
 * A connector's file type inherits a shipped one's ancestry under its own
 * name, so this boots its own server: enrichment is off on the shared one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MarfaClient } from "../../client/api.js";
import type { TypeSchema } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let server: FreshServer;
let client: MarfaClient;
let operator: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("enrichment-inheritance", {
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
    apiKey: server.operatorKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function upload(bytes: Buffer, mimeType: string): Promise<string> {
  const uploaded = await client.uploadBlob(bytes, mimeType);
  expect(uploaded.status).toBe(201);
  return uploaded.data.hash;
}

async function fileItem(
  type: string,
  blobRef: string,
  mimeType: string,
): Promise<string> {
  const created = await client.createItem({
    type,
    properties: { blob_ref: blobRef, mime_type: mimeType, title: type },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

async function propertiesOf(id: string): Promise<Record<string, unknown>> {
  const read = await client.getItem(id);
  expect(read.status).toBe(200);
  return read.data.item.properties;
}

describe("the enrichment sweep", () => {
  it("takes a type inheriting from a file type as that file, whatever its name", async () => {
    const schemas: TypeSchema[] = [
      { id: "acme.photo", parent: "core.file.image", fields: {} },
      { id: "acme.document", parent: "core.file", fields: {} },
      {
        id: "acme.attachment",
        fields: {
          blob_ref: { type: "string" },
          mime_type: { type: "string" },
          title: { type: "string" },
        },
      },
    ];
    for (const schema of schemas) {
      const registered = await client.registerType(schema);
      expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    }

    const png = await upload(
      readFileSync(
        fileURLToPath(new URL("./fixtures/ocr-sample.png", import.meta.url)),
      ),
      "image/png",
    );
    const text = await upload(
      Buffer.from("the quokka ledger, page one"),
      "text/plain",
    );

    // The shipped types, on the same bytes, are the witnesses: what the
    // inheriting types gain below is what these bytes give a file at all.
    const shippedImage = await fileItem("core.file.image", png, "image/png");
    const shippedFile = await fileItem("core.file", text, "text/plain");
    const photo = await fileItem("acme.photo", png, "image/png");
    const document = await fileItem("acme.document", text, "text/plain");
    const attachment = await fileItem("acme.attachment", text, "text/plain");

    const run = await operator.runHousekeeping("enrichment-sweep");
    expect(run.status).toBe(200);
    expect(run.data.outcome).toBe("ok");

    const image = await propertiesOf(shippedImage);
    expect(image.width, "core.file.image").toBe(1700);
    expect(image.height, "core.file.image").toBe(2200);
    const file = await propertiesOf(shippedFile);
    expect(file.extracted_text, "core.file").toBe(
      "the quokka ledger, page one",
    );

    const inheritsImage = await propertiesOf(photo);
    expect(inheritsImage.width, "a child of core.file.image").toBe(1700);
    expect(inheritsImage.height, "a child of core.file.image").toBe(2200);
    const inheritsFile = await propertiesOf(document);
    expect(inheritsFile.extracted_text, "a child of core.file").toBe(
      "the quokka ledger, page one",
    );

    const notAFile = await propertiesOf(attachment);
    expect(
      notAFile.extracted_text,
      "a type inheriting no file",
    ).toBeUndefined();

    // Four taken, and the fifth never offered rather than offered and skipped.
    expect(run.data.result).toEqual({ extracted: 4, skipped: 0, failed: 0 });
  }, 120_000);
});
