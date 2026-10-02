import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_MAX_STRING_LENGTH } from "@withmarfa/shared";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { TextEnrichmentSweeper } from "./sweeper.js";
import type { OcrEngine } from "./ocr.js";

/**
 * Each test gets its own context, deliberately. The sweeper sweeps the
 * whole table, so a shared item pool makes every count an at-least-one
 * assertion — and an at-least-one assertion cannot catch a sweep that
 * processed the wrong items alongside the right ones. Isolation is what
 * lets every count below be exact.
 */
let ctx: TestContext;

const fixture = (name: string): Promise<Buffer> =>
  readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

class FakeOcr implements OcrEngine {
  calls = 0;
  terminated = 0;
  constructor(private behavior: () => Promise<string>) {}
  recognize(): Promise<string> {
    this.calls += 1;
    return this.behavior();
  }
  terminate(): Promise<void> {
    this.terminated += 1;
    return Promise.resolve();
  }
}

function sweeper(
  overrides: Partial<{
    ocr: OcrEngine | null;
    batchSize: number;
    itemTimeoutMs: number;
    maxBlobBytes: number;
    maxTextChars: number;
    maxAttempts: number;
  }> = {},
): TextEnrichmentSweeper {
  return new TextEnrichmentSweeper({
    storage: ctx.storage,
    blobs: ctx.blobs,
    ocr: overrides.ocr ?? null,
    batchSize: overrides.batchSize ?? 8,
    itemTimeoutMs: overrides.itemTimeoutMs ?? 60_000,
    maxBlobBytes: overrides.maxBlobBytes ?? 20 * 1024 * 1024,
    maxTextChars: overrides.maxTextChars ?? DEFAULT_MAX_STRING_LENGTH,
    maxAttempts: overrides.maxAttempts ?? 3,
  });
}

/** Uploads bytes with the working key, so the file items it writes naming
 *  them lend their reach and the sweep may read them. */
async function seedBlob(bytes: Buffer, mimeType: string): Promise<string> {
  const ref = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const res = await ctx.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.workingKey}`,
      "Content-Type": mimeType,
    },
    body: bytes,
  });
  expect(res.status).toBe(201);
  return ref;
}

async function createFileItem(
  blobRef: string,
  mimeType: string,
  type = "core.file",
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type,
      properties: { blob_ref: blobRef, mime_type: mimeType, ...extra },
    },
  });
  expect(
    res.status,
    `POST /items -> ${String(res.status)}: ${await res.clone().text()}`,
  ).toBe(201);
  const data = (await res.json()) as { item: { id: string } };
  return data.item.id;
}

async function readItem(id: string): Promise<Record<string, unknown>> {
  const res = await request(ctx.app, "GET", `/items/${id}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as {
    item: { properties: Record<string, unknown> };
  };
  return data.item.properties;
}

async function readVersion(id: string): Promise<number> {
  const res = await request(ctx.app, "GET", `/items/${id}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { item: { version: number } };
  return data.item.version;
}

/** The signature the default-config sweeper stamps, for direct store reads. */
const DEFAULT_SIGNATURE = JSON.stringify({
  max_blob_bytes: 20 * 1024 * 1024,
  max_text_chars: DEFAULT_MAX_STRING_LENGTH,
  ocr: false,
});

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

describe("extraction", () => {
  it("puts a document's text on the item and finds it by search", async () => {
    const bytes = await fixture("sample.docx");
    const mime =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const id = await createFileItem(await seedBlob(bytes, mime), mime);

    const result = await sweeper().runOnce();
    expect(result).toEqual({ extracted: 1, skipped: 0, failed: 0 });

    const props = await readItem(id);
    expect(String(props.extracted_text)).toContain("quokkadocx");
    // The claim that matters operationally: extraction makes the file
    // findable. FTS indexes every unmarked string property, so the write
    // above is the whole search wiring.
    const search = await request(ctx.app, "GET", "/search?q=quokkadocx", {
      key: ctx.workingKey,
    });
    expect(search.status).toBe(200);
    const found = (await search.json()) as {
      data: { item: { id: string } }[];
    };
    expect(found.data.map((r) => r.item.id)).toContain(id);
  });

  // A PDF is the one uploaded shape that reaches a reader with a history of
  // arbitrary-execution advisories, and the version behind it is forced by an
  // override rather than chosen by the parsing library. This drives the whole
  // path a caller's document actually takes — upload, sweep, extract, find by
  // content — so a reader that resolved wrongly fails here rather than in
  // production.
  it("puts an uploaded pdf's text on the item and finds it by search", async () => {
    const bytes = await fixture("multipage.pdf");
    const mime = "application/pdf";
    const id = await createFileItem(await seedBlob(bytes, mime), mime);

    const result = await sweeper().runOnce();
    expect(result).toEqual({ extracted: 1, skipped: 0, failed: 0 });

    const props = await readItem(id);
    expect(String(props.extracted_text)).toContain("page two marker");

    const search = await request(ctx.app, "GET", "/search?q=quokkapdf", {
      key: ctx.workingKey,
    });
    expect(search.status).toBe(200);
    const found = (await search.json()) as {
      data: { item: { id: string } }[];
    };
    expect(found.data.map((r) => r.item.id)).toContain(id);
  });

  it("extracts from a subtype of file", async () => {
    const bytes = await fixture("sample.png");
    const ocr = new FakeOcr(() => Promise.resolve("subtype marker text"));
    const id = await createFileItem(
      await seedBlob(bytes, "image/png"),
      "image/png",
      "core.file.image",
      { width: 1700, height: 2200 },
    );

    const result = await sweeper({ ocr }).runOnce();
    expect(result).toEqual({ extracted: 1, skipped: 0, failed: 0 });

    const props = await readItem(id);
    expect(props.extracted_text).toBe("subtype marker text");
    expect(ocr.calls).toBe(1);
  });

  it("leaves other properties alone", async () => {
    const bytes = await fixture("sample.txt");
    const ref = await seedBlob(bytes, "text/plain");
    const id = await createFileItem(ref, "text/plain");
    await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: {
        properties: { title: "a title the user set" },
        version: await readVersion(id),
      },
    });

    expect(await sweeper().runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 0,
    });

    const props = await readItem(id);
    expect(props.title).toBe("a title the user set");
    expect(props.blob_ref).toBe(ref);
    expect(String(props.extracted_text)).toContain("quokkatxt");
  });

  it("does nothing on a second pass", async () => {
    const bytes = Buffer.from("second pass marker quokkarepeat");
    await createFileItem(await seedBlob(bytes, "text/plain"), "text/plain");
    const s = sweeper();

    expect(await s.runOnce()).toEqual({ extracted: 1, skipped: 0, failed: 0 });
    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 0, failed: 0 });
  });

  it("re-extracts when the blob is replaced", async () => {
    const id = await createFileItem(
      await seedBlob(Buffer.from("before quokkabefore"), "text/plain"),
      "text/plain",
    );
    expect(await sweeper().runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 0,
    });
    expect(String((await readItem(id)).extracted_text)).toContain(
      "quokkabefore",
    );

    const replacement = await seedBlob(
      Buffer.from("after quokkaafter"),
      "text/plain",
    );
    await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: {
        properties: { blob_ref: replacement },
        version: await readVersion(id),
      },
    });

    expect(await sweeper().runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 0,
    });
    expect(String((await readItem(id)).extracted_text)).toContain(
      "quokkaafter",
    );
  });

  it("does not write text for a blob the item no longer references", async () => {
    // The blob is replaced mid-extraction. The sweeper re-reads before it
    // writes, so the stale text is discarded, nothing is recorded, and the
    // next pass extracts the replacement.
    const id = await createFileItem(
      await seedBlob(await fixture("sample.png"), "image/png"),
      "image/png",
    );
    const replacement = await seedBlob(
      Buffer.from("replacement quokkanew"),
      "text/plain",
    );

    let release!: (text: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const ocr = new FakeOcr(() => gate);
    const s = sweeper({ ocr });

    const run = s.runOnce();
    // Wait for extraction to begin, then re-point the item while the OCR
    // "recognition" is still in flight.
    await expect.poll(() => ocr.calls).toBe(1);
    await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: {
        properties: { blob_ref: replacement, mime_type: "text/plain" },
        version: await readVersion(id),
      },
    });
    release("stale text from the old blob");

    expect(await run).toEqual({ extracted: 0, skipped: 1, failed: 0 });
    expect((await readItem(id)).extracted_text).toBeUndefined();
    // Nothing recorded for the aborted write, so the next pass extracts
    // the replacement blob.
    expect(await ctx.storage.enrichment.get(id)).toBeNull();
    expect(await sweeper().runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 0,
    });
    expect(String((await readItem(id)).extracted_text)).toContain("quokkanew");
  });
});

describe("skips", () => {
  it("skips a blob over the size ceiling without reading it", async () => {
    const bytes = Buffer.from("small but over the ceiling quokkabig");
    const id = await createFileItem(
      await seedBlob(bytes, "text/plain"),
      "text/plain",
    );

    const result = await sweeper({ maxBlobBytes: 4 }).runOnce();
    expect(result).toEqual({ extracted: 0, skipped: 1, failed: 0 });

    expect((await readItem(id)).extracted_text).toBeUndefined();
    const row = await ctx.storage.enrichment.get(id);
    expect(row?.status).toBe("skipped");
    expect(row?.error).toContain("size limit");
  });

  it("reconsiders a size-ceiling skip when the ceiling is raised", async () => {
    // A skip is terminal only under the configuration that made it: the
    // raised ceiling changes the config signature and the row re-offers.
    const id = await createFileItem(
      await seedBlob(Buffer.from("reconsidered quokkaceiling"), "text/plain"),
      "text/plain",
    );

    expect(await sweeper({ maxBlobBytes: 4 }).runOnce()).toEqual({
      extracted: 0,
      skipped: 1,
      failed: 0,
    });
    expect(await sweeper().runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 0,
    });
    expect(String((await readItem(id)).extracted_text)).toContain(
      "quokkaceiling",
    );
  });

  it("reconsiders an image skipped while OCR was off once it is on", async () => {
    const id = await createFileItem(
      await seedBlob(await fixture("sample.png"), "image/png"),
      "image/png",
    );

    expect(await sweeper({ ocr: null }).runOnce()).toEqual({
      extracted: 0,
      skipped: 1,
      failed: 0,
    });
    expect((await ctx.storage.enrichment.get(id))?.error).toBe(
      "unsupported type",
    );

    const ocr = new FakeOcr(() => Promise.resolve("now readable"));
    expect(await sweeper({ ocr }).runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 0,
    });
    expect((await readItem(id)).extracted_text).toBe("now readable");
  });

  it("records an unsupported type without touching the blob", async () => {
    // The bytes are gone from the store, so reaching for them would
    // surface as a missing-bytes failure. The MIME gate runs first: the
    // recorded reason is the type, not the absent read it never made.
    const ref = await seedBlob(Buffer.from("not readable"), "video/mp4");
    const id = await createFileItem(ref, "video/mp4");
    await ctx.blobs.disk.delete(ref);
    const s = sweeper();

    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 1, failed: 0 });
    const row = await ctx.storage.enrichment.get(id);
    expect(row?.status).toBe("skipped");
    expect(row?.error).toBe("unsupported type");

    // Same configuration, so the row stays parked.
    const candidates = await ctx.storage.enrichment.listCandidates(
      3,
      100,
      DEFAULT_SIGNATURE,
    );
    expect(candidates.map((c) => c.item_id)).not.toContain(id);
  });

  it("ignores a trashed item", async () => {
    const id = await createFileItem(
      await seedBlob(Buffer.from("trashed quokkatrash"), "text/plain"),
      "text/plain",
    );
    const candidateIds = async () =>
      (
        await ctx.storage.enrichment.listCandidates(3, 100, DEFAULT_SIGNATURE)
      ).map((c) => c.item_id);
    // A candidate while it is live, and not once it is trashed.
    expect(await candidateIds()).toContain(id);
    await request(ctx.app, "DELETE", `/items/${id}`, { key: ctx.workingKey });
    expect(await candidateIds()).not.toContain(id);
  });

  it("records an empty document rather than writing an empty string", async () => {
    const id = await createFileItem(
      await seedBlob(Buffer.from("   \n  "), "text/plain"),
      "text/plain",
    );

    expect(await sweeper().runOnce()).toEqual({
      extracted: 0,
      skipped: 1,
      failed: 0,
    });

    expect((await readItem(id)).extracted_text).toBeUndefined();
    expect((await ctx.storage.enrichment.get(id))?.status).toBe("skipped");
  });

  it("parks an extraction the type would refuse rather than writing it", async () => {
    // The reported shape, driven by the only configuration that can
    // produce it: a truncation ceiling set above the one the validator
    // enforces. Neither store validates on update, so without the judge
    // the write would simply succeed and every later edit of the item be
    // refused, naming a property the caller had never set.
    const overLong = "q".repeat(DEFAULT_MAX_STRING_LENGTH + 1);
    const id = await createFileItem(
      await seedBlob(Buffer.from(overLong), "text/plain"),
      "text/plain",
    );

    const result = await sweeper({
      maxTextChars: DEFAULT_MAX_STRING_LENGTH * 2,
    }).runOnce();
    expect(result).toEqual({ extracted: 0, skipped: 1, failed: 0 });

    expect((await readItem(id)).extracted_text).toBeUndefined();
    const row = await ctx.storage.enrichment.get(id);
    // Skipped, not failed: the refusal is fixed under this configuration, so
    // a retry budget spent on it only reaches the same answer three times.
    expect(row?.status).toBe("skipped");
    expect(row?.error).toContain("extracted_text");

    // The claim that matters to a caller: the item is still writable.
    const patch = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: {
        properties: { title: "still editable" },
        version: await readVersion(id),
      },
    });
    expect(patch.status).toBe(200);
  });

  it("reconsiders a refused extraction once the ceiling is back under the validator's", async () => {
    const overLong = "q".repeat(DEFAULT_MAX_STRING_LENGTH + 1);
    const id = await createFileItem(
      await seedBlob(Buffer.from(overLong), "text/plain"),
      "text/plain",
    );

    expect(
      await sweeper({ maxTextChars: DEFAULT_MAX_STRING_LENGTH * 2 }).runOnce(),
    ).toEqual({ extracted: 0, skipped: 1, failed: 0 });

    // The ceiling is in the config signature precisely so this re-offers.
    expect(await sweeper().runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 0,
    });
    expect(String((await readItem(id)).extracted_text)).toHaveLength(
      DEFAULT_MAX_STRING_LENGTH,
    );
  });
});

describe("dimensions", () => {
  it("derives an image's width and height", async () => {
    // No client values at all: the dimensions are derived, not sent.
    const id = await createFileItem(
      await seedBlob(await fixture("sample.png"), "image/png"),
      "image/png",
      "core.file.image",
    );

    expect(await sweeper().runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 0,
    });

    const props = await readItem(id);
    expect(props.width).toBe(1700);
    expect(props.height).toBe(2200);
  });

  it("leaves a client-supplied value alone", async () => {
    // Deliberately wrong values: derivation filling an absence is useful,
    // derivation overruling the uploader is a client losing an argument it
    // did not know it was having.
    const id = await createFileItem(
      await seedBlob(await fixture("sample.png"), "image/png"),
      "image/png",
      "core.file.image",
      { width: 7, height: 9 },
    );

    await sweeper().runOnce();

    const props = await readItem(id);
    expect(props.width).toBe(7);
    expect(props.height).toBe(9);
  });

  it("derives an audio file's duration", async () => {
    const id = await createFileItem(
      await seedBlob(await fixture("sample.mp3"), "audio/mpeg"),
      "audio/mpeg",
      "core.file.audio",
    );

    expect(await sweeper().runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 0,
    });

    expect(Number((await readItem(id)).duration)).toBeGreaterThan(0.5);
  });

  it("derives a webm's width, height and duration", async () => {
    const id = await createFileItem(
      await seedBlob(await fixture("sample.webm"), "video/webm"),
      "video/webm",
      "core.file.video",
    );

    expect(await sweeper().runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 0,
    });

    const props = await readItem(id);
    expect(props.width).toBe(160);
    expect(props.height).toBe(120);
    expect(Number(props.duration)).toBeGreaterThan(0.5);
  });

  it("writes an mp4's duration and records the size it could not read", async () => {
    // A partial derivation is a write and a record, not a failure. The row
    // says what is still missing, which is the data a later decision about
    // a second video reader has to rest on.
    const id = await createFileItem(
      await seedBlob(await fixture("sample.mp4"), "video/mp4"),
      "video/mp4",
      "core.file.video",
    );

    expect(await sweeper().runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 0,
    });

    const props = await readItem(id);
    expect(Number(props.duration)).toBeGreaterThan(0.5);
    expect(props.width).toBeUndefined();

    const row = await ctx.storage.enrichment.get(id);
    expect(row?.status).toBe("done");
    expect(row?.error).toContain("width");
  });

  it("parks a media file neither reader understands", async () => {
    const id = await createFileItem(
      await seedBlob(Buffer.from("not an image"), "image/x-made-up"),
      "image/x-made-up",
      "core.file.image",
    );

    expect(await sweeper().runOnce()).toEqual({
      extracted: 0,
      skipped: 1,
      failed: 0,
    });

    expect((await readItem(id)).width).toBeUndefined();
    const row = await ctx.storage.enrichment.get(id);
    // Skipped rather than failed: an unreadable format is fixed under this
    // configuration, so a retry budget spent on it buys nothing.
    expect(row?.status).toBe("skipped");
    expect(row?.error).toContain("no image reader");
  });

  it("records a GIF, JPEG or WebP with a malformed header against its file", async () => {
    // Each signature over garbage, which the reader alone would size; the
    // reader's own tests hold the real headers that it does size.
    const malformed: [string, Buffer][] = [
      [
        "image/gif",
        Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64, 0x5a)]),
      ],
      [
        "image/jpeg",
        Buffer.concat([
          Buffer.from([0xff, 0xd8, 0xff, 0xc0]),
          Buffer.alloc(64, 0x5a),
        ]),
      ],
      [
        "image/webp",
        Buffer.concat([
          (await fixture("sample.webp")).subarray(0, 16),
          Buffer.alloc(64, 0x5a),
        ]),
      ],
    ];
    const ids: string[] = [];
    for (const [mime, bytes] of malformed) {
      ids.push(
        await createFileItem(
          await seedBlob(bytes, mime),
          mime,
          "core.file.image",
        ),
      );
    }

    expect(await sweeper().runOnce()).toEqual({
      extracted: 0,
      skipped: 3,
      failed: 0,
    });

    for (const id of ids) {
      const props = await readItem(id);
      expect(props.width).toBeUndefined();
      expect(props.height).toBeUndefined();
      const row = await ctx.storage.enrichment.get(id);
      expect(row?.status).toBe("skipped");
      expect(row?.error).toBe("no image header");
    }
  });

  it("does not derive onto a type that declares no such field", async () => {
    // A plain `core.file` has no `width`, so writing one would leave a
    // stray property on a schema with no opinion about it. The MIME gate
    // is not enough on its own; the type is what decides.
    const id = await createFileItem(
      await seedBlob(await fixture("sample.png"), "image/png"),
      "image/png",
    );

    expect(await sweeper({ ocr: null }).runOnce()).toEqual({
      extracted: 0,
      skipped: 1,
      failed: 0,
    });

    expect((await readItem(id)).width).toBeUndefined();
    expect((await ctx.storage.enrichment.get(id))?.error).toBe(
      "unsupported type",
    );
  });

  it("derives dimensions alongside text on one write", async () => {
    const ocr = new FakeOcr(() => Promise.resolve("text in the picture"));
    const id = await createFileItem(
      await seedBlob(await fixture("sample.png"), "image/png"),
      "image/png",
      "core.file.image",
    );

    expect(await sweeper({ ocr }).runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 0,
    });

    const props = await readItem(id);
    expect(props.extracted_text).toBe("text in the picture");
    expect(props.width).toBe(1700);
  });

  it("keeps the dimensions when the text extraction throws", async () => {
    // The derivation is cheap and cannot fail; an OCR worker dying is the
    // usual way the text half does. Losing both because one broke would
    // deny every image its size for as long as OCR is unhealthy.
    const ocr = new FakeOcr(() => Promise.reject(new Error("engine exploded")));
    const id = await createFileItem(
      await seedBlob(await fixture("sample.png"), "image/png"),
      "image/png",
      "core.file.image",
    );

    expect(await sweeper({ ocr, maxAttempts: 1 }).runOnce()).toEqual({
      extracted: 0,
      skipped: 0,
      failed: 1,
    });

    const props = await readItem(id);
    expect(props.width).toBe(1700);
    expect(props.extracted_text).toBeUndefined();
    // Failed, so the retry budget still applies to the half that is missing.
    const row = await ctx.storage.enrichment.get(id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("engine exploded");
  });
});

describe("failures", () => {
  it("stops retrying at the attempts cap", async () => {
    const ocr = new FakeOcr(() => Promise.reject(new Error("engine exploded")));
    const id = await createFileItem(
      await seedBlob(await fixture("sample.png"), "image/png"),
      "image/png",
    );
    const s = sweeper({ ocr, maxAttempts: 2 });

    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 0, failed: 1 });
    expect((await ctx.storage.enrichment.get(id))?.attempts).toBe(1);
    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 0, failed: 1 });
    expect((await ctx.storage.enrichment.get(id))?.attempts).toBe(2);

    const row = await ctx.storage.enrichment.get(id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("engine exploded");

    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 0, failed: 0 });
  });

  it("grants a replaced blob a fresh retry budget", async () => {
    // Attempts count against one generation of content. Before the reset,
    // a file that had used its budget on an old blob got its first attempt
    // on the new one recorded as already past the cap.
    const ocr = new FakeOcr(() => Promise.reject(new Error("engine exploded")));
    const id = await createFileItem(
      await seedBlob(await fixture("sample.png"), "image/png"),
      "image/png",
    );
    const s = sweeper({ ocr, maxAttempts: 2 });
    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 0, failed: 1 });
    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 0, failed: 1 });
    expect((await ctx.storage.enrichment.get(id))?.attempts).toBe(2);

    // A different image lands in the same item slot.
    const replacement = await seedBlob(
      Buffer.concat([await fixture("sample.png"), Buffer.from([0])]),
      "image/png",
    );
    await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: {
        properties: { blob_ref: replacement },
        version: await readVersion(id),
      },
    });

    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 0, failed: 1 });
    const row = await ctx.storage.enrichment.get(id);
    // First attempt against the new content, not third against the item.
    expect(row?.attempts).toBe(1);
    expect(row?.blob_ref).toBe(replacement);
    // And the fresh budget is real: the second attempt still runs.
    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 0, failed: 1 });
    expect((await ctx.storage.enrichment.get(id))?.attempts).toBe(2);
  });

  it("terminates the OCR worker when an item overruns its budget", async () => {
    const ocr = new FakeOcr(
      () =>
        new Promise<string>((resolve) => setTimeout(resolve, 5_000, "late")),
    );
    const id = await createFileItem(
      await seedBlob(await fixture("sample.png"), "image/png"),
      "image/png",
    );

    const result = await sweeper({ ocr, itemTimeoutMs: 50 }).runOnce();
    expect(result).toEqual({ extracted: 0, skipped: 0, failed: 1 });
    expect(ocr.terminated).toBe(1);
    const row = await ctx.storage.enrichment.get(id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("timed out");
  });

  it("keeps going after one item fails", async () => {
    const good = await createFileItem(
      await seedBlob(Buffer.from("survivor quokkasurvive"), "text/plain"),
      "text/plain",
    );
    const bad = await createFileItem(
      await seedBlob(await fixture("sample.png"), "image/png"),
      "image/png",
    );
    const ocr = new FakeOcr(() => Promise.reject(new Error("nope")));

    expect(await sweeper({ ocr }).runOnce()).toEqual({
      extracted: 1,
      skipped: 0,
      failed: 1,
    });

    expect(String((await readItem(good)).extracted_text)).toContain(
      "quokkasurvive",
    );
    expect((await ctx.storage.enrichment.get(bad))?.status).toBe("failed");
  });

  it("retries an item whose bytes were not there yet", async () => {
    // A missing read is transient — a blob write that had not landed, a
    // flaky store — and must not be parked the way an unreadable MIME
    // is. It fails, retries, and succeeds once the bytes appear.
    const bytes = Buffer.from("late-arriving bytes quokkalate");
    const ref = await seedBlob(bytes, "text/plain");
    const id = await createFileItem(ref, "text/plain");
    await ctx.blobs.disk.delete(ref);
    const s = sweeper();

    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 0, failed: 1 });
    const row = await ctx.storage.enrichment.get(id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("bytes missing");

    await ctx.blobs.disk.put(ref, {
      stream: Readable.from(bytes),
      size_bytes: bytes.length,
    });
    expect(await s.runOnce()).toEqual({ extracted: 1, skipped: 0, failed: 0 });
    expect(String((await readItem(id)).extracted_text)).toContain("quokkalate");
  });
});

describe("batching", () => {
  it("takes no more than the batch size per pass", async () => {
    for (let i = 0; i < 3; i += 1) {
      await createFileItem(
        await seedBlob(Buffer.from(`batch item ${String(i)}`), "text/plain"),
        "text/plain",
      );
    }
    const s = sweeper({ batchSize: 2 });
    const result = await s.runOnce();
    expect(result).toEqual({ extracted: 2, skipped: 0, failed: 0 });
  });
});
