/**
 * Extracted text is cut to a character limit, so this boots its own server:
 * enrichment is off on the shared one, and the limit is a setting.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

const LIMIT = 100;

let server: FreshServer;
let client: MarfaClient;
let operator: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("enrichment-text-cut", {
    MARFA_ENRICHMENT_ENABLED: "true",
    MARFA_ENRICHMENT_INTERVAL_MS: "3600000",
    MARFA_ENRICHMENT_MAX_TEXT_CHARS: String(LIMIT),
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

async function textFile(text: string): Promise<string> {
  const uploaded = await client.uploadBlob(Buffer.from(text), "text/plain");
  expect(uploaded.status).toBe(201);
  const created = await client.createItem({
    type: "core.file",
    properties: {
      blob_ref: uploaded.data.hash,
      mime_type: "text/plain",
      title: "cut",
    },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

describe("the enrichment sweep", () => {
  it("cuts extracted text at a number of characters, counting an emoji once", async () => {
    // The emoji is the last character the limit allows for the first file and
    // the first it cuts for the second; counted in UTF-16 units, it would be
    // cut from both.
    const kept = await textFile(`${"x".repeat(LIMIT - 1)}😀 and the rest`);
    const cut = await textFile(`${"x".repeat(LIMIT)}😀 and the rest`);

    const run = await operator.runHousekeeping("enrichment-sweep");
    expect(run.status).toBe(200);
    expect(run.data.outcome).toBe("ok");

    const first = await client.getItem(kept);
    expect(first.data.item.properties.extracted_text).toBe(
      `${"x".repeat(LIMIT - 1)}😀`,
    );
    const second = await client.getItem(cut);
    expect(second.data.item.properties.extracted_text).toBe("x".repeat(LIMIT));
  });
});
