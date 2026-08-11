import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractText, isEnrichableMime } from "./extract.js";
import { TesseractOcr } from "./ocr.js";
import type { OcrEngine } from "./ocr.js";

const fixture = (name: string): Promise<Buffer> =>
  readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

const OPTS = { maxTextChars: 200_000, ocr: null };

/** Records what it was handed so a test can prove the dispatch reached OCR. */
class FakeOcr implements OcrEngine {
  seen: Buffer[] = [];
  terminated = 0;
  constructor(private text: string) {}
  recognize(bytes: Buffer): Promise<string> {
    this.seen.push(bytes);
    return Promise.resolve(this.text);
  }
  terminate(): Promise<void> {
    this.terminated += 1;
    return Promise.resolve();
  }
}

describe("mime dispatch", () => {
  it("claims the formats it can read", () => {
    for (const mime of [
      "text/plain",
      "text/markdown",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/png",
    ]) {
      expect(isEnrichableMime(mime, { ocrAvailable: true }), mime).toBe(true);
    }
  });

  it("ignores parameters and case on the way in", () => {
    expect(
      isEnrichableMime("TEXT/PLAIN; charset=utf-8", { ocrAvailable: true }),
    ).toBe(true);
  });

  it("disclaims what it cannot read", () => {
    for (const mime of ["video/mp4", "application/zip", "application/x-tar"]) {
      expect(isEnrichableMime(mime, { ocrAvailable: true }), mime).toBe(false);
    }
  });

  it("disclaims images when no OCR engine is configured", () => {
    expect(isEnrichableMime("image/png", { ocrAvailable: false })).toBe(false);
    expect(isEnrichableMime("text/plain", { ocrAvailable: false })).toBe(true);
  });
});

describe("extractText", () => {
  it("decodes plain text", async () => {
    const bytes = await fixture("sample.txt");
    const out = await extractText(bytes, "text/plain", OPTS);
    expect(out.kind).toBe("text");
    if (out.kind === "text") expect(out.text).toContain("quokkatxt");
  });

  it("reads a word document", async () => {
    const bytes = await fixture("sample.docx");
    const out = await extractText(
      bytes,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      OPTS,
    );
    expect(out.kind).toBe("text");
    if (out.kind === "text") expect(out.text).toContain("quokkadocx");
  });

  it("reads a spreadsheet", async () => {
    const bytes = await fixture("sample.xlsx");
    const out = await extractText(
      bytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      OPTS,
    );
    expect(out.kind).toBe("text");
    if (out.kind === "text") expect(out.text).toContain("quokkaxlsx");
  });

  it("reads the embedded text of a pdf", async () => {
    const bytes = await fixture("sample.pdf");
    const out = await extractText(bytes, "application/pdf", OPTS);
    expect(out.kind).toBe("text");
    if (out.kind === "text") expect(out.text).toContain("quokkapdf");
  });

  it("sends images to the OCR engine when one is supplied", async () => {
    const ocr = new FakeOcr("recognized marker");
    const bytes = await fixture("sample.png");
    const out = await extractText(bytes, "image/png", { ...OPTS, ocr });
    expect(out.kind).toBe("text");
    if (out.kind === "text") expect(out.text).toBe("recognized marker");
    expect(ocr.seen).toHaveLength(1);
  });

  it("treats images as unsupported when OCR is off", async () => {
    const bytes = await fixture("sample.png");
    const out = await extractText(bytes, "image/png", OPTS);
    expect(out.kind).toBe("unsupported");
  });

  it("reports an empty document rather than empty text", async () => {
    const out = await extractText(Buffer.from("   \n\t "), "text/plain", OPTS);
    expect(out.kind).toBe("empty");
  });

  it("truncates to the character cap", async () => {
    const bytes = Buffer.from("x".repeat(5_000));
    const out = await extractText(bytes, "text/plain", {
      ...OPTS,
      maxTextChars: 100,
    });
    expect(out.kind).toBe("text");
    if (out.kind === "text") expect(out.text).toHaveLength(100);
  });

  it("refuses a type it has no reader for", async () => {
    const out = await extractText(Buffer.from("..."), "video/mp4", OPTS);
    expect(out.kind).toBe("unsupported");
  });
});

describe("TesseractOcr", () => {
  it("creates the worker lazily and reuses it", async () => {
    let created = 0;
    const worker = {
      recognize: () => Promise.resolve({ data: { text: "from worker" } }),
      terminate: () => Promise.resolve(),
    };
    const ocr = new TesseractOcr({
      cachePath: "/tmp/unused",
      createWorkerFn: (() => {
        created += 1;
        return Promise.resolve(worker);
      }) as never,
    });
    expect(created).toBe(0);
    expect(await ocr.recognize(Buffer.from(""))).toBe("from worker");
    expect(await ocr.recognize(Buffer.from(""))).toBe("from worker");
    expect(created).toBe(1);
  });

  it("recovers after termination", async () => {
    let created = 0;
    const ocr = new TesseractOcr({
      cachePath: "/tmp/unused",
      createWorkerFn: (() => {
        created += 1;
        return Promise.resolve({
          recognize: () => Promise.resolve({ data: { text: "ok" } }),
          terminate: () => Promise.resolve(),
        });
      }) as never,
    });
    await ocr.recognize(Buffer.from(""));
    await ocr.terminate();
    // Idempotent: a second terminate with no live worker is not an error.
    await ocr.terminate();
    await ocr.recognize(Buffer.from(""));
    expect(created).toBe(2);
  });
});

/**
 * The real engine, opt-in. It downloads a language model on first use and
 * takes tens of seconds, so CI never runs it; the point is to prove the
 * library actually works rather than that the seam is shaped right, which
 * the fake covers. Run with `MARFA_TEST_OCR=1`.
 */
describe.skipIf(process.env.MARFA_TEST_OCR !== "1")("real OCR", () => {
  it("reads the marker off the fixture image", async () => {
    const ocr = new TesseractOcr({ cachePath: "./data/tessdata" });
    try {
      const bytes = await fixture("sample.png");
      const out = await extractText(bytes, "image/png", { ...OPTS, ocr });
      expect(out.kind).toBe("text");
      if (out.kind === "text") {
        expect(out.text.toLowerCase()).toContain("quokkapng");
      }
    } finally {
      await ocr.terminate();
    }
  }, 120_000);
});
