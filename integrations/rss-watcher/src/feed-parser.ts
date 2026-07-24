/**
 * Minimal Atom 1.0 + RSS 2.0 feed parser.
 *
 * Hand-rolled to avoid pulling an XML dependency into the Worker
 * bundle. Handles well-formed feeds of either dialect: Atom's
 * `<feed><entry>` shape and RSS's `<rss><channel><item>` shape both
 * normalize onto the same `FeedEntry`, so the handler never branches on
 * dialect. RSS is the format most publishers still emit, so supporting
 * only Atom would leave the majority of feeds a user might configure
 * throwing on the first tick.
 *
 * The parser is regex-based and does not validate the full XML
 * grammar — it extracts the fields a `core.bookmark` cares about
 * and ignores the rest. Callers should treat unknown / missing
 * fields as null rather than expecting strict shape.
 */

export interface FeedEntry {
  /** Stable per-entry identity: Atom's `atom:id`, RSS's `guid` (or its
   *  `link` when the item carries no guid). Entries without one are
   *  skipped — there is no way to dedupe them across ticks. */
  id: string;
  /** Entry title (may contain HTML; tags are stripped). */
  title: string;
  /** Atom: `link[@rel="alternate"]/@href`, or the first usable link.
   *  RSS: the `<link>` element text. */
  url: string | null;
  /** ISO 8601 timestamp the entry was last modified. Atom uses
   *  `atom:updated`; RSS has no distinct modified field, so `pubDate`
   *  serves as both. */
  updated: string | null;
  /** Original publication timestamp, if the dialect carries one. */
  published: string | null;
  /** Short-form entry text (plaintext after tag-stripping), or null. */
  summary: string | null;
  /** Long-form entry text (plaintext after tag-stripping), or null. */
  content: string | null;
  /** Author name, or null. */
  author: string | null;
}

export interface ParsedFeed {
  /** Feed-level title. */
  feed_title: string | null;
  /** Self-link from `link[@rel="self"]/@href`, or null. RSS feeds carry
   *  it only when they include the Atom namespace, which is common but
   *  not required. */
  feed_url: string | null;
  /** Entries in feed order (typically newest-first). */
  entries: FeedEntry[];
}

const ATOM_ROOT_RE = /<(?:[A-Za-z][\w.-]*:)?feed\b/;
const RSS_ROOT_RE = /<(?:[A-Za-z][\w.-]*:)?(?:rss|channel)\b/;

const ENTRY_RE = /<entry\b[\s\S]*?<\/entry>/g;
const ITEM_RE = /<item\b[\s\S]*?<\/item>/g;
const IMAGE_RE = /<image\b[\s\S]*?<\/image>/g;

const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/;

const ENTRY_ID_RE = /<id\b[^>]*>([\s\S]*?)<\/id>/;
const ENTRY_UPDATED_RE = /<updated\b[^>]*>([\s\S]*?)<\/updated>/;
const ENTRY_PUBLISHED_RE = /<published\b[^>]*>([\s\S]*?)<\/published>/;
// Capture the type= attribute (if any) and the inner text in two
// groups, so we can apply HTML-style decode-then-strip when the
// content is type="html" and plain decode-only for type="text".
const ENTRY_SUMMARY_RE = /<summary\b([^>]*)>([\s\S]*?)<\/summary>/;
const ENTRY_CONTENT_RE = /<content\b([^>]*)>([\s\S]*?)<\/content>/;
const ENTRY_AUTHOR_RE =
  /<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/;

const ITEM_GUID_RE = /<guid\b[^>]*>([\s\S]*?)<\/guid>/;
const ITEM_LINK_RE = /<link\b[^>]*>([\s\S]*?)<\/link>/;
const ITEM_PUBDATE_RE = /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/;
const ITEM_DESCRIPTION_RE = /<description\b[^>]*>([\s\S]*?)<\/description>/;
const ITEM_CONTENT_ENCODED_RE =
  /<content:encoded\b[^>]*>([\s\S]*?)<\/content:encoded>/;
const ITEM_CREATOR_RE = /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/;
const ITEM_AUTHOR_RE = /<author\b[^>]*>([\s\S]*?)<\/author>/;

/** Self-closing or opening `<link>` tag, with an optional namespace
 *  prefix so RSS feeds' `<atom:link rel="self">` is reachable too. */
const LINK_TAG_RE = /<(?:[A-Za-z][\w.-]*:)?link\b([^>]*?)\/?>/g;

export function parseFeed(xml: string): ParsedFeed {
  if (ATOM_ROOT_RE.test(xml)) return parseAtom(xml);
  if (RSS_ROOT_RE.test(xml)) return parseRss(xml);
  throw new Error(
    "feed parse failed: input is neither an Atom feed (<feed>) nor an RSS channel (<rss>)",
  );
}

function parseAtom(xml: string): ParsedFeed {
  // Strip <entry>...</entry> blocks from the feed-header view so the
  // feed-title regex doesn't pick up the first entry's title.
  const headerView = xml.replace(ENTRY_RE, "");
  const feed_title = matchTrimmedDecoded(headerView, TITLE_RE);
  const feed_url = findSelfLinkHref(headerView);

  const entries: FeedEntry[] = [];
  for (const m of xml.matchAll(ENTRY_RE)) {
    const entryXml = m[0];
    const id = matchRaw(entryXml, ENTRY_ID_RE)?.trim() ?? null;
    if (id === null) continue;
    entries.push({
      id,
      title: matchTrimmedDecoded(entryXml, TITLE_RE) ?? "",
      url: findEntryLinkHref(entryXml),
      updated: matchRaw(entryXml, ENTRY_UPDATED_RE)?.trim() ?? null,
      published: matchRaw(entryXml, ENTRY_PUBLISHED_RE)?.trim() ?? null,
      summary: matchTypedContent(entryXml, ENTRY_SUMMARY_RE),
      content: matchTypedContent(entryXml, ENTRY_CONTENT_RE),
      author: matchTrimmedDecoded(entryXml, ENTRY_AUTHOR_RE),
    });
  }

  return { feed_title, feed_url, entries };
}

function parseRss(xml: string): ParsedFeed {
  // `<image>` carries its own `<title>`, so it has to leave the header
  // view alongside the items before the channel title is read.
  const headerView = xml.replace(ITEM_RE, "").replace(IMAGE_RE, "");
  const feed_title = matchTrimmedDecoded(headerView, TITLE_RE);
  // The channel's own `<link>` points at the site, not the feed, so the
  // only trustworthy feed URL is an Atom-namespaced self link.
  const feed_url = findSelfLinkHref(headerView);

  const entries: FeedEntry[] = [];
  for (const m of xml.matchAll(ITEM_RE)) {
    const itemXml = m[0];
    const link = matchTrimmedDecoded(itemXml, ITEM_LINK_RE);
    const guid = matchTrimmedDecoded(itemXml, ITEM_GUID_RE);
    // guid is optional in RSS 2.0; the link is the conventional
    // stand-in, and an item with neither cannot be deduped at all.
    const id = guid !== null && guid !== "" ? guid : link;
    if (id === null || id === "") continue;
    // RSS has no modified timestamp — pubDate is the only date an item
    // carries, so it stands in for both axes.
    const published = toIsoTimestamp(matchRaw(itemXml, ITEM_PUBDATE_RE));
    entries.push({
      id,
      title: matchTrimmedDecoded(itemXml, TITLE_RE) ?? "",
      url: link,
      updated: published,
      published,
      summary: matchTrimmedDecoded(itemXml, ITEM_DESCRIPTION_RE),
      content: matchTrimmedDecoded(itemXml, ITEM_CONTENT_ENCODED_RE),
      // dc:creator carries a name; RSS's own <author> is an email
      // address, so it is only the fallback.
      author:
        matchTrimmedDecoded(itemXml, ITEM_CREATOR_RE) ??
        matchTrimmedDecoded(itemXml, ITEM_AUTHOR_RE),
    });
  }

  return { feed_title, feed_url, entries };
}

/**
 * RSS dates are RFC 822 ("Mon, 06 Sep 2026 00:01:00 +0000"), which the
 * cursor's ISO-8601 comparisons can't order. Normalize at the parser
 * boundary so every entry timestamp downstream is ISO regardless of
 * dialect.
 */
function toIsoTimestamp(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = unwrapCdata(raw).trim();
  if (trimmed === "") return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function findSelfLinkHref(xml: string): string | null {
  for (const m of xml.matchAll(LINK_TAG_RE)) {
    const attrs = m[1] ?? "";
    if (!/\brel="self"/.test(attrs)) continue;
    const href = /\bhref="([^"]*)"/.exec(attrs)?.[1];
    if (href !== undefined && href.length > 0) return href;
  }
  return null;
}

/**
 * Atom entry link. `rel="alternate"` is the canonical human-readable
 * target; anything else with an href is a fallback, minus the rels that
 * deliberately point somewhere other than the entry itself.
 */
function findEntryLinkHref(entryXml: string): string | null {
  let fallback: string | null = null;
  for (const m of entryXml.matchAll(LINK_TAG_RE)) {
    const attrs = m[1] ?? "";
    const href = /\bhref="([^"]*)"/.exec(attrs)?.[1];
    if (href === undefined || href.length === 0) continue;
    if (/\brel="alternate"/.test(attrs)) return href;
    if (/\brel="(?:self|edit|replies|enclosure|via)"/.test(attrs)) continue;
    fallback ??= href;
  }
  return fallback;
}

function matchRaw(input: string, re: RegExp): string | null {
  return input.match(re)?.[1] ?? null;
}

function matchTrimmedDecoded(input: string, re: RegExp): string | null {
  const raw = matchRaw(input, re);
  if (raw === null) return null;
  return decodeEntities(stripTags(unwrapCdata(raw))).trim();
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
  const inner = unwrapCdata(m[2] ?? "");
  const isHtml = /\btype="html"/.test(attrs);
  if (isHtml) {
    return decodeEntities(inner)
      .replace(/<[^>]+>/g, "")
      .trim();
  }
  return decodeEntities(stripTags(inner)).trim();
}

/**
 * CDATA sections are how RSS publishers routinely ship HTML bodies. The
 * wrapper is XML syntax, never content, so it comes off before any
 * entity decoding or tag stripping.
 */
function unwrapCdata(input: string): string {
  return input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
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
