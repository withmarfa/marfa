import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { MarfaClient } from "../../client/api.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { requireBinary } from "./harness.js";

/**
 * A device finds a file by the text the server's enrichment sweep extracted
 * from it, as the server does (`device/index-file-text`). The shared server
 * runs with enrichment off, so this boots its own.
 */

let server: FreshServer;
let client: MarfaClient;
let operator: MarfaClient;
let device: CliDevice;
let store: ReturnType<typeof newStore>;

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

beforeAll(async () => {
  server = await bootFreshServer("search-file-text-live", {
    MARFA_ENRICHMENT_ENABLED: "true",
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
  store = newStore("search-file-text-live");
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: server.apiUrl,
    key: server.workingKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  if (store) rmSync(dirname(store), { recursive: true, force: true });
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function textFile(text: string): Promise<string> {
  const uploaded = await client.uploadBlob(Buffer.from(text), "text/plain");
  expect(uploaded.status).toBe(201);
  const created = await client.createItem({
    type: "core.file",
    tier: "library",
    properties: {
      blob_ref: uploaded.data.hash,
      mime_type: "text/plain",
      title: "scan",
    },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

async function served(query: string, state?: string): Promise<string[]> {
  const result = await client.search(query, {
    limit: 50,
    ...(state !== undefined && { state }),
  });
  expect(result.status, JSON.stringify(result.error)).toBe(200);
  return result.data.data.map((hit) => hit.item.id);
}

async function local(query: string): Promise<string[]> {
  return value(await device.search(query, { type: "core.file" })).map(
    (hit) => hit.item.id,
  );
}

describe("a device finds a file by its extracted text", () => {
  it("answers the server's hits, in the server's order, once its copy holds the extracted text", async () => {
    // Three files hold the word in decreasing number, so the order is the
    // ranking's and not a tie's.
    const most = await textFile("zorblaxian zorblaxian zorblaxian");
    const some = await textFile("zorblaxian zorblaxian pear");
    const least = await textFile("zorblaxian pear pear");
    const none = await textFile("pear pear pear");
    value(await device.hydrate(["core.file"], "library"));

    // Enrichment has not run: neither side finds a file by its bytes, and
    // both find it by the fields it has.
    expect(await served("zorblaxian")).toEqual([]);
    expect(await local("zorblaxian")).toEqual([]);
    expect(await local("scan")).toHaveLength(4);

    const run = await operator.runHousekeeping("enrichment-sweep");
    expect(run.status).toBe(200);
    expect(run.data.outcome).toBe("ok");
    // The witness: the server has the text and finds the files by it.
    expect(await served("zorblaxian")).toEqual([most, some, least]);

    // The copy has not fetched the text yet, so it still finds nothing.
    expect(await local("zorblaxian")).toEqual([]);
    value(await device.catchUp());

    expect(await local("zorblaxian")).toEqual([most, some, least]);
    expect(await local("zorblaxian")).toEqual(await served("zorblaxian"));
    expect(await local("pear")).toEqual(await served("pear"));
    expect(await local("pear")).toContain(none);
  }, 120_000);

  it("leaves a file in the bin unmatched, as the server does", async () => {
    const id = await textFile("the glimmerwick manifest");
    value(await device.catchUp());
    const run = await operator.runHousekeeping("enrichment-sweep");
    expect(run.status).toBe(200);
    value(await device.catchUp());
    // The witness: both find the file before it is binned.
    expect(await served("glimmerwick")).toEqual([id]);
    expect(await local("glimmerwick")).toEqual([id]);

    const deleted = await client.deleteItem(id);
    expect(deleted.status).toBe(200);
    value(await device.catchUp());
    expect(await served("glimmerwick")).toEqual([]);
    expect(await local("glimmerwick")).toEqual([]);
  }, 120_000);
});
