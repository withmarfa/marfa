/**
 * The real tesseract engine against the real fixture. Everything else in
 * the suite injects a fake OCR seam, which is right for unit runs — and
 * means a tesseract.js upgrade that breaks recognition lands green. This
 * is the one place the actual engine runs, so a library change has a test
 * to fail.
 *
 * Opt-in via MARFA_TEST_OCR=1 (the CI SQLite lane sets it): the engine
 * downloads its language model on first use, and an unconditional network
 * fetch has no place in a default unit run. The model caches under
 * MARFA_ENRICHMENT_TESSDATA_DIR, so a persistent runner pays the download
 * once.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TesseractOcr } from "./ocr.js";

const enabled = process.env.MARFA_TEST_OCR === "1";

describe.skipIf(!enabled)("real OCR engine", () => {
  it("reads the rendered fixture text through tesseract", async () => {
    const ocr = new TesseractOcr({
      cachePath:
        process.env.MARFA_ENRICHMENT_TESSDATA_DIR ??
        join(tmpdir(), "marfa-tessdata"),
    });
    try {
      const bytes = await readFile(
        fileURLToPath(new URL("./fixtures/sample.png", import.meta.url)),
      );
      const text = await ocr.recognize(bytes);
      expect(text).toContain("quokkapng");
    } finally {
      await ocr.terminate();
    }
  }, 120_000);
});
