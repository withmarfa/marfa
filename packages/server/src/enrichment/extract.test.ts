import { describe, it, expect } from "vitest";
import { DEFAULT_MAX_STRING_LENGTH } from "@withmarfa/shared";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractText, isEnrichableMime } from "./extract.js";
import { Worker } from "node:worker_threads";
import { TesseractOcr } from "./ocr.js";
import type { OcrEngine } from "./ocr.js";

const fixture = (name: string): Promise<Buffer> =>
  readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

const OPTS = { maxTextChars: DEFAULT_MAX_STRING_LENGTH, ocr: null };

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

  // The reader below these is held at a forced version, because the parsing
  // library pins one carrying an arbitrary-execution advisory. A single
  // one-page uncompressed document is thin cover for a reader swap, so the
  // two shapes most likely to expose a difference are covered too: text
  // spanning several pages, and a Flate-compressed content stream.
  it("reads text from every page of a multi-page pdf", async () => {
    const bytes = await fixture("multipage.pdf");
    const out = await extractText(bytes, "application/pdf", OPTS);
    expect(out.kind).toBe("text");
    if (out.kind === "text") {
      expect(out.text).toContain("page one");
      expect(out.text).toContain("page two marker");
      expect(out.text).toContain("page three");
    }
  });

  it("reads text from a pdf whose content stream is compressed", async () => {
    const bytes = await fixture("compressed.pdf");
    const out = await extractText(bytes, "application/pdf", OPTS);
    expect(out.kind).toBe("text");
    if (out.kind === "text") {
      expect(out.text).toContain("compressed stream marker");
    }
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
  /** A thread answering every job with `text`, or ending on the first job
   *  when `dies` is set, the way the library throws out of a listener. */
  function fakeThread(behavior: { text?: string; dies?: boolean }): Worker {
    return new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       parentPort.on("message", ({ id }) => {
         if (workerData.dies) throw new Error("refused out of band");
         parentPort.postMessage({ id, text: workerData.text });
       });`,
      { eval: true, workerData: behavior },
    );
  }

  it("starts the thread lazily and reuses it", async () => {
    let spawned = 0;
    const ocr = new TesseractOcr({
      cachePath: "/tmp/unused",
      spawnThread: () => {
        spawned += 1;
        return fakeThread({ text: "from worker" });
      },
    });
    try {
      expect(spawned).toBe(0);
      expect(await ocr.recognize(Buffer.from(""))).toBe("from worker");
      expect(await ocr.recognize(Buffer.from(""))).toBe("from worker");
      expect(spawned).toBe(1);
    } finally {
      await ocr.terminate();
    }
  });

  it("recovers after termination", async () => {
    let spawned = 0;
    const ocr = new TesseractOcr({
      cachePath: "/tmp/unused",
      spawnThread: () => {
        spawned += 1;
        return fakeThread({ text: "ok" });
      },
    });
    await ocr.recognize(Buffer.from(""));
    await ocr.terminate();
    // Idempotent: a second terminate with no live thread is not an error.
    await ocr.terminate();
    await ocr.recognize(Buffer.from(""));
    expect(spawned).toBe(2);
    await ocr.terminate();
  });

  it("fails the job of a thread that dies, and starts afresh for the next", async () => {
    // What the library does with an image its decoder cannot read, or a
    // language model it cannot load: it throws where nothing can catch it.
    // In the server's own thread that ended the process.
    let spawned = 0;
    const ocr = new TesseractOcr({
      cachePath: "/tmp/unused",
      spawnThread: () => {
        spawned += 1;
        return spawned === 1
          ? fakeThread({ dies: true })
          : fakeThread({ text: "second" });
      },
    });
    try {
      await expect(ocr.recognize(Buffer.from(""))).rejects.toThrow();
      expect(await ocr.recognize(Buffer.from(""))).toBe("second");
      expect(spawned).toBe(2);
    } finally {
      await ocr.terminate();
    }
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
