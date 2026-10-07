import {
  OFFICE_MIME_TO_FILE_TYPE,
  extractOfficeText,
  type OfficeLimits,
} from "./office.js";
import { OCR_MIMES } from "./ocr.js";
import type { OcrEngine } from "./ocr.js";

const TEXT_MIMES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
]);

export type ExtractOutcome =
  { kind: "text"; text: string } | { kind: "unsupported" } | { kind: "empty" };

/**
 * Whether a declared MIME can yield text under the current configuration.
 * The sweeper consults this before touching blob metadata or bytes, so an
 * unreadable file costs nothing. `ocrAvailable` matters because an image
 * is only readable when an engine is configured — with OCR off, image
 * mimes are unsupported and must be recorded that way up front rather
 * than after their bytes have been fetched.
 */
export function isEnrichableMime(
  mime: string,
  opts: { ocrAvailable: boolean },
): boolean {
  const bare = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    TEXT_MIMES.has(bare) ||
    bare in OFFICE_MIME_TO_FILE_TYPE ||
    (opts.ocrAvailable && OCR_MIMES.has(bare))
  );
}

/**
 * Deterministic text extraction, dispatched on the item's declared MIME
 * type: plain text decodes, document formats parse (embedded text only),
 * images OCR when an engine is supplied. Anything else is `unsupported`,
 * which the sweeper records once and never retries.
 */
export async function extractText(
  bytes: Buffer,
  mimeType: string,
  opts: {
    maxTextChars: number;
    ocr: OcrEngine | null;
    office: Omit<OfficeLimits, "maxTextChars">;
    signal?: AbortSignal;
  },
): Promise<ExtractOutcome> {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";

  let text: string;
  if (TEXT_MIMES.has(mime)) {
    text = bytes.toString("utf8");
  } else if (mime in OFFICE_MIME_TO_FILE_TYPE) {
    const fileType = OFFICE_MIME_TO_FILE_TYPE[mime];
    if (fileType === undefined) return { kind: "unsupported" };
    text = await extractOfficeText(
      bytes,
      fileType,
      { ...opts.office, maxTextChars: opts.maxTextChars },
      opts.signal,
    );
  } else if (OCR_MIMES.has(mime)) {
    if (!opts.ocr) return { kind: "unsupported" };
    text = await opts.ocr.recognize(bytes);
  } else {
    return { kind: "unsupported" };
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  return { kind: "text", text: trimmed.slice(0, opts.maxTextChars) };
}
