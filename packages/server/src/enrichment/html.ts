import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runIsolated } from "./isolated.js";

/**
 * MIME types read as an HTML page. XHTML is the same page written as XML, so
 * its self-closing tags close.
 */
export const HTML_MIMES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
]);

/** Elements whose content is never shown as text. */
const SKIPPED = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
]);

/** Elements that start and end a line, so words either side never run together. */
const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "br",
  "caption",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "textarea",
  "title",
  "tr",
  "ul",
]);

/** Elements whose line breaks are kept as written. */
const PREFORMATTED = new Set(["pre", "textarea"]);

/** Characters of source fed to the parser between checks for the limits. */
const CHUNK_CHARS = 64 * 1024;

/**
 * The most bytes of a page that are read. A page past it is read up to here,
 * and the text found in that much is kept.
 */
export const HTML_MAX_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * Open elements held before the rest of the page is left unread, and the text
 * found before that point is kept. Each unmatched closing tag scans the open
 * elements, here and in the parser, so an unbounded depth makes a page of
 * unclosed tags followed by stray closing tags take quadratic time.
 */
export const HTML_MAX_DEPTH = 512;

/**
 * The tokenizer in a process of its own, one per page.
 *
 * Tokenizing runs on the thread it is called from and cannot be interrupted,
 * so a page that is slow to read holds the server's event loop until it is
 * done. In a process of its own it is bounded in memory and killed when the
 * item's time budget runs out, as a document is. A tokenizer reads the page,
 * so no markup survives, scripts and styles are dropped, entities are decoded,
 * and a malformed page yields what the tokenizer could recover rather than an
 * error. The page is fed in chunks, so a page with more than `maxTextChars` of
 * text stops being read once enough is held, and so does a page nested deeper
 * than `maxDepth`.
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
    const { Parser } = await import(options.parser);
    const skipped = new Set(options.skipped);
    const blocks = new Set(options.blocks);
    const preformattedTags = new Set(options.preformatted);
    // The decoder drops a character the input was cut in the middle of.
    const source = new TextDecoder().decode(Buffer.concat(chunks), { stream: true });
    // Whitespace is collapsed as text arrives, so the collected length is
    // close to the final one; the margin covers the blank lines trimmed
    // afterwards.
    const stopAt = options.maxTextChars * 2;
    const parts = [];
    let length = 0;
    const stack = [];
    let skippedFrom = -1;
    let preformatted = 0;
    let atLineStart = true;
    let tooDeep = false;

    const add = (text) => {
      parts.push(text);
      length += text.length;
      atLineStart = text.endsWith("\\n");
    };
    const breakLine = () => {
      if (!atLineStart) add("\\n");
    };

    const parser = new Parser(
      {
        onopentag(name) {
          if (tooDeep) return;
          stack.push(name);
          if (stack.length > options.maxDepth) {
            tooDeep = true;
            return;
          }
          if (skippedFrom < 0 && skipped.has(name)) skippedFrom = stack.length;
          if (preformattedTags.has(name)) preformatted += 1;
          if (skippedFrom < 0) {
            if (blocks.has(name)) breakLine();
            else if ((name === "td" || name === "th") && !atLineStart) add(" ");
          }
        },
        onclosetag(name) {
          if (tooDeep) return;
          const depth = stack.lastIndexOf(name);
          if (depth < 0) return;
          stack.length = depth;
          if (preformattedTags.has(name) && preformatted > 0) preformatted -= 1;
          if (skippedFrom > depth) {
            skippedFrom = -1;
            return;
          }
          if (skippedFrom < 0 && blocks.has(name)) breakLine();
        },
        ontext(data) {
          if (tooDeep || skippedFrom >= 0) return;
          let text = preformatted > 0 ? data : data.replace(/\\s+/g, " ");
          if (atLineStart && preformatted === 0) text = text.trimStart();
          if (text.length > 0) add(text);
        },
      },
      { recognizeSelfClosing: options.xml },
    );

    for (
      let start = 0;
      start < source.length && length < stopAt && !tooDeep;
      start += options.chunkChars
    ) {
      parser.write(source.slice(start, start + options.chunkChars));
    }
    if (length < stopAt && !tooDeep) parser.end();

    const text = parts
      .join("")
      .replace(/[^\\S\\n]*\\n[^\\S\\n]*/g, "\\n")
      .replace(/\\n{2,}/g, "\\n")
      .replace(/[^\\S\\n]{2,}/g, " ")
      .trim();
    // Not cut between the two units of a surrogate pair, which would leave
    // one alone at the end.
    let end = Math.min(text.length, options.maxTextChars);
    const before = text.charCodeAt(end - 1);
    const after = text.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
    process.stdout.write(JSON.stringify({ text: text.slice(0, end) }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      error: String((error && error.message) || error),
      limit: false,
    }));
  }
});
`;

/**
 * The text a person would read in an HTML page, as plain text.
 *
 * A page that passes a limit keeps the text read before it: the first
 * `HTML_MAX_INPUT_BYTES` bytes, the elements down to `HTML_MAX_DEPTH`, and
 * `maxTextChars` of text. A page that is not read within the time budget, set
 * by `signal`, gives no text and an error, and the item is retried like any
 * extraction that fails.
 */
export function extractHtmlText(
  bytes: Buffer,
  opts: {
    maxChars: number;
    maxMemoryBytes: number;
    xml: boolean;
    signal?: AbortSignal;
  },
): Promise<string> {
  return runIsolated({
    program: PROGRAM,
    options: {
      parser: pathToFileURL(
        createRequire(import.meta.url).resolve("htmlparser2"),
      ).href,
      skipped: [...SKIPPED],
      blocks: [...BLOCKS],
      preformatted: [...PREFORMATTED],
      xml: opts.xml,
      maxTextChars: opts.maxChars,
      maxDepth: HTML_MAX_DEPTH,
      chunkChars: CHUNK_CHARS,
    },
    bytes: bytes.subarray(0, HTML_MAX_INPUT_BYTES),
    maxMemoryBytes: opts.maxMemoryBytes,
    maxTextChars: opts.maxChars,
    signal: opts.signal,
  });
}
