import type { DisplayHints } from "./type-registry.js";

// The device's copy is `core/marfa-core/src/display.rs`, and
// `conformance/fixtures/item-display.json` holds both to the same cases, so a
// change here is made there too.

const NAME_POINTS = 120;
const SPACE = /^\s$/u;
const CONTROL = /^\p{Cc}$/u;
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/gu;
const PUNCTUATION = /^[!-/:-@[-`{-~]$/u;
const WORD = /^[\p{Alphabetic}\p{N}]$/u;
const SCHEME = /^[A-Za-z0-9+.-]$/u;

const isSpace = (c: string | undefined) => c !== undefined && SPACE.test(c);

const PREVIEW_POINTS = 240;

interface Named {
  field: string;
  /** The index, among the value's lines, of the line the name came from. */
  line: number;
  text: string;
}

/** The name, the property it came from and the line of that property. */
function named(
  properties: Record<string, unknown>,
  hints?: DisplayHints,
): Named | undefined {
  // Whether the field holds Markdown (`types/item-name-markdown`); a field
  // listed twice is read as it is first listed.
  const fields: [string | undefined, boolean][] = [
    [hints?.title_field, false],
    ["title", false],
    ["name", false],
    [hints?.body_field, true],
    ["body", true],
    ["text", true],
    ["filename", false],
    ["url", false],
    ["address", false],
  ];
  const tried = new Set<string>();
  for (const [field, markdown] of fields) {
    if (field === undefined || tried.has(field)) continue;
    tried.add(field);
    const value = properties[field];
    if (typeof value !== "string") continue;
    const found = markdown ? markdownName(value) : plainName(value);
    if (found !== undefined) return { field, ...found };
  }
  return undefined;
}

/** The plain, bounded name used by item summaries and their name search. */
export function itemName(
  properties: Record<string, unknown>,
  hints?: DisplayHints,
): string {
  return named(properties, hints)?.text ?? "Untitled";
}

/**
 * The text of an item's body with its Markdown removed, leaving out the line
 * its name came from and every line before it, or `undefined` where nothing
 * is left (`device/item-preview-*`).
 */
export function itemPreview(
  properties: Record<string, unknown>,
  hints?: DisplayHints,
): string | undefined {
  const property = hints?.body_field ?? "body";
  const body = properties[property];
  if (typeof body !== "string") return undefined;
  const source = named(properties, hints);
  const skipped = source?.field === property ? source.line : undefined;
  const plain = new Plain(PREVIEW_POINTS);
  for (const line of markdownLines(body)) {
    if (plain.full()) break;
    if (skipped !== undefined && line.at <= skipped) continue;
    if (line.code) plain.pushAll(line.text);
    else inline(Array.from(line.text), plain);
    plain.push(" ");
  }
  return plain.finish();
}

function* lines(text: string): Generator<string> {
  let start = 0;
  for (const end of text.matchAll(LINE_BREAK)) {
    yield text.slice(start, end.index);
    start = end.index + end[0].length;
  }
  yield text.slice(start);
}

const blank = (line: string) => !/\S/u.test(line);

function plainName(value: string): { line: number; text: string } | undefined {
  let line = -1;
  for (const text of lines(value)) {
    line++;
    if (blank(text)) continue;
    const plain = new Plain(NAME_POINTS);
    plain.pushAll(text);
    const name = plain.finish();
    return name === undefined ? undefined : { line, text: name };
  }
  return undefined;
}

function markdownName(
  value: string,
): { line: number; text: string } | undefined {
  for (const line of markdownLines(value)) {
    const plain = new Plain(NAME_POINTS);
    if (line.code) plain.pushAll(line.text);
    else inline(Array.from(line.text), plain);
    if (plain.seen) {
      const text = plain.finish();
      return text === undefined ? undefined : { line: line.at, text };
    }
  }
  return undefined;
}

/**
 * Text with each control character read as a space, each run of whitespace
 * collapsed to one space and the ends trimmed, cut at `limit` code points.
 */
class Plain {
  private readonly text: string[] = [];
  private points = 0;
  private space = false;
  seen = false;

  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  full(): boolean {
    return this.points > this.limit;
  }

  push(c: string): void {
    if (this.full()) return;
    if (!isSpace(c)) this.seen = true;
    const shown = CONTROL.test(c) ? " " : c;
    if (isSpace(shown)) {
      this.space = this.points > 0;
      return;
    }
    if (this.space) {
      this.text.push(" ");
      this.points++;
      this.space = false;
    }
    this.text.push(shown);
    this.points++;
  }

  pushAll(text: string): void {
    for (const c of text) {
      if (this.full()) return;
      this.push(c);
    }
  }

  finish(): string | undefined {
    if (this.points === 0) return undefined;
    if (!this.full()) return this.text.join("");
    return this.text.slice(0, this.limit - 1).join("") + "…";
  }
}

const trimStart = (text: string) => text.replace(/^\s+/u, "");
const trimEnd = (text: string) => text.replace(/\s+$/u, "");

function runOf(text: string, mark: string): number {
  let length = 0;
  while (text[length] === mark) length++;
  return length;
}

/** The lines Markdown removal keeps, fenced lines as written. */
function* markdownLines(
  text: string,
): Generator<{ at: number; code: boolean; text: string }> {
  let fence: { mark: string; length: number } | undefined;
  let at = -1;
  for (const line of lines(text)) {
    at++;
    const content = trimStart(line);
    if (fence) {
      const closing = trimEnd(content);
      if (
        closing.length >= fence.length &&
        runOf(closing, fence.mark) === closing.length
      )
        fence = undefined;
      else yield { at, code: true, text: line };
      continue;
    }
    const mark = ["`", "~"].find((m) => runOf(content, m) >= 3);
    if (mark !== undefined) {
      fence = { mark, length: runOf(content, mark) };
      continue;
    }
    if (isBreak(content) || isReference(content)) continue;
    yield { at, code: false, text: stripBlocks(content) };
  }
}

/** A thematic break, or a heading's `=` underline. */
function isBreak(content: string): boolean {
  const marks = Array.from(content).filter((c) => !isSpace(c));
  const first = marks[0];
  if (first === undefined || !marks.every((c) => c === first)) return false;
  if (first === "=")
    return runOf(trimEnd(content), "=") === trimEnd(content).length;
  return ["-", "*", "_"].includes(first) && marks.length >= 3;
}

/** `[label]: destination`. */
function isReference(content: string): boolean {
  if (!content.startsWith("[")) return false;
  const rest = content.slice(1);
  const close = rest.indexOf("]:");
  return (
    close > 0 &&
    !rest.slice(0, close).includes("]") &&
    /\S/u.test(rest.slice(close + 2))
  );
}

/** Followed by whitespace or the end of the line. */
function marker(line: string, prefix: string): string | undefined {
  if (!line.startsWith(prefix)) return undefined;
  const rest = line.slice(prefix.length);
  return rest === "" || isSpace(rest[0]) ? rest : undefined;
}

function listMarker(line: string): string | undefined {
  for (const m of ["-", "*", "+"]) {
    const rest = marker(line, m);
    if (rest !== undefined) return rest;
  }
  const digits = /^[0-9]*/u.exec(line)?.[0].length ?? 0;
  if (digits < 1 || digits > 9) return undefined;
  const rest = line.slice(digits);
  return marker(rest, ".") ?? marker(rest, ")");
}

/** Removes quote, heading, list and task markers, and a heading's closing `#` run. */
function stripBlocks(text: string): string {
  let line = text;
  for (;;) {
    line = trimStart(line);
    if (line.startsWith(">")) {
      line = line.slice(1);
      continue;
    }
    const hashes = runOf(line, "#");
    const heading =
      hashes >= 1 && hashes <= 6
        ? marker(line, line.slice(0, hashes))
        : undefined;
    if (heading !== undefined) {
      const rest = trimEnd(heading);
      const kept = rest.replace(/#+$/u, "");
      return kept === "" || isSpace(kept.at(-1)) ? kept : rest;
    }
    const item = listMarker(line);
    if (item !== undefined) {
      const rest = trimStart(item);
      line =
        marker(rest, "[ ]") ??
        marker(rest, "[x]") ??
        marker(rest, "[X]") ??
        rest;
      continue;
    }
    return line;
  }
}

function find(
  chars: string[],
  from: number,
  needle: string[],
): number | undefined {
  for (let at = from; at + needle.length <= chars.length; at++) {
    if (needle.every((c, i) => chars[at + i] === c)) return at;
  }
  return undefined;
}

function runAt(chars: string[], at: number, mark: string): number {
  let end = at;
  while (chars[end] === mark) end++;
  return end - at;
}

/** The start of the next run of exactly `length` backticks from `from`. */
function closingRun(
  chars: string[],
  from: number,
  length: number,
): number | undefined {
  let at = from;
  while (at < chars.length) {
    if (chars[at] !== "`") {
      at++;
      continue;
    }
    const run = runAt(chars, at, "`");
    if (run === length) return at;
    at += run;
  }
  return undefined;
}

/** A link or image whose `[` is at `open`: its text's end, and the index after it. */
function linkEnd(chars: string[], open: number): [number, number] | undefined {
  const close = find(chars, open + 1, ["]"]);
  if (close === undefined) return undefined;
  const closer = { "(": ")", "[": "]" }[chars[close + 1] ?? ""];
  if (closer === undefined) return undefined;
  const end = find(chars, close + 2, [closer]);
  return end === undefined ? undefined : [close, end + 1];
}

function autolinkEnd(chars: string[], open: number): number | undefined {
  let scheme = 0;
  while (SCHEME.test(chars[open + 1 + scheme] ?? "")) scheme++;
  if (scheme < 2 || scheme > 32 || !/^[A-Za-z]$/u.test(chars[open + 1] ?? ""))
    return undefined;
  if (chars[open + 1 + scheme] !== ":") return undefined;
  for (let at = open + 2 + scheme; at < chars.length; at++) {
    const c = chars[at];
    if (c === ">") return at;
    if (c === "<" || isSpace(c)) return undefined;
  }
  return undefined;
}

const word = (c: string | undefined) => c !== undefined && WORD.test(c);

/** Inline markup removed, by `device/item-preview-escape` to `device/item-preview-unclosed`. */
function inline(chars: string[], out: Plain): void {
  const pushAll = (from: number, to: number) => {
    for (let i = from; i < to; i++) out.push(chars[i] ?? "");
  };
  let at = 0;
  while (at < chars.length && !out.full()) {
    const c = chars[at] ?? "";
    const next = chars[at + 1];
    if (c === "\\" && next !== undefined && PUNCTUATION.test(next)) {
      out.push(next);
      at += 2;
    } else if (c === "`") {
      const length = runAt(chars, at, "`");
      const close = closingRun(chars, at + length, length);
      if (close === undefined) {
        pushAll(at, at + length);
        at += length;
      } else {
        pushAll(at + length, close);
        at = close + length;
      }
    } else if (c === "!" && next === "[" && chars[at + 2] === "[") {
      const end = find(chars, at + 3, ["]", "]"]);
      if (end === undefined) {
        out.push("!");
        at++;
      } else at = end + 2;
    } else if (c === "[" && next === "[") {
      const end = find(chars, at + 2, ["]", "]"]);
      if (end === undefined) {
        out.push("[");
        at++;
      } else {
        const bar = chars.slice(at + 2, end).indexOf("|");
        pushAll(bar === -1 ? at + 2 : at + 3 + bar, end);
        at = end + 2;
      }
    } else if (c === "!" && next === "[") {
      const link = linkEnd(chars, at + 1);
      if (link === undefined) {
        out.push("!");
        at++;
      } else at = link[1];
    } else if (c === "[") {
      const link = linkEnd(chars, at);
      if (link === undefined) {
        out.push("[");
        at++;
      } else {
        inline(chars.slice(at + 1, link[0]), out);
        at = link[1];
      }
    } else if (c === "<") {
      const close = autolinkEnd(chars, at);
      if (close === undefined) {
        out.push("<");
        at++;
      } else {
        pushAll(at + 1, close);
        at = close + 1;
      }
    } else if (c === "*" || c === "_" || c === "~") {
      const length = runAt(chars, at, c);
      const removed =
        length >= 2 ||
        (c !== "~" && word(chars[at - 1]) !== word(chars[at + 1]));
      if (!removed) pushAll(at, at + length);
      at += length;
    } else {
      out.push(c);
      at++;
    }
  }
}
