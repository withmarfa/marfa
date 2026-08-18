/**
 * Podcast RSS parsing.
 *
 * Hand-rolled and dependency-free, like the feed parser in `rss-watcher`,
 * and for a reason that has grown sharper since: podcast feeds do not
 * paginate. One document carries every episode a show has published, and the
 * largest in ordinary circulation is close to eighteen megabytes across
 * nearly three thousand items. A general XML parser materializes that as an
 * object tree several times the size of the source, which does not fit the
 * memory a Worker is given. Scanning for item blocks and reading the twenty
 * or so fields that matter holds the source string, one item at a time, and
 * the output.
 *
 * This is extraction, not XML processing. It does not validate the grammar,
 * and it matches namespace prefixes literally — `itunes:`, `podcast:`,
 * `content:`, `dc:` — rather than resolving them from their declarations. A
 * feed binding those namespaces to different prefixes would come back with
 * empty fields rather than wrong ones; every feed observed in the wild uses
 * the conventional prefixes.
 *
 * Every function here is synchronous and pure, which is what keeps its tests
 * fast and free of a runtime harness. Anything needing a digest lives in
 * `identity.ts`.
 */

/** One `<enclosure>` on an item, as the feed declared it. */
export interface ParsedEnclosure {
  url: string;
  type: string | null;
  /** Bytes as claimed. Frequently wrong — whole feeds report 0. */
  length: number | null;
}

export interface ParsedEpisode {
  title: string | null;
  guid: string | null;
  guid_is_permalink: boolean | null;
  link: string | null;
  description: string | null;
  content_encoded: string | null;
  pub_date: string | null;
  duration_raw: string | null;
  duration_seconds: number | null;
  season_number: number | null;
  episode_number: number | null;
  episode_type: string | null;
  explicit: string | null;
  author: string | null;
  image_url: string | null;
  /** The audio or video enclosure, chosen from the item's own enclosures. */
  enclosure: ParsedEnclosure | null;
}

export interface ParsedShow {
  title: string | null;
  link: string | null;
  description: string | null;
  language: string | null;
  copyright: string | null;
  last_build_date: string | null;
  author: string | null;
  owner_name: string | null;
  image_url: string | null;
  categories: string[];
  itunes_type: string | null;
  complete: boolean | null;
  explicit: string | null;
  new_feed_url: string | null;
  podcast_guid: string | null;
}

export interface ParsedFeed {
  show: ParsedShow;
  episodes: ParsedEpisode[];
  /** Items skipped because nothing in them could serve as an identity. */
  skipped_unidentifiable: number;
}

/* ------------------------------------------------------------------ */
/* Text handling                                                       */
/* ------------------------------------------------------------------ */

const CDATA_RE = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

/** Strip a CDATA wrapper if the whole value is one. */
export function unwrapCdata(raw: string): string {
  const m = CDATA_RE.exec(raw);
  return m ? (m[1] ?? "") : raw;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the entity forms a feed actually uses: named, decimal, hex. */
export function decodeEntities(input: string): string {
  return input.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (whole, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named ?? whole;
    },
  );
}

/** Remove tags, for a value that should be plain text. */
export function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, "");
}

/**
 * CDATA off, entities decoded, whitespace trimmed. Empty becomes null so
 * every caller can treat "absent" and "present but blank" the same way —
 * a feed writing `<itunes:author></itunes:author>` means the same as
 * omitting it.
 */
function clean(raw: string | null): string | null {
  if (raw === null) return null;
  const value = decodeEntities(unwrapCdata(raw)).trim();
  return value === "" ? null : value;
}

/** Comments are stripped before matching: feeds ship commented-out elements. */
function withoutComments(xml: string): string {
  return xml.replace(COMMENT_RE, "");
}

/* ------------------------------------------------------------------ */
/* Element and attribute reading                                       */
/* ------------------------------------------------------------------ */

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Text content of the first `<name>...</name>`, cleaned. */
function tagText(xml: string, name: string): string | null {
  const re = new RegExp(
    `<${escapeName(name)}\\b[^>]*>([\\s\\S]*?)</${escapeName(name)}>`,
    "i",
  );
  const m = re.exec(xml);
  return m ? clean(m[1] ?? "") : null;
}

/** Same, but without stripping inner markup — for HTML-bearing elements. */
function tagRichText(xml: string, name: string): string | null {
  const re = new RegExp(
    `<${escapeName(name)}\\b[^>]*>([\\s\\S]*?)</${escapeName(name)}>`,
    "i",
  );
  const m = re.exec(xml);
  if (!m) return null;
  const inner = unwrapCdata(m[1] ?? "").trim();
  return inner === "" ? null : inner;
}

/** Plain-text form: markup removed, then cleaned. */
function tagPlainText(xml: string, name: string): string | null {
  const rich = tagRichText(xml, name);
  if (rich === null) return null;
  const text = decodeEntities(stripTags(rich)).replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

/** One attribute off the first matching element, open or self-closing. */
function tagAttr(xml: string, name: string, attr: string): string | null {
  const re = new RegExp(`<${escapeName(name)}\\b([^>]*)>`, "i");
  const m = re.exec(xml);
  if (!m) return null;
  return attrFrom(m[1] ?? "", attr);
}

/** Read one attribute out of a tag's attribute text. Order is not stable, quoting varies. */
function attrFrom(attrs: string, attr: string): string | null {
  const re = new RegExp(
    `\\b${escapeName(attr)}\\s*=\\s*("([^"]*)"|'([^']*)')`,
    "i",
  );
  const m = re.exec(attrs);
  if (!m) return null;
  const raw = m[2] ?? m[3] ?? "";
  return clean(raw);
}

/* ------------------------------------------------------------------ */
/* Duration                                                            */
/* ------------------------------------------------------------------ */

/** Longest runtime accepted, in seconds. Above this the value is a parse error, not a podcast. */
const MAX_DURATION_SECONDS = 48 * 60 * 60;

/**
 * `itunes:duration` in every form feeds actually use: plain seconds,
 * `MM:SS`, and `HH:MM:SS` with or without a leading zero. Segments are
 * parsed as numbers rather than sliced by position, because `2:51:12` is as
 * common as `02:51:12`.
 */
export function parseDurationSeconds(raw: string | null): number | null {
  if (raw === null) return null;
  const value = decodeEntities(unwrapCdata(raw)).trim();
  if (value === "") return null;

  const parts = value.split(":");
  if (parts.length > 3) return null;

  let seconds = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    seconds = seconds * 60 + Number.parseFloat(trimmed);
  }

  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds > MAX_DURATION_SECONDS) return null;
  return Math.round(seconds);
}

/* ------------------------------------------------------------------ */
/* Small normalizers                                                   */
/* ------------------------------------------------------------------ */

/**
 * `itunes:explicit` reaches us as yes, no, true, false, clean, and every
 * casing of those. `clean` is kept apart from `false`: it asserts the
 * absence of explicit content rather than declining to claim anything.
 */
export function normalizeExplicit(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  if (value === "yes" || value === "true") return "true";
  if (value === "no" || value === "false") return "false";
  if (value === "clean") return "clean";
  return null;
}

/** RFC 822 as feeds write it, to ISO. Alphabetic timezones appear in the wild. */
export function toIsoTimestamp(raw: string | null): string | null {
  const value = clean(raw);
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function toInteger(raw: string | null): number | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!/^-?\d+$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* Enclosure selection                                                 */
/* ------------------------------------------------------------------ */

const ENCLOSURE_RE = /<enclosure\b([^>]*)\/?>/gi;

/**
 * Every `<enclosure>` inside one item. Modern feeds attach artwork,
 * transcripts and captions alongside the media, so an item routinely
 * carries five, and scanning the whole document instead of the item would
 * hand one episode another's audio.
 */
export function enclosuresIn(itemXml: string): ParsedEnclosure[] {
  const out: ParsedEnclosure[] = [];
  for (const m of itemXml.matchAll(ENCLOSURE_RE)) {
    const attrs = m[1] ?? "";
    const url = attrFrom(attrs, "url");
    if (url === null) continue;
    out.push({
      url,
      type: attrFrom(attrs, "type"),
      length: toInteger(attrFrom(attrs, "length")),
    });
  }
  return out;
}

/**
 * The one an episode is. Audio wins, then video, then anything with an
 * address — a feed with a single untyped enclosure is still an episode, and
 * the medium is simply left unstated rather than guessed.
 */
export function selectEnclosure(
  list: ParsedEnclosure[],
): ParsedEnclosure | null {
  return (
    list.find((e) => (e.type ?? "").toLowerCase().startsWith("audio/")) ??
    list.find((e) => (e.type ?? "").toLowerCase().startsWith("video/")) ??
    list[0] ??
    null
  );
}

/* ------------------------------------------------------------------ */
/* Channel                                                             */
/* ------------------------------------------------------------------ */

const ITEM_OPEN_RE = /<item[\s>]/i;
const CATEGORY_RE = /<itunes:category\b([^>]*)>/gi;

/**
 * The channel's own elements, read from the slice before the first item.
 *
 * Two reasons for the slice rather than a whole-document strip. It bounds
 * the work on a document that may be tens of megabytes, and it removes the
 * `<image><title>` trap without any special handling: every podcast feed
 * carries a channel `<image>` block with its own `<title>`, and a document
 * search for the channel title finds that one about as often as the show's.
 */
export function parseShow(xml: string): ParsedShow {
  const itemAt = ITEM_OPEN_RE.exec(xml);
  const headerRaw = itemAt ? xml.slice(0, itemAt.index) : xml;
  const header = withoutComments(headerRaw);

  // The <image> block carries a competing <title> and <link>, so the show's
  // own elements are read from the header with that block removed.
  const withoutImage = header.replace(/<image\b[\s\S]*?<\/image>/gi, "");

  const categories: string[] = [];
  for (const m of header.matchAll(CATEGORY_RE)) {
    const text = attrFrom(m[1] ?? "", "text");
    if (text !== null && !categories.includes(text)) categories.push(text);
  }

  const complete = tagText(header, "itunes:complete");

  return {
    title: tagPlainText(withoutImage, "title"),
    link: tagText(withoutImage, "link"),
    description:
      tagPlainText(header, "itunes:summary") ??
      tagPlainText(withoutImage, "description") ??
      tagPlainText(header, "itunes:subtitle"),
    language: tagText(withoutImage, "language"),
    copyright: tagText(header, "copyright"),
    last_build_date: toIsoTimestamp(tagText(header, "lastBuildDate")),
    author:
      tagPlainText(header, "itunes:author") ??
      tagText(header, "managingEditor"),
    owner_name: tagPlainText(header, "itunes:name"),
    image_url:
      tagAttr(header, "itunes:image", "href") ?? tagText(header, "url"),
    categories,
    itunes_type: (tagText(header, "itunes:type") ?? "").toLowerCase() || null,
    complete: complete === null ? null : /^(yes|true)$/i.test(complete),
    explicit: normalizeExplicit(tagText(header, "itunes:explicit")),
    new_feed_url: tagText(header, "itunes:new-feed-url"),
    podcast_guid: (tagText(header, "podcast:guid") ?? "").toLowerCase() || null,
  };
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

const ITEM_BLOCK_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;

/** One `<item>`. Comments are stripped first; feeds ship commented-out elements. */
export function parseEpisode(itemXmlRaw: string): ParsedEpisode {
  const xml = withoutComments(itemXmlRaw);

  const guidRaw = /<guid\b([^>]*)>([\s\S]*?)<\/guid>/i.exec(xml);
  const guidAttrs = guidRaw ? (guidRaw[1] ?? "") : "";
  const permalink = guidRaw ? attrFrom(guidAttrs, "isPermaLink") : null;

  const durationRaw = tagText(xml, "itunes:duration");

  return {
    title: tagPlainText(xml, "title") ?? tagPlainText(xml, "itunes:title"),
    guid: guidRaw ? clean(guidRaw[2] ?? "") : null,
    // Absent defaults to true per RSS 2.0. Recorded as the feed meant it,
    // not acted on: it says whether the value can be dereferenced, which is
    // a different question from whether it is stable.
    guid_is_permalink: guidRaw
      ? permalink === null
        ? true
        : /^true$/i.test(permalink)
      : null,
    link: tagText(xml, "link"),
    description:
      tagPlainText(xml, "itunes:summary") ?? tagPlainText(xml, "description"),
    content_encoded:
      tagRichText(xml, "content:encoded") ?? tagRichText(xml, "description"),
    pub_date: toIsoTimestamp(tagText(xml, "pubDate")),
    duration_raw: durationRaw,
    duration_seconds: parseDurationSeconds(durationRaw),
    season_number: toInteger(tagText(xml, "itunes:season")),
    episode_number: toInteger(tagText(xml, "itunes:episode")),
    episode_type:
      (tagText(xml, "itunes:episodeType") ?? "").toLowerCase() || null,
    explicit: normalizeExplicit(tagText(xml, "itunes:explicit")),
    author:
      tagPlainText(xml, "itunes:author") ?? tagPlainText(xml, "dc:creator"),
    image_url: tagAttr(xml, "itunes:image", "href"),
    enclosure: selectEnclosure(enclosuresIn(xml)),
  };
}

/**
 * A whole feed. Items keep the order the document gave them, which is
 * newest first by convention; the caller reverses before writing so that
 * progress through a back catalogue runs oldest to newest.
 *
 * An item with no title is dropped: title is the one field required on
 * every type this writes, and an untitled row cannot be told from another
 * in any list a person will ever see.
 */
export function parseFeed(xml: string): ParsedFeed {
  const show = parseShow(xml);
  const episodes: ParsedEpisode[] = [];
  let skipped = 0;

  for (const m of xml.matchAll(ITEM_BLOCK_RE)) {
    const episode = parseEpisode(m[1] ?? "");
    if (episode.title === null) {
      skipped += 1;
      continue;
    }
    episodes.push(episode);
  }

  return { show, episodes, skipped_unidentifiable: skipped };
}
