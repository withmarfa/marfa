import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { TextEnrichmentSweeper } from "./sweeper.js";
import { EXTRACTOR_VERSION } from "./extract.js";
import type { OcrEngine } from "./ocr.js";

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
    key: ctx.adminKey,
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
    key: ctx.adminKey,
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as {
    item: { properties: Record<string, unknown> };
  };
  return data.item.properties;
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("extraction", () => {
  it("puts a document's text on the item and finds it by search", async () => {
    const bytes = await fixture("sample.docx");
    const mime =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const id = await createFileItem(await seedBlob(bytes, mime), mime);

    const result = await sweeper().runOnce();
    expect(result.extracted).toBeGreaterThanOrEqual(1);

    const props = await readItem(id);
    expect(String(props.extracted_text)).toContain("quokkadocx");
    // The claim that matters operationally: extraction makes the file
    // findable. FTS indexes every unmarked string property, so the write
    // above is the whole search wiring.
    const search = await request(ctx.app, "GET", "/search?q=quokkadocx", {
      key: ctx.adminKey,
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

    await sweeper({ ocr }).runOnce();

    const props = await readItem(id);
    expect(props.extracted_text).toBe("subtype marker text");
    expect(ocr.calls).toBe(1);
  });

  it("leaves other properties alone", async () => {
    const bytes = await fixture("sample.txt");
    const ref = await seedBlob(bytes, "text/plain");
    const id = await createFileItem(ref, "text/plain");
    await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      body: { properties: { title: "a title the user set" } },
    });

    await sweeper().runOnce();

    const props = await readItem(id);
    expect(props.title).toBe("a title the user set");
    expect(props.blob_ref).toBe(ref);
    expect(String(props.extracted_text)).toContain("quokkatxt");
  });

  it("does nothing on a second pass", async () => {
    const bytes = Buffer.from("second pass marker quokkarepeat");
    await createFileItem(await seedBlob(bytes, "text/plain"), "text/plain");
    const s = sweeper();

    const first = await s.runOnce();
    expect(first.extracted).toBeGreaterThanOrEqual(1);
    const second = await s.runOnce();
    expect(second.extracted).toBe(0);
  });

  it("re-extracts when the blob is replaced", async () => {
    const id = await createFileItem(
      await seedBlob(Buffer.from("before quokkabefore"), "text/plain"),
      "text/plain",
    );
    await sweeper().runOnce();
    expect(String((await readItem(id)).extracted_text)).toContain(
      "quokkabefore",
    );

    const replacement = await seedBlob(
      Buffer.from("after quokkaafter"),
      "text/plain",
    );
    await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      body: { properties: { blob_ref: replacement } },
    });

    const again = await sweeper().runOnce();
    expect(again.extracted).toBeGreaterThanOrEqual(1);
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
    await s.runOnce();
    expect((await s.runOnce()).extracted).toBe(0);

    const row = await ctx.storage.enrichment.get(id);
    expect(row).not.toBeNull();
    await ctx.storage.enrichment.upsert({
      ...row!,
      extractor_version: EXTRACTOR_VERSION - 1,
    });

    expect((await s.runOnce()).extracted).toBeGreaterThanOrEqual(1);
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
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    expect((await readItem(id)).extracted_text).toBeUndefined();
    const row = await ctx.storage.enrichment.get(id);
    expect(row?.status).toBe("skipped");
    expect(row?.error).toContain("size limit");
  });

  it("records an unsupported type once and never offers it again", async () => {
    const id = await createFileItem(
      await seedBlob(Buffer.from("not readable"), "video/mp4"),
      "video/mp4",
    );
    const s = sweeper();

    await s.runOnce();
    expect((await ctx.storage.enrichment.get(id))?.status).toBe("skipped");

    const candidates = await ctx.storage.enrichment.listCandidates(
      EXTRACTOR_VERSION,
      3,
      100,
    );
    expect(candidates.map((c) => c.item_id)).not.toContain(id);
  });

  it("ignores a trashed item", async () => {
    const id = await createFileItem(
      await seedBlob(Buffer.from("trashed quokkatrash"), "text/plain"),
      "text/plain",
    );
    await request(ctx.app, "DELETE", `/items/${id}`, { key: ctx.adminKey });

    const candidates = await ctx.storage.enrichment.listCandidates(
      EXTRACTOR_VERSION,
      3,
      100,
    );
    expect(candidates.map((c) => c.item_id)).not.toContain(id);
  });

  it("records an empty document rather than writing an empty string", async () => {
    const id = await createFileItem(
      await seedBlob(Buffer.from("   \n  "), "text/plain"),
      "text/plain",
    );

    await sweeper().runOnce();

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

    await s.runOnce();
    expect((await ctx.storage.enrichment.get(id))?.attempts).toBe(1);
    await s.runOnce();
    expect((await ctx.storage.enrichment.get(id))?.attempts).toBe(2);

    const row = await ctx.storage.enrichment.get(id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("engine exploded");

    const candidates = await ctx.storage.enrichment.listCandidates(
      EXTRACTOR_VERSION,
      2,
      100,
    );
    expect(candidates.map((c) => c.item_id)).not.toContain(id);
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
    expect(result.failed).toBeGreaterThanOrEqual(1);
    // Every overrun terminates the worker: the batch may carry retryable
    // failures left by earlier cases, and each one has to be cleaned up.
    expect(ocr.terminated).toBe(result.failed);
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

    await sweeper({ ocr }).runOnce();

    expect(String((await readItem(good)).extracted_text)).toContain(
      "quokkasurvive",
    );
    expect((await ctx.storage.enrichment.get(bad))?.status).toBe("failed");
  });

  it("skips an item whose bytes have gone", async () => {
    const bytes = Buffer.from("bytes about to vanish quokkavanish");
    const ref = await seedBlob(bytes, "text/plain");
    const id = await createFileItem(ref, "text/plain");
    await ctx.blobBackend.delete(ref);

    await sweeper().runOnce();

    const row = await ctx.storage.enrichment.get(id);
    expect(row?.status).toBe("skipped");
    expect(row?.error).toContain("bytes missing");
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
    expect(result.extracted + result.skipped + result.failed).toBe(2);
  });
});
