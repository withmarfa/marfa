import { setInterval, clearInterval } from "node:timers";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExtractionLimitError, extractOfficeText } from "./office.js";
import { docx, longParagraph, manyParagraphs } from "./test-documents.js";

const MIB = 1024 * 1024;

const GENEROUS = {
  maxInflatedBytes: 1024 * MIB,
  maxMemoryBytes: 1024 * MIB,
  maxTextChars: 1000,
};

describe("a document that inflates", () => {
  it("is refused past the inflated bound, and the same bytes are read once the bound is raised", async () => {
    const bomb = docx(longParagraph(80 * MIB));
    // The witness for the amplification: small on the wire, large once read.
    expect(bomb.length).toBeLessThan(200 * 1024);

    const refused = await extractOfficeText(bomb, "docx", {
      ...GENEROUS,
      maxInflatedBytes: 64 * MIB,
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ExtractionLimitError);

    const text = await extractOfficeText(bomb, "docx", GENEROUS);
    expect(text).toBe("a".repeat(1000));
  });

  it("is refused for a zip of more entries than the parser reads, not retried as a failure", async () => {
    const crowded = docx(longParagraph(10), 10_001);
    const refused = await extractOfficeText(crowded, "docx", GENEROUS).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ExtractionLimitError);
    // The witness: the same document with room in it for its parts reads.
    expect(
      await extractOfficeText(docx(longParagraph(10), 10), "docx", GENEROUS),
    ).toBe("aaaaaaaaaa");
  });
});

describe("a document that needs more memory than extraction may use", () => {
  it("is refused as past the limits, and the same document is read when it may use more", async () => {
    // Far inside any inflated bound worth setting, and more than the heap
    // below can hold once the parser has built it.
    const heavy = docx(manyParagraphs(50_000));
    expect(heavy.length).toBeLessThan(MIB);

    const refused = await extractOfficeText(heavy, "docx", {
      ...GENEROUS,
      maxMemoryBytes: 64 * MIB,
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ExtractionLimitError);
    expect((refused as Error).message).toMatch(/memory/);

    const text = await extractOfficeText(heavy, "docx", GENEROUS);
    expect(text.startsWith("word")).toBe(true);
  });

  it("is refused whatever the environment says of the heap", async () => {
    const before = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--max-old-space-size=8192";
    try {
      const refused = await extractOfficeText(
        docx(manyParagraphs(50_000)),
        "docx",
        { ...GENEROUS, maxMemoryBytes: 64 * MIB },
      ).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ExtractionLimitError);
    } finally {
      if (before === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = before;
    }
  });
});

describe("the time limit", () => {
  it("stops a document that is being read, whatever the thread is doing", async () => {
    const bomb = docx(longParagraph(80 * MIB));
    const budget = new AbortController();
    const started = performance.now();
    const reading = extractOfficeText(bomb, "docx", GENEROUS, budget.signal);
    setTimeout(() => {
      budget.abort(new Error("extraction timed out"));
    }, 50);
    await expect(reading).rejects.toThrow("extraction timed out");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("does not start for a signal that has already fired", async () => {
    const budget = new AbortController();
    budget.abort(new Error("extraction timed out"));
    await expect(
      extractOfficeText(
        docx(longParagraph(10)),
        "docx",
        GENEROUS,
        budget.signal,
      ),
    ).rejects.toThrow("extraction timed out");
  });
});

describe("a PDF", () => {
  const pdf = readFileSync(
    fileURLToPath(new URL("./fixtures/multipage.pdf", import.meta.url)),
  );

  /** The processes running right now whose command line holds `needle`. */
  const running = (needle: string): number =>
    execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(needle)).length;

  /** Whether `read` had a process of the parser's own for PDFs start beside
   *  it. That process stays up after a parse until the parent ends, so the
   *  count is taken against the ones already there. */
  async function sawPdfProcess(read: () => Promise<unknown>): Promise<boolean> {
    let seen = false;
    const before = running("--input-type=commonjs");
    const watch = setInterval(() => {
      if (running("--input-type=commonjs") > before) seen = true;
    }, 5);
    try {
      await read();
    } finally {
      clearInterval(watch);
    }
    return seen;
  }

  it("is read inside the process that has the memory limit, and not in a second one the parser starts with its own", async () => {
    const { parseOffice } = createRequire(import.meta.url)(
      "officeparser",
    ) as typeof import("officeparser");
    // The witness: left to itself the parser reads a PDF in a process of its
    // own, with a heap of its own.
    expect(
      await sawPdfProcess(() => parseOffice(pdf, { fileType: "pdf" })),
    ).toBe(true);

    let text = "";
    expect(
      await sawPdfProcess(async () => {
        text = await extractOfficeText(pdf, "pdf", {
          ...GENEROUS,
          maxMemoryBytes: 64 * MIB,
        });
      }),
    ).toBe(false);
    expect(text.length).toBeGreaterThan(0);
  });
});
