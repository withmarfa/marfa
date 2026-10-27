import { createRequire } from "node:module";
import type { SupportedFileType } from "officeparser";
import { runIsolated } from "./isolated.js";

/**
 * MIME types the document extractor handles, mapped to the parser's file
 * type hint. Sniffing from bytes alone misreads the zip-container formats
 * (a docx and an odt are both zip archives), so the item's declared
 * `mime_type` drives the dispatch and the hint pins the parser's reading.
 */
export const OFFICE_MIME_TO_FILE_TYPE: Readonly<
  Record<string, SupportedFileType>
> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
};

/** What one document's extraction may use. */
export interface OfficeLimits {
  /** The most bytes the document may inflate to, all of its parts together. */
  maxInflatedBytes: number;
  /** The most the parser's JavaScript heap may take. The process also holds
   *  the document and what it inflates to, outside that heap. */
  maxMemoryBytes: number;
  /** The text kept. The parser's whole text is cut here inside the process
   *  that reads it, so a document that yields far more never crosses back. */
  maxTextChars: number;
}

/**
 * The parser in a process of its own, one per document.
 *
 * Inflating a document and building its text run on the thread they are
 * called from and cannot be interrupted, so a document that inflates to a
 * gigabyte holds the server's event loop, and its memory, until it is done.
 * Here the heap is capped by a flag on the command line, which the
 * environment's own `NODE_OPTIONS` cannot raise, as it can a worker thread's
 * limit; a document that needs more ends this process and not the server's;
 * and it can be killed at any moment, which the time limit does.
 *
 * The bytes come in on stdin and the text goes out on stdout as one JSON
 * line, cut to the length the server keeps.
 */
const PROGRAM = `
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
  const options = JSON.parse(process.argv[1]);
  try {
    const { parseOffice } = require(options.parser);
    const ast = await parseOffice(Buffer.concat(chunks), {
      fileType: options.fileType,
      decompressionLimits: { maxUncompressedBytes: options.maxInflatedBytes },
      // The parser reads a PDF in a process of its own with a heap of its
      // own by default, which would escape the limit this process has.
      pdfParserConfig: { separateProcess: false },
    });
    const text = (await ast.to("text")).value.trim();
    // Not cut between the two units of a surrogate pair, which would leave
    // one alone at the end.
    let end = Math.min(text.length, options.maxTextChars);
    const before = text.charCodeAt(end - 1);
    const after = text.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
    process.stdout.write(JSON.stringify({ text: text.slice(0, end) }));
  } catch (error) {
    const message = String((error && error.message) || error);
    process.stdout.write(JSON.stringify({
      error: message,
      limit: /_LIMIT_EXCEEDED$|^MAX_NESTING_DEPTH_EXCEEDED$/.test(
        String(error && error.officeIssue && error.officeIssue.code),
      ),
    }));
  }
});
`;

/**
 * Extracts the plain text of a document. PDF extraction reads embedded
 * text only: a scanned page-image PDF yields nothing, deliberately, because
 * OCR of rasterized pages is a different cost class and stays out of the
 * deterministic sweep. The parser's own optional OCR stays off for the
 * same reason.
 *
 * Aborting `signal` kills the process, whatever it was doing.
 */
export function extractOfficeText(
  bytes: Buffer,
  fileType: SupportedFileType,
  limits: OfficeLimits,
  signal?: AbortSignal,
): Promise<string> {
  return runIsolated({
    program: PROGRAM,
    options: {
      parser: createRequire(import.meta.url).resolve("officeparser"),
      fileType,
      maxInflatedBytes: limits.maxInflatedBytes,
      maxTextChars: limits.maxTextChars,
    },
    bytes,
    maxMemoryBytes: limits.maxMemoryBytes,
    maxTextChars: limits.maxTextChars,
    signal,
  });
}
