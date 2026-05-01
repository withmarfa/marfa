/**
 * Minimal Atom 1.0 feed parser.
 *
 * Hand-rolled to avoid pulling an XML dependency into the Worker
 * bundle. Handles well-formed Atom 1.0 feeds (the shape Simon
 * Willison's `/atom/everything/` and most static-site generators
 * emit). Does not attempt to handle RSS 2.0 — if a Layer-3 user
 * points the connector at an RSS 2.0 feed, parsing throws and the
 * handler surfaces the error as `system.activity` severity
 * `action_required`. Adding RSS 2.0 support is one extra parse
 * branch the day we need it.
 *
 * The parser is regex-based and does not validate the full XML
 * grammar — it extracts the fields a `core.bookmark` cares about
 * and ignores the rest. Callers should treat unknown / missing
 * fields as null rather than expecting strict shape.
 */

export interface AtomEntry {
  /** The atom:id field — globally unique per entry per the spec. */
  id: string;
  /** atom:title (may contain HTML; we strip tags for the bookmark
   *  title). */
  title: string;
  /** atom:link[@rel="alternate"]/@href, or the first link if no
   *  rel is present. */
  url: string | null;
  /** atom:updated — ISO 8601 timestamp the entry was last modified.
   *  Falls back to atom:published if updated is absent. */
  updated: string | null;
  /** atom:published — original publication timestamp, if present. */
  published: string | null;
  /** atom:summary content (plaintext after tag-stripping), or null. */
  summary: string | null;
  /** atom:content content (plaintext after tag-stripping), or null. */
  content: string | null;
  /** atom:author/atom:name, or null. */
  author: string | null;
}

export interface ParsedAtomFeed {
  /** atom:title at the feed level. */
  feed_title: string | null;
  /** Self-link from atom:link[@rel="self"]/@href, or null. */
  feed_url: string | null;
  /** Entries in feed order (typically newest-first). */
  entries: AtomEntry[];
}

const ENTRY_RE = /<entry\b[\s\S]*?<\/entry>/g;
const FEED_TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/;
const FEED_LINK_RE = /<link\b[^>]*\srel="self"[^>]*\shref="([^"]+)"/;

const ENTRY_ID_RE = /<id\b[^>]*>([\s\S]*?)<\/id>/;
const ENTRY_TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/;
const ENTRY_UPDATED_RE = /<updated\b[^>]*>([\s\S]*?)<\/updated>/;
const ENTRY_PUBLISHED_RE = /<published\b[^>]*>([\s\S]*?)<\/published>/;
// Capture the type= attribute (if any) and the inner text in two
// groups, so we can apply HTML-style decode-then-strip when the
// content is type="html" and plain decode-only for type="text".
const ENTRY_SUMMARY_RE = /<summary\b([^>]*)>([\s\S]*?)<\/summary>/;
const ENTRY_CONTENT_RE = /<content\b([^>]*)>([\s\S]*?)<\/content>/;
const ENTRY_AUTHOR_RE =
  /<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/;
const ENTRY_LINK_ALT_RE = /<link\b[^>]*\srel="alternate"[^>]*\shref="([^"]+)"/;
const ENTRY_LINK_FIRST_RE = /<link\b[^>]*\shref="([^"]+)"/;

export function parseAtomFeed(xml: string): ParsedAtomFeed {
  if (!xml.includes("<feed")) {
    throw new Error(
      "atom parse failed: input does not look like an Atom feed (no <feed> element)",
    );
  }

  // Strip <entry>...</entry> blocks from the feed-header view so the
  // feed-title regex doesn't pick up the first entry's title.
  const headerView = xml.replace(ENTRY_RE, "");
  const feed_title = matchTrimmedDecoded(headerView, FEED_TITLE_RE);
  const feed_url = matchRaw(headerView, FEED_LINK_RE);

  const entries: AtomEntry[] = [];
  const entryMatches = xml.matchAll(ENTRY_RE);
  for (const m of entryMatches) {
    const entryXml = m[0];
    const id = matchRaw(entryXml, ENTRY_ID_RE)?.trim() ?? null;
    if (id === null) continue;
    const title = matchTrimmedDecoded(entryXml, ENTRY_TITLE_RE) ?? "";
    const updated = matchRaw(entryXml, ENTRY_UPDATED_RE)?.trim() ?? null;
    const published = matchRaw(entryXml, ENTRY_PUBLISHED_RE)?.trim() ?? null;
    const summary = matchTypedContent(entryXml, ENTRY_SUMMARY_RE);
    const content = matchTypedContent(entryXml, ENTRY_CONTENT_RE);
    const author = matchTrimmedDecoded(entryXml, ENTRY_AUTHOR_RE);
    const url =
      matchRaw(entryXml, ENTRY_LINK_ALT_RE) ??
      matchRaw(entryXml, ENTRY_LINK_FIRST_RE);
    entries.push({
      id,
      title,
      url,
      updated,
      published,
      summary,
      content,
      author,
    });
  }

  return { feed_title, feed_url, entries };
}

function matchRaw(input: string, re: RegExp): string | null {
  return input.match(re)?.[1] ?? null;
}

function matchTrimmedDecoded(input: string, re: RegExp): string | null {
  const raw = matchRaw(input, re);
  if (raw === null) return null;
  return decodeEntities(stripTags(raw)).trim();
}

/**
 * Atom <summary> / <content> can carry either plain text (default
 * `type="text"`) or HTML-escaped markup (`type="html"`). Plain text
 * may legitimately contain `<` / `>` characters expressed as `&lt;` /
 * `&gt;` — we want them in the output. HTML content has its markup
 * escaped — we want the markup decoded and then the resulting tags
 * stripped to leave plain readable text for the bookmark body.
 *
 * The distinction is the type attribute on the enclosing element.
 */
function matchTypedContent(input: string, re: RegExp): string | null {
  const m = input.match(re);
  if (!m) return null;
  const attrs = m[1] ?? "";
  const inner = m[2] ?? "";
  const isHtml = /\btype="html"/.test(attrs);
  if (isHtml) {
    return decodeEntities(inner)
      .replace(/<[^>]+>/g, "")
      .trim();
  }
  return decodeEntities(stripTags(inner)).trim();
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, "");
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

function decodeEntities(input: string): string {
  return input
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code as string, 10)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code as string, 16)),
    );
}
