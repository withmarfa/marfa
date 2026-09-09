import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { TextEnrichmentSweeper } from "./sweeper.js";
import { EXTRACTOR_VERSION } from "./extract.js";
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
    blobs: ctx.blobBackend,
    ocr: overrides.ocr ?? null,
    intervalMs: 30_000,
    batchSize: overrides.batchSize ?? 8,
    itemTimeoutMs: overrides.itemTimeoutMs ?? 60_000,
    maxBlobBytes: overrides.maxBlobBytes ?? 20 * 1024 * 1024,
    maxTextChars: overrides.maxTextChars ?? 200_000,
    maxAttempts: overrides.maxAttempts ?? 3,
  });
}

/** Puts bytes in the backend and registers them, the way an upload would. */
async function seedBlob(bytes: Buffer, mimeType: string): Promise<string> {
  const ref = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await ctx.blobBackend.put(ref, bytes, mimeType);
  await ctx.storage.blobs.register(ref, mimeType, bytes.length, ref, "");
  return ref;
}

async function createFileItem(
  blobRef: string,
  mimeType: string,
  type = "core.file",
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
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
    key: ctx.spaceKey,
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as {
    item: { properties: Record<string, unknown> };
  };
  return data.item.properties;
}

/** The signature the default-config sweeper stamps, for direct store reads. */
const DEFAULT_SIGNATURE = JSON.stringify({
  max_blob_bytes: 20 * 1024 * 1024,
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
      key: ctx.spaceKey,
    });
    expect(search.status).toBe(200);
    const found = (await search.json()) as {
      results: { item: { id: string } }[];
    };
    expect(found.results.map((r) => r.item.id)).toContain(id);
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
      key: ctx.spaceKey,
    });
    expect(search.status).toBe(200);
    const found = (await search.json()) as {
      results: { item: { id: string } }[];
    };
    expect(found.results.map((r) => r.item.id)).toContain(id);
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
      key: ctx.spaceKey,
      body: { properties: { title: "a title the user set" } },
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
      key: ctx.spaceKey,
      body: { properties: { blob_ref: replacement } },
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

  it("re-admits an item whose row predates the current extractor", async () => {
    const id = await createFileItem(
      await seedBlob(Buffer.from("stale row quokkastale"), "text/plain"),
      "text/plain",
    );
    const s = sweeper();
    expect(await s.runOnce()).toEqual({ extracted: 1, skipped: 0, failed: 0 });
    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 0, failed: 0 });

    const row = await ctx.storage.enrichment.get(id);
    expect(row).not.toBeNull();
    await ctx.storage.enrichment.upsert({
      ...row!,
      extractor_version: EXTRACTOR_VERSION - 1,
    });

    expect(await s.runOnce()).toEqual({ extracted: 1, skipped: 0, failed: 0 });
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
      key: ctx.spaceKey,
      body: {
        properties: { blob_ref: replacement, mime_type: "text/plain" },
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
    // The bytes are gone from the backend, so reaching for them would
    // surface as a missing-bytes failure. The MIME gate runs first: the
    // recorded reason is the type, not the absent read it never made.
    const ref = await seedBlob(Buffer.from("not readable"), "video/mp4");
    const id = await createFileItem(ref, "video/mp4");
    await ctx.blobBackend.delete(ref);
    const s = sweeper();

    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 1, failed: 0 });
    const row = await ctx.storage.enrichment.get(id);
    expect(row?.status).toBe("skipped");
    expect(row?.error).toBe("unsupported type");

    // Same configuration, so the row stays parked.
    const candidates = await ctx.storage.enrichment.listCandidates(
      EXTRACTOR_VERSION,
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
    await request(ctx.app, "DELETE", `/items/${id}`, { key: ctx.spaceKey });

    const candidates = await ctx.storage.enrichment.listCandidates(
      EXTRACTOR_VERSION,
      3,
      100,
      DEFAULT_SIGNATURE,
    );
    expect(candidates.map((c) => c.item_id)).not.toContain(id);
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
      key: ctx.spaceKey,
      body: { properties: { blob_ref: replacement } },
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
    // flaky backend — and must not be parked the way an unreadable MIME
    // is. It fails, retries, and succeeds once the bytes appear.
    const bytes = Buffer.from("late-arriving bytes quokkalate");
    const ref = await seedBlob(bytes, "text/plain");
    const id = await createFileItem(ref, "text/plain");
    await ctx.blobBackend.delete(ref);
    const s = sweeper();

    expect(await s.runOnce()).toEqual({ extracted: 0, skipped: 0, failed: 1 });
    const row = await ctx.storage.enrichment.get(id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("bytes missing");

    await ctx.blobBackend.put(ref, bytes, "text/plain");
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
