/**
 * What a file item holds from reading its bytes follows the bytes it names, so
 * this boots a server of its own with enrichment on and OCR off, which leaves
 * the text, the size and the length as the only things the sweep reads.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { QUIET_SCHEDULE } from "../../utils/moved-clock.js";

/** The source the fresh server's working key writes under. */
const SOURCE = "enrichment-new-bytes";

let server: FreshServer;
let client: MarfaClient;
let operator: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("enrichment-new-bytes", {
    ...QUIET_SCHEDULE,
    MARFA_ENRICHMENT_ENABLED: "true",
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

async function sweep(): Promise<void> {
  const run = await operator.runHousekeeping("enrichment-sweep");
  expect(run.status).toBe(200);
  expect(run.data.outcome).toBe("succeeded");
}

async function upload(bytes: Buffer, mime: string): Promise<string> {
  const uploaded = await client.uploadBlob(bytes, mime);
  expect(uploaded.status).toBe(201);
  return uploaded.data.hash;
}

async function create(
  type: string,
  properties: Record<string, unknown>,
  extra: { source?: string; source_id?: string } = {},
): Promise<{ id: string; version: number }> {
  const created = await client.createItem({ type, properties, ...extra });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return { id: created.data.item.id, version: created.data.item.version };
}

async function properties(id: string): Promise<Record<string, unknown>> {
  const read = await client.getItem(id);
  expect(read.status).toBe(200);
  return read.data.item.properties;
}

/** A plain-text file the sweep has read, and the text of other bytes to move it to. */
async function readText(): Promise<{
  id: string;
  version: number;
  hash: string;
  text: string;
  newHash: string;
  newText: string;
  sourceId: string;
}> {
  const stamp = randomUUID();
  const text = `first words ${stamp}`;
  const newText = `second words ${stamp}`;
  const hash = await upload(Buffer.from(text), "text/plain");
  const newHash = await upload(Buffer.from(newText), "text/plain");
  const item = await create(
    "core.file",
    { blob_ref: hash, mime_type: "text/plain", title: "moves" },
    { source: SOURCE, source_id: `moves-${stamp}` },
  );
  await sweep();
  // The witness: the sweep reads the bytes the item names.
  expect((await properties(item.id)).extracted_text).toBe(text);
  const read = await client.getItem(item.id);
  return {
    ...item,
    version: read.data.item.version,
    hash,
    text,
    newHash,
    newText,
    sourceId: `moves-${stamp}`,
  };
}

const doors: {
  name: string;
  replace: (file: Awaited<ReturnType<typeof readText>>) => Promise<void>;
}[] = [
  {
    name: "an update",
    replace: async (file) => {
      const updated = await client.updateItem(file.id, {
        version: file.version,
        properties: { blob_ref: file.newHash },
      });
      expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    },
  },
  {
    name: "an upsert by natural key",
    replace: async (file) => {
      const upserted = await client.createItem({
        type: "core.file",
        source: SOURCE,
        source_id: file.sourceId,
        properties: { blob_ref: file.newHash },
      });
      expect(upserted.status, JSON.stringify(upserted.error)).toBe(200);
    },
  },
  {
    name: "a bulk upsert",
    replace: async (file) => {
      const bulk = await client.bulkItems([
        {
          type: "core.file",
          source: SOURCE,
          source_id: file.sourceId,
          properties: { blob_ref: file.newHash, mime_type: "text/plain" },
        },
      ]);
      expect(bulk.status, JSON.stringify(bulk.error)).toBe(200);
      expect(bulk.data.results[0]?.outcome).toBe("updated");
    },
  },
  {
    name: "a bulk action",
    replace: async (file) => {
      const tag = `new-bytes-${randomUUID()}`;
      const tagged = await client.addTags(file.id, [tag]);
      expect(tagged.status, JSON.stringify(tagged.error)).toBe(200);
      const queued = await client.bulkAction({
        action: "update_properties",
        patch: { blob_ref: file.newHash },
        filter: { tags: [tag] },
      });
      expect(queued.status, JSON.stringify(queued.error)).toBe(202);
      const job = await client.pollBulkActionToTerminal(
        (queued.data as { id: string }).id,
      );
      expect(job.result?.succeeded).toBe(1);
    },
  },
  {
    name: "a write made against an earlier version",
    replace: async (file) => {
      const titled = await client.updateItem(file.id, {
        version: file.version,
        properties: { title: "renamed" },
      });
      expect(titled.status, JSON.stringify(titled.error)).toBe(200);
      const stale = await client.updateItem(file.id, {
        version: file.version,
        properties: { blob_ref: file.newHash },
      });
      expect(stale.status, JSON.stringify(stale.error)).toBe(200);
    },
  },
];

describe("a file item whose bytes are replaced", () => {
  it.each(doors)(
    "has the text of the new bytes after $name replaces the old",
    async ({ replace }) => {
      const file = await readText();
      await replace(file);

      const replaced = await properties(file.id);
      expect(replaced.blob_ref).toBe(file.newHash);
      expect(replaced.extracted_text).toBeUndefined();
      await sweep();
      expect((await properties(file.id)).extracted_text).toBe(file.newText);
    },
    120_000,
  );

  it("has the size and length of the new bytes, not of the old", async () => {
    const gif = readFileSync(
      fileURLToPath(new URL("./fixtures/image-sample.gif", import.meta.url)),
    );
    const larger = Buffer.from(gif);
    larger.writeUInt16LE(50, 6);
    larger.writeUInt16LE(40, 8);
    const wav = (seconds: number): Buffer => {
      const samples = 8000 * seconds;
      const bytes = Buffer.alloc(44 + samples, 0x80);
      bytes.write("RIFF", 0, "ascii");
      bytes.writeUInt32LE(bytes.length - 8, 4);
      bytes.write("WAVEfmt ", 8, "ascii");
      bytes.writeUInt32LE(16, 16);
      bytes.writeUInt16LE(1, 20);
      bytes.writeUInt16LE(1, 22);
      bytes.writeUInt32LE(8000, 24);
      bytes.writeUInt32LE(8000, 28);
      bytes.writeUInt16LE(1, 32);
      bytes.writeUInt16LE(8, 34);
      bytes.write("data", 36, "ascii");
      bytes.writeUInt32LE(samples, 40);
      return bytes;
    };
    // The bytes of each are made unique to this run, so no other file shares them.
    const stamp = Buffer.from(randomUUID());
    const image = await create("core.file.image", {
      blob_ref: await upload(Buffer.concat([gif, stamp]), "image/gif"),
      mime_type: "image/gif",
    });
    const audio = await create("core.file.audio", {
      blob_ref: await upload(Buffer.concat([wav(2), stamp]), "audio/wav"),
      mime_type: "audio/wav",
    });
    await sweep();
    expect(await properties(image.id)).toMatchObject({ width: 30, height: 20 });
    expect(await properties(audio.id)).toMatchObject({ duration: 2 });

    for (const [item, hash] of [
      [image, await upload(Buffer.concat([larger, stamp]), "image/gif")],
      [audio, await upload(Buffer.concat([wav(1), stamp]), "audio/wav")],
    ] as const) {
      const held = await client.getItem(item.id);
      const updated = await client.updateItem(item.id, {
        version: held.data.item.version,
        properties: { blob_ref: hash },
      });
      expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    }
    const imageNow = await properties(image.id);
    expect(imageNow.width).toBeUndefined();
    expect(imageNow.height).toBeUndefined();
    expect((await properties(audio.id)).duration).toBeUndefined();

    await sweep();
    expect(await properties(image.id)).toMatchObject({ width: 50, height: 40 });
    expect(await properties(audio.id)).toMatchObject({ duration: 1 });
  }, 120_000);

  it("keeps a value the write that replaces the bytes sets", async () => {
    const file = await readText();
    const updated = await client.updateItem(file.id, {
      version: file.version,
      properties: {
        blob_ref: file.newHash,
        extracted_text: "typed by the writer",
      },
    });
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    expect(updated.data.item.properties.extracted_text).toBe(
      "typed by the writer",
    );
    await sweep();
    expect((await properties(file.id)).extracted_text).toBe(
      "typed by the writer",
    );
  }, 120_000);

  it("keeps what was read when a write leaves the bytes as they are", async () => {
    const file = await readText();
    const retitled = await client.updateItem(file.id, {
      version: file.version,
      properties: { title: "renamed" },
    });
    expect(retitled.status, JSON.stringify(retitled.error)).toBe(200);
    const same = await client.updateItem(file.id, {
      version: retitled.data.item.version,
      properties: { blob_ref: file.hash, title: "named again" },
    });
    expect(same.status, JSON.stringify(same.error)).toBe(200);
    const kept = await properties(file.id);
    expect(kept.title).toBe("named again");
    expect(kept.extracted_text).toBe(file.text);

    // The witness: the same item loses the text once it names other bytes.
    const replaced = await client.updateItem(file.id, {
      version: same.data.item.version,
      properties: { blob_ref: file.newHash },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    expect((await properties(file.id)).extracted_text).toBeUndefined();
  }, 120_000);
});
