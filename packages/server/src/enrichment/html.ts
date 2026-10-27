import { Parser } from "htmlparser2";

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
 * The text a person would read in an HTML page, as plain text.
 *
 * A tokenizer reads the page, so no markup survives, scripts and styles are
 * dropped, entities are decoded, and a malformed page yields what the
 * tokenizer could recover rather than an error. The page is fed in chunks, so
 * a page larger than `maxChars` of text stops being read once enough is held
 * and an abort is noticed between chunks.
 */
export function extractHtmlText(
  source: string,
  opts: { maxChars: number; xml: boolean; signal?: AbortSignal },
): string {
  // Whitespace is collapsed as text arrives, so the collected length is close
  // to the final one; the margin covers the blank lines trimmed afterwards.
  const stopAt = opts.maxChars * 2;
  const parts: string[] = [];
  let length = 0;
  const stack: string[] = [];
  let skippedFrom = -1;
  let preformatted = 0;

  let atLineStart = true;

  const add = (text: string): void => {
    parts.push(text);
    length += text.length;
    atLineStart = text.endsWith("\n");
  };
  const breakLine = (): void => {
    if (!atLineStart) add("\n");
  };

  const parser = new Parser(
    {
      onopentag(name) {
        stack.push(name);
        if (skippedFrom < 0 && SKIPPED.has(name)) skippedFrom = stack.length;
        if (PREFORMATTED.has(name)) preformatted += 1;
        if (skippedFrom < 0) {
          if (BLOCKS.has(name)) breakLine();
          else if ((name === "td" || name === "th") && !atLineStart) add(" ");
        }
      },
      onclosetag(name) {
        const depth = stack.lastIndexOf(name);
        if (depth < 0) return;
        stack.length = depth;
        if (PREFORMATTED.has(name) && preformatted > 0) preformatted -= 1;
        if (skippedFrom > depth) {
          skippedFrom = -1;
          return;
        }
        if (skippedFrom < 0 && BLOCKS.has(name)) breakLine();
      },
      ontext(data) {
        if (skippedFrom >= 0) return;
        let text = preformatted > 0 ? data : data.replace(/\s+/g, " ");
        if (atLineStart && preformatted === 0) text = text.trimStart();
        if (text.length > 0) add(text);
      },
    },
    { recognizeSelfClosing: opts.xml },
  );

  for (
    let start = 0;
    start < source.length && length < stopAt;
    start += CHUNK_CHARS
  ) {
    if (opts.signal?.aborted) throw opts.signal.reason as Error;
    parser.write(source.slice(start, start + CHUNK_CHARS));
  }
  if (length < stopAt) parser.end();
  else parser.reset();

  return parts
    .join("")
    .replace(/[^\S\n]*\n[^\S\n]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/[^\S\n]{2,}/g, " ");
}
