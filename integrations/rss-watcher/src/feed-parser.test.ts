/**
 * Feed-parser unit tests. Pure-function tests — no SDK, no I/O.
 */
import { describe, it, expect } from "vitest";
import { parseFeed } from "./feed-parser.js";

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

describe("parseFeed — Atom 1.0", () => {
  it("extracts feed-level title and self-link", () => {
    const parsed = parseFeed(MINIMAL_FEED);
    expect(parsed.feed_title).toBe("Simon Willison's Weblog");
    expect(parsed.feed_url).toBe("https://simonwillison.net/atom/everything/");
  });

  it("returns entries in feed order", () => {
    const parsed = parseFeed(MINIMAL_FEED);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]!.id).toBe(
      "https://simonwillison.net/2026/Apr/30/llm-update/",
    );
    expect(parsed.entries[1]!.id).toBe(
      "https://simonwillison.net/2026/Apr/29/another-post/",
    );
  });

  it("prefers rel=alternate links over the first link", () => {
    const parsed = parseFeed(MINIMAL_FEED);
    expect(parsed.entries[0]!.url).toBe(
      "https://simonwillison.net/2026/Apr/30/llm-update/",
    );
  });

  it("falls back to the first link when no rel=alternate is present", () => {
    const parsed = parseFeed(MINIMAL_FEED);
    expect(parsed.entries[1]!.url).toBe(
      "https://simonwillison.net/2026/Apr/29/another-post/",
    );
  });

  it("decodes named and numeric entities in title fields", () => {
    const parsed = parseFeed(MINIMAL_FEED);
    expect(parsed.entries[0]!.title).toBe("LLM update for April 2026");
  });

  it("extracts author name from atom:author/atom:name", () => {
    const parsed = parseFeed(MINIMAL_FEED);
    expect(parsed.entries[0]!.author).toBe("Simon Willison");
  });

  it("preserves both updated and published timestamps when present", () => {
    const parsed = parseFeed(MINIMAL_FEED);
    expect(parsed.entries[0]!.updated).toBe("2026-04-30T10:00:00Z");
    expect(parsed.entries[0]!.published).toBe("2026-04-30T09:30:00Z");
    expect(parsed.entries[1]!.updated).toBe("2026-04-29T16:00:00Z");
    expect(parsed.entries[1]!.published).toBe(null);
  });

  it("does not pick up entry titles as the feed title", () => {
    // Feed title is 'Simon Willison's Weblog', not 'LLM update for April 2026'
    const parsed = parseFeed(MINIMAL_FEED);
    expect(parsed.feed_title).toBe("Simon Willison's Weblog");
  });

  it("preserves escaped angle brackets in type=text summary fields", () => {
    // Default <summary> with no type attribute is treated as plain text.
    // `&lt;tags&gt;` is what the author wrote and what should appear.
    const parsed = parseFeed(MINIMAL_FEED);
    expect(parsed.entries[0]!.summary).toBe(
      "A short summary with & ampersand and <tags> in it.",
    );
  });

  it("strips HTML markup from type=html content fields", () => {
    // <content type="html"> carries escaped HTML — decode then strip
    // tags so the bookmark body is plain readable text. Entities not
    // in the standard set (e.g. &mdash;) are left alone for the
    // downstream renderer.
    const parsed = parseFeed(MINIMAL_FEED);
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
    const parsed = parseFeed(broken);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.id).toBe("good");
  });
});

const MINIMAL_RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Newsroom</title>
    <link>https://example.com/</link>
    <atom:link rel="self" href="https://example.com/rss.xml" type="application/rss+xml" />
    <description>The channel description</description>
    <image>
      <title>Example Newsroom logo</title>
      <url>https://example.com/logo.png</url>
    </image>
    <item>
      <title>Second story</title>
      <link>https://example.com/second</link>
      <guid isPermaLink="false">tag:example.com,2026:2</guid>
      <pubDate>Thu, 30 Apr 2026 10:00:00 +0000</pubDate>
      <dc:creator>Ada Lovelace</dc:creator>
      <description><![CDATA[<p>Second &amp; latest.</p>]]></description>
      <content:encoded><![CDATA[<p>Full body of the second story.</p>]]></content:encoded>
    </item>
    <item>
      <title>First story</title>
      <link>https://example.com/first</link>
      <pubDate>Wed, 29 Apr 2026 09:30:00 +0000</pubDate>
      <author>newsroom@example.com</author>
      <description>Plain description with &amp; ampersand.</description>
    </item>
  </channel>
</rss>`;

describe("parseFeed — RSS 2.0", () => {
  it("extracts the channel title without picking up image or item titles", () => {
    const parsed = parseFeed(MINIMAL_RSS);
    expect(parsed.feed_title).toBe("Example Newsroom");
  });

  it("reads the feed URL from the Atom-namespaced self link", () => {
    const parsed = parseFeed(MINIMAL_RSS);
    expect(parsed.feed_url).toBe("https://example.com/rss.xml");
  });

  it("returns items in feed order with guid as the entry id", () => {
    const parsed = parseFeed(MINIMAL_RSS);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]!.id).toBe("tag:example.com,2026:2");
    expect(parsed.entries[0]!.title).toBe("Second story");
    expect(parsed.entries[0]!.url).toBe("https://example.com/second");
  });

  it("falls back to the link when an item carries no guid", () => {
    const parsed = parseFeed(MINIMAL_RSS);
    expect(parsed.entries[1]!.id).toBe("https://example.com/first");
  });

  it("normalizes RFC 822 pubDate onto both timestamp axes as ISO", () => {
    // The cursor compares timestamps as ISO strings, so an RFC 822 date
    // has to be converted at the parser boundary or dedupe misorders.
    const parsed = parseFeed(MINIMAL_RSS);
    expect(parsed.entries[0]!.published).toBe("2026-04-30T10:00:00.000Z");
    expect(parsed.entries[0]!.updated).toBe("2026-04-30T10:00:00.000Z");
  });

  it("unwraps CDATA and strips markup from description and content:encoded", () => {
    const parsed = parseFeed(MINIMAL_RSS);
    expect(parsed.entries[0]!.summary).toBe("Second & latest.");
    expect(parsed.entries[0]!.content).toBe("Full body of the second story.");
  });

  it("prefers dc:creator over the RSS author email", () => {
    const parsed = parseFeed(MINIMAL_RSS);
    expect(parsed.entries[0]!.author).toBe("Ada Lovelace");
    expect(parsed.entries[1]!.author).toBe("newsroom@example.com");
  });

  it("decodes entities in a plain description", () => {
    const parsed = parseFeed(MINIMAL_RSS);
    expect(parsed.entries[1]!.summary).toBe(
      "Plain description with & ampersand.",
    );
  });

  it("leaves content null when an item has no content:encoded", () => {
    const parsed = parseFeed(MINIMAL_RSS);
    expect(parsed.entries[1]!.content).toBeNull();
  });

  it("skips items with neither guid nor link", () => {
    const parsed = parseFeed(`<rss version="2.0"><channel>
  <title>Sparse</title>
  <item><title>No identity</title></item>
  <item><title>Has link</title><link>https://example.com/ok</link></item>
</channel></rss>`);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.id).toBe("https://example.com/ok");
  });
});

describe("parseFeed — dialect detection", () => {
  it("throws on input that is neither Atom nor RSS", () => {
    expect(() => parseFeed("<html><body>Not a feed</body></html>")).toThrow(
      /feed parse failed/,
    );
  });

  it("accepts a bare <channel> document as RSS", () => {
    const parsed = parseFeed(
      `<channel><title>Bare</title><item><link>https://example.com/x</link></item></channel>`,
    );
    expect(parsed.feed_title).toBe("Bare");
    expect(parsed.entries).toHaveLength(1);
  });
});
