/**
 * The enrichment sweep reads bytes only for a file whose own reference
 * lends them, so this boots its own server: enrichment is off on the shared
 * one.
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
let owner: MarfaClient;
let operator: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("enrichment-reach", {
    MARFA_ENRICHMENT_ENABLED: "true",
    // Driven through the housekeeping door rather than the scheduler.
    MARFA_ENRICHMENT_INTERVAL_MS: "3600000",
  });
  owner = new MarfaClient({
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

async function sweep(): Promise<void> {
  const run = await operator.runHousekeeping("enrichment-sweep");
  expect(run.status).toBe(200);
  expect(run.data.outcome, run.data.error ?? "").toBe("ok");
}

async function extracted(client: MarfaClient, id: string): Promise<unknown> {
  const read = await client.getItem(id);
  expect(read.status).toBe(200);
  return read.data.item.properties.extracted_text;
}

describe("the enrichment sweep and a blob's reach", () => {
  it("extracts only from bytes the file's own reference lends", async () => {
    const hidden = new TextEncoder().encode("the quokka ledger, page one");
    const shown = new TextEncoder().encode("the wombat ledger, page one");
    const hiddenUpload = await owner.uploadBlob(hidden, "text/plain");
    const shownUpload = await owner.uploadBlob(shown, "text/plain");
    expect(hiddenUpload.status).toBe(201);
    expect(shownUpload.status).toBe(201);
    // The owner's note lends the hidden bytes to note readers only.
    const linked = await owner.createItem({
      type: "core.note",
      properties: { body: `![it](${hiddenUpload.data.hash})` },
    });
    expect(linked.status).toBe(201);

    const minted = await owner.createKey({
      label: "files only",
      source: "enrichment-reach-files",
      type_permissions: { "core.file": "write" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    const fileWriter = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.data.key,
    });
    expect((await fileWriter.downloadBlob(hiddenUpload.data.hash)).status).toBe(
      404,
    );

    const named = await fileWriter.createItem({
      type: "core.file",
      properties: {
        blob_ref: hiddenUpload.data.hash,
        mime_type: "text/plain",
        title: "named, never sent",
      },
    });
    expect(named.status, JSON.stringify(named.error)).toBe(201);
    // The witness: the same sweep extracts from a file whose writer sent
    // its bytes.
    const own = await owner.createItem({
      type: "core.file",
      properties: {
        blob_ref: shownUpload.data.hash,
        mime_type: "text/plain",
        title: "sent by its writer",
      },
    });
    expect(own.status, JSON.stringify(own.error)).toBe(201);

    await sweep();
    expect(await extracted(owner, own.data.item.id)).toBe(
      "the wombat ledger, page one",
    );
    expect(await extracted(fileWriter, named.data.item.id)).toBeUndefined();

    // Once the file's writer has sent the bytes, a file it writes naming
    // them lends them, and the next sweep reads them; the first file's
    // reference lends nothing while it names the digest.
    expect((await fileWriter.uploadBlob(hidden, "text/plain")).status).toBe(
      201,
    );
    const proven = await fileWriter.createItem({
      type: "core.file",
      properties: {
        blob_ref: hiddenUpload.data.hash,
        mime_type: "text/plain",
        title: "named after sending",
      },
    });
    expect(proven.status, JSON.stringify(proven.error)).toBe(201);
    await sweep();
    expect(await extracted(fileWriter, proven.data.item.id)).toBe(
      "the quokka ledger, page one",
    );
    expect(await extracted(fileWriter, named.data.item.id)).toBeUndefined();
  });
  it("keeps a digest the sweep wrote dead after a full key rewrites the file", async () => {
    const secret = new TextEncoder().encode("the numbat ledger, sealed");
    const secretUpload = await owner.uploadBlob(secret, "text/plain");
    expect(secretUpload.status).toBe(201);
    const lent = await owner.createItem({
      type: "core.note",
      properties: { body: `![it](${secretUpload.data.hash})` },
    });
    expect(lent.status).toBe(201);

    const minted = await owner.createKey({
      label: "files that name a secret",
      source: "enrichment-reach-planter",
      type_permissions: { "core.file": "write" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    const planter = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.data.key,
    });
    const digest = secretUpload.data.hash.slice("sha256:".length);
    const carrier = new TextEncoder().encode(`notes on ${digest}`);
    const carrierUpload = await planter.uploadBlob(carrier, "text/plain");
    expect(carrierUpload.status).toBe(201);
    const file = await planter.createItem({
      type: "core.file",
      properties: {
        blob_ref: carrierUpload.data.hash,
        mime_type: "text/plain",
        title: "carries a digest in its text",
      },
    });
    expect(file.status, JSON.stringify(file.error)).toBe(201);

    await sweep();
    const swept = await owner.getItem(file.data.item.id);
    expect(swept.ok).toBe(true);
    expect(String(swept.data.item.properties.extracted_text)).toContain(digest);
    expect((await planter.downloadBlob(secretUpload.data.hash)).status).toBe(
      404,
    );

    // The owner, who reads every blob, rewrites the whole file.
    const rewritten = await owner.updateItem(file.data.item.id, {
      properties: swept.data.item.properties,
      properties_mode: "replace",
      version: swept.data.item.version,
    });
    expect(rewritten.ok, JSON.stringify(rewritten.error)).toBe(true);
    expect((await planter.downloadBlob(secretUpload.data.hash)).status).toBe(
      404,
    );
  });

  it("reads the width, height and duration only of bytes the file's own reference lends", async () => {
    const image = readFileSync(
      fileURLToPath(new URL("./fixtures/image-sample.gif", import.meta.url)),
    );
    // Eight-bit mono PCM at 8000 samples a second: two seconds of silence.
    const wav = Buffer.alloc(44 + 16000, 0x80);
    wav.write("RIFF", 0, "ascii");
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8, "ascii");
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(8000, 28);
    wav.writeUInt16LE(1, 32);
    wav.writeUInt16LE(8, 34);
    wav.write("data", 36, "ascii");
    wav.writeUInt32LE(16000, 40);

    const minted = await owner.createKey({
      label: "media files only",
      source: "enrichment-reach-media",
      type_permissions: {
        "core.file.image": "write",
        "core.file.audio": "write",
      },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    const fileWriter = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.data.key,
    });

    const media = [
      { type: "core.file.image", mime: "image/gif", bytes: image },
      { type: "core.file.audio", mime: "audio/wav", bytes: wav },
    ];
    const items: { type: string; named: string; own: string }[] = [];
    for (const { type, mime, bytes } of media) {
      const sent = await owner.uploadBlob(bytes, mime);
      expect(sent.status, type).toBe(201);
      // The owner's note lends the bytes to note readers; the file writer
      // names them without ever sending them.
      const linked = await owner.createItem({
        type: "core.note",
        properties: { body: `![it](${sent.data.hash})` },
      });
      expect(linked.status, type).toBe(201);
      const named = await fileWriter.createItem({
        type,
        properties: { blob_ref: sent.data.hash, mime_type: mime },
      });
      expect(named.status, JSON.stringify(named.error)).toBe(201);
      const own = await owner.createItem({
        type,
        properties: { blob_ref: sent.data.hash, mime_type: mime },
      });
      expect(own.status, JSON.stringify(own.error)).toBe(201);
      items.push({
        type,
        named: named.data.item.id,
        own: own.data.item.id,
      });
    }

    await sweep();
    const read = async (client: MarfaClient, id: string) => {
      const res = await client.getItem(id);
      expect(res.status).toBe(200);
      return res.data.item.properties;
    };
    const [gif, audio] = items as [(typeof items)[0], (typeof items)[0]];
    // The witness: the sweep reads what a file's own reference lends.
    const ownImage = await read(owner, gif.own);
    expect(ownImage.width).toBe(30);
    expect(ownImage.height).toBe(20);
    expect(await read(owner, audio.own)).toMatchObject({ duration: 2 });

    const namedImage = await read(fileWriter, gif.named);
    expect(namedImage.width).toBeUndefined();
    expect(namedImage.height).toBeUndefined();
    expect((await read(fileWriter, audio.named)).duration).toBeUndefined();
  });
});
