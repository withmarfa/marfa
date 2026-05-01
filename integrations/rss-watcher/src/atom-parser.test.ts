/**
 * Atom-parser unit tests. Pure-function tests — no SDK, no I/O.
 */
import { describe, it, expect } from "vitest";
import { parseAtomFeed } from "./atom-parser.js";

const MINIMAL_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Simon Willison's Weblog</title>
  <link rel="self" href="https://simonwillison.net/atom/everything/" />
  <id>https://simonwillison.net/atom/everything/</id>
  <updated>2026-04-30T10:00:00Z</updated>
  <entry>
    <id>https://simonwillison.net/2026/Apr/30/llm-update/</id>
    <title>LLM update for April 2026</title>
    <link rel="alternate" href="https://simonwillison.net/2026/Apr/30/llm-update/" />
    <updated>2026-04-30T10:00:00Z</updated>
    <published>2026-04-30T09:30:00Z</published>
    <author><name>Simon Willison</name></author>
    <summary>A short summary with &amp; ampersand and &lt;tags&gt; in it.</summary>
    <content type="html">&lt;p&gt;Body content with &amp;mdash; entities.&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>https://simonwillison.net/2026/Apr/29/another-post/</id>
    <title>Another post</title>
    <link href="https://simonwillison.net/2026/Apr/29/another-post/" />
    <updated>2026-04-29T16:00:00Z</updated>
    <author><name>Simon Willison</name></author>
    <summary>Just a summary.</summary>
  </entry>
</feed>`;

describe("parseAtomFeed", () => {
  it("extracts feed-level title and self-link", () => {
    const parsed = parseAtomFeed(MINIMAL_FEED);
    expect(parsed.feed_title).toBe("Simon Willison's Weblog");
    expect(parsed.feed_url).toBe("https://simonwillison.net/atom/everything/");
  });

  it("returns entries in feed order", () => {
    const parsed = parseAtomFeed(MINIMAL_FEED);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]!.id).toBe(
      "https://simonwillison.net/2026/Apr/30/llm-update/",
    );
    expect(parsed.entries[1]!.id).toBe(
      "https://simonwillison.net/2026/Apr/29/another-post/",
    );
  });

  it("prefers rel=alternate links over the first link", () => {
    const parsed = parseAtomFeed(MINIMAL_FEED);
    expect(parsed.entries[0]!.url).toBe(
      "https://simonwillison.net/2026/Apr/30/llm-update/",
    );
  });

  it("falls back to the first link when no rel=alternate is present", () => {
    const parsed = parseAtomFeed(MINIMAL_FEED);
    expect(parsed.entries[1]!.url).toBe(
      "https://simonwillison.net/2026/Apr/29/another-post/",
    );
  });

  it("decodes named and numeric entities in title fields", () => {
    const parsed = parseAtomFeed(MINIMAL_FEED);
    expect(parsed.entries[0]!.title).toBe("LLM update for April 2026");
  });

  it("extracts author name from atom:author/atom:name", () => {
    const parsed = parseAtomFeed(MINIMAL_FEED);
    expect(parsed.entries[0]!.author).toBe("Simon Willison");
  });

  it("preserves both updated and published timestamps when present", () => {
    const parsed = parseAtomFeed(MINIMAL_FEED);
    expect(parsed.entries[0]!.updated).toBe("2026-04-30T10:00:00Z");
    expect(parsed.entries[0]!.published).toBe("2026-04-30T09:30:00Z");
    expect(parsed.entries[1]!.updated).toBe("2026-04-29T16:00:00Z");
    expect(parsed.entries[1]!.published).toBe(null);
  });

  it("does not pick up entry titles as the feed title", () => {
    // Feed title is 'Simon Willison's Weblog', not 'LLM update for April 2026'
    const parsed = parseAtomFeed(MINIMAL_FEED);
    expect(parsed.feed_title).toBe("Simon Willison's Weblog");
  });

  it("throws on input that is not an Atom feed", () => {
    expect(() => parseAtomFeed("<rss><channel /></rss>")).toThrow(
      /atom parse failed/,
    );
  });

  it("preserves escaped angle brackets in type=text summary fields", () => {
    // Default <summary> with no type attribute is treated as plain text.
    // `&lt;tags&gt;` is what the author wrote and what should appear.
    const parsed = parseAtomFeed(MINIMAL_FEED);
    expect(parsed.entries[0]!.summary).toBe(
      "A short summary with & ampersand and <tags> in it.",
    );
  });

  it("strips HTML markup from type=html content fields", () => {
    // <content type="html"> carries escaped HTML — decode then strip
    // tags so the bookmark body is plain readable text. Entities not
    // in the standard set (e.g. &mdash;) are left alone for the
    // downstream renderer.
    const parsed = parseAtomFeed(MINIMAL_FEED);
    expect(parsed.entries[0]!.content).toBe(
      "Body content with &mdash; entities.",
    );
  });

  it("skips entries without an atom:id", () => {
    const broken = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Broken</title>
  <entry>
    <title>No id here</title>
    <link href="https://example.com/" />
  </entry>
  <entry>
    <id>good</id>
    <title>Has id</title>
    <link href="https://example.com/good" />
  </entry>
</feed>`;
    const parsed = parseAtomFeed(broken);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.id).toBe("good");
  });
});
