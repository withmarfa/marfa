/**
 * The text the enrichment sweep extracts is found by search, so this boots its
 * own server: enrichment is off on the shared one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  server = await bootFreshServer("enrichment-search", {
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

async function textFile(title: string, text: string): Promise<string> {
  const uploaded = await client.uploadBlob(Buffer.from(text), "text/plain");
  expect(uploaded.status).toBe(201);
  const created = await client.createItem({
    type: "core.file",
    tier: "library",
    properties: {
      blob_ref: uploaded.data.hash,
      mime_type: "text/plain",
      title,
    },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

async function webPage(
  title: string,
  html: string,
  mimeType: string,
): Promise<string> {
  const uploaded = await client.uploadBlob(Buffer.from(html), mimeType);
  expect(uploaded.status).toBe(201);
  const created = await client.createItem({
    type: "core.file.webpage",
    tier: "library",
    properties: { blob_ref: uploaded.data.hash, mime_type: mimeType, title },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

async function found(query: string, state?: string): Promise<string[]> {
  const result = await client.search(query, {
    limit: 50,
    ...(state !== undefined && { state }),
  });
  expect(result.status, JSON.stringify(result.error)).toBe(200);
  return result.data.data.map((hit) => hit.item.id);
}

async function sweep(): Promise<void> {
  const run = await operator.runHousekeeping("enrichment-sweep");
  expect(run.status).toBe(200);
  expect(run.data.outcome).toBe("ok");
}

describe("search over extracted file text", () => {
  it("finds a file by a word only its extracted text holds, once the sweep has written it", async () => {
    const hit = await textFile(
      "ledger scan",
      "the zorblaxian ledger, page one",
    );
    const other = await textFile(
      "other scan",
      "a quietude of note on this page",
    );

    // Enrichment has not run: the file answers by the fields it has and not
    // by words its bytes hold.
    expect(await found("ledger")).toEqual([hit]);
    expect(await found("zorblaxian")).toEqual([]);

    await sweep();

    // The witness: the sweep wrote the text onto the item, and the word is
    // in no other field of it.
    const read = await client.getItem(hit);
    expect(read.data.item.properties.extracted_text).toBe(
      "the zorblaxian ledger, page one",
    );
    expect(read.data.item.properties.title).toBe("ledger scan");
    expect(await found("zorblaxian")).toEqual([hit]);
    expect(await found("zorblax")).toEqual([hit]);
    expect(await found("ledger")).toEqual([hit]);
    expect(await found("quietude")).toEqual([other]);
  }, 120_000);

  it("finds a Web Page by the words on it and not by its markup, script or style", async () => {
    const page = await webPage(
      "weekly report",
      `<!doctype html><html><head><title>Fjordish summary</title>
       <style>.styleonlyword { color: red }</style>
       <script>const scriptonlyword = "<p>nope</p>";</script></head>
       <body><h1>Heading</h1><p>Sales rose by <b>brindlewick</b> &amp; more.</p>
       <p class="attributeonlyword" data-x="datavalueword">Second&nbsp;paragraph</p>
       <!-- commentonlyword --></body></html>`,
      "text/html; charset=utf-8",
    );
    // A page the tokenizer must recover from, typed as an old page.
    const broken = await webPage(
      "broken report",
      "<div><p>unclosed <b>marmalade <script>var s = 1;",
      "TEXT/HTML",
    );

    await sweep();

    const read = await client.getItem(page);
    expect(read.data.item.properties.extracted_text).toBe(
      "Fjordish summary\nHeading\nSales rose by brindlewick & more.\nSecond paragraph",
    );
    expect(await found("brindlewick")).toEqual([page]);
    expect(await found("fjordish")).toEqual([page]);
    expect(await found("marmalade")).toEqual([broken]);
    // The witness is the words above, found in the same pages: the tag, the
    // attribute, the style, the script and the comment hold words that are
    // not.
    for (const word of [
      "styleonlyword",
      "scriptonlyword",
      "attributeonlyword",
      "datavalueword",
      "commentonlyword",
    ]) {
      expect(await found(word), word).toEqual([]);
    }
  }, 120_000);

  it("keeps the text before a limit a page passes, and reads it within a bound of time", async () => {
    const ordinary = await webPage(
      "ordinary page",
      "<p>pelicanwick</p><p>pastthelimitword</p>",
      "text/html",
    );
    // The ordinary page is the witness: its last word is found when nothing
    // stops the read. This page nests without end and closes what was never
    // opened before the same word.
    const hostile = await webPage(
      "hostile page",
      `<p>fennelwick</p>${"<div>".repeat(200_000)}${"</x>".repeat(200_000)}<p>pastthelimitword</p>`,
      "text/html",
    );

    const started = performance.now();
    await sweep();
    expect(performance.now() - started).toBeLessThan(15_000);

    expect(await found("pelicanwick")).toEqual([ordinary]);
    expect(await found("fennelwick")).toEqual([hostile]);
    expect(await found("pastthelimitword")).toEqual([ordinary]);
  }, 120_000);

  it("leaves a file in the bin unmatched, and matches it again once restored", async () => {
    const id = await textFile("binned scan", "the glimmerwick manifest");
    await sweep();
    // The witness: the word is found before the file is binned.
    expect(await found("glimmerwick")).toEqual([id]);

    const deleted = await client.deleteItem(id);
    expect(deleted.status).toBe(200);
    for (const state of [undefined, "any", "trashed"]) {
      expect(await found("glimmerwick", state), String(state)).toEqual([]);
    }

    const restored = await client.restoreItem(id);
    expect(restored.status).toBe(200);
    expect(await found("glimmerwick")).toEqual([id]);
  }, 120_000);

  it("cannot be switched off for a file type, but is left unmatched by a type that declares it unsearchable", async () => {
    const child = await client.registerType({
      id: "acme.quiet-document",
      parent: "core.file",
      fields: { extracted_text: { type: "string", searchable: false } },
    });
    // A type inheriting a file type cannot give the field another
    // `searchable` than core.file gives it (`types/child-shape`), so the file
    // types always find the text they extract.
    expect(child.status).toBe(400);
    expect(child.error?.error.code).toBe("inheritance_violation");

    // The field's name is no reason to match it: where a type declares it
    // unsearchable, the same text is left unmatched.
    for (const [id, searchable] of [
      ["acme.loud-scan", true],
      ["acme.quiet-scan", false],
    ] as const) {
      const registered = await client.registerType({
        id,
        fields: { extracted_text: { type: "string", searchable } },
      });
      expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    }
    const make = async (type: string): Promise<string> => {
      const created = await client.createItem({
        type,
        tier: "library",
        properties: { extracted_text: "the tarragonic ledger" },
      });
      expect(created.status, JSON.stringify(created.error)).toBe(201);
      return created.data.item.id;
    };
    const loud = await make("acme.loud-scan");
    await make("acme.quiet-scan");
    expect(await found("tarragonic")).toEqual([loud]);
  });
});
