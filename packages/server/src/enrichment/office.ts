import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { SupportedFileType } from "officeparser";

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
 * The document asked for more than extraction may use, so it will not be
 * read under these limits however often it is tried. Anything else that
 * goes wrong is an ordinary `Error`, which the sweeper retries.
 */
export class ExtractionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionLimitError";
  }
}

const MEBIBYTE = 1024 * 1024;

/** Below this the process cannot load the parser at all (it fails near 8). */
const LEAST_HEAP_MB = 32;

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
    process.stdout.write(JSON.stringify({ text: text.slice(0, options.maxTextChars) }));
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

/** What a process that answered wrote. */
interface Answer {
  text?: string;
  error?: string;
  limit?: boolean;
}

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
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${String(
          Math.max(LEAST_HEAP_MB, Math.ceil(limits.maxMemoryBytes / MEBIBYTE)),
        )}`,
        "-e",
        PROGRAM,
        JSON.stringify({
          parser: createRequire(import.meta.url).resolve("officeparser"),
          fileType,
          maxInflatedBytes: limits.maxInflatedBytes,
          maxTextChars: limits.maxTextChars,
        }),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    // A cap on what the process may say, so a fault in it cannot fill this
    // one. What it writes is the text the server keeps, as JSON.
    const outputCap = limits.maxTextChars * 6 + 4096;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let written = 0;
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      settle();
    };
    const onAbort = () => {
      finish(() => {
        reject(abortReason(signal));
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      written += chunk.length;
      if (written > outputCap) {
        finish(() => {
          reject(new Error("the extraction process wrote more than it may"));
        });
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(err).length < 4096) err.push(chunk);
    });
    // The process can end before it has read its input.
    child.stdin.on("error", () => undefined);
    for (const pipe of [child.stdout, child.stderr]) {
      pipe.on("error", (error) => {
        finish(() => {
          reject(error);
        });
      });
    }
    child.on("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.on("close", (code, killedBy) => {
      finish(() => {
        const said = Buffer.concat(out).toString("utf8");
        if (said.length > 0) {
          let answer: Answer;
          try {
            answer = JSON.parse(said) as Answer;
          } catch {
            reject(new Error("the extraction process gave no usable answer"));
            return;
          }
          if (answer.error === undefined) resolve(answer.text ?? "");
          else if (answer.limit) reject(new ExtractionLimitError(answer.error));
          else reject(new Error(answer.error));
          return;
        }
        // V8 ends the process when its heap is full, and says so on stderr.
        if (
          /heap out of memory|Allocation failed/i.test(
            Buffer.concat(err).toString("utf8"),
          )
        ) {
          reject(
            new ExtractionLimitError(
              "the document needs more memory than extraction may use",
            ),
          );
          return;
        }
        reject(
          new Error(
            `the extraction process ended with ${
              killedBy ?? `code ${String(code)}`
            }`,
          ),
        );
      });
    });
    child.stdin.end(bytes);
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("extraction was stopped");
}
