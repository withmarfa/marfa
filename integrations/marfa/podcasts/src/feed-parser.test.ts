import { describe, expect, it } from "vitest";
import {
  enclosuresIn,
  normalizeExplicit,
  parseDurationSeconds,
  parseEpisode,
  parseFeed,
  parseShow,
  selectEnclosure,
} from "./feed-parser.js";

/** Minimal well-formed feed, with `extra` spliced into the channel. */
function feedXml(items: string, extra = ""): string {
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:podcast="https://podcastindex.org/namespace/1.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>A Show</title>
    <link>https://example.com/show</link>
    <description>About the show.</description>
    <language>en-us</language>
    ${extra}
    ${items}
  </channel>
</rss>`;
}

const ITEM = `<item>
  <title>An Episode</title>
  <guid isPermaLink="false">ep-1</guid>
  <pubDate>Fri, 24 Jun 2022 20:58:21 +0000</pubDate>
  <enclosure url="https://cdn.example/ep1.mp3" type="audio/mpeg" length="12345"/>
  <itunes:duration>1800</itunes:duration>
</item>`;

describe("duration", () => {
  // Every one of these forms was read out of a live feed.
  it.each([
    ["00:28:34", 1714],
    ["2:51:12", 10272],
    ["28:34", 1714],
    ["2486", 2486],
    ["\n    <![CDATA[00:29:24]]>\n  ", 1764],
  ])("reads %j as %i seconds", (raw, expected) => {
    expect(parseDurationSeconds(raw)).toBe(expected);
  });

  it.each([[""], ["garbage"], ["-5"], ["1:2:3:4"], ["999999999"], ["0"]])(
    "declines to read %j",
    (raw) => {
      expect(parseDurationSeconds(raw)).toBeNull();
    },
  );
});

describe("explicit", () => {
  it.each([
    ["yes", "true"],
    ["Yes", "true"],
    ["true", "true"],
    ["no", "false"],
    ["No", "false"],
    ["false", "false"],
    ["clean", "clean"],
  ])("normalizes %j to %j", (raw, expected) => {
    expect(normalizeExplicit(raw)).toBe(expected);
  });

  it("keeps clean apart from false, because it claims more", () => {
    expect(normalizeExplicit("clean")).toBe("clean");
    expect(normalizeExplicit("no")).toBe("false");
  });
});

describe("enclosure selection", () => {
  // Feeds routinely attach artwork, transcripts and captions beside the
  // audio, so "the first enclosure" is the wrong answer.
  const many = `<item><title>E</title>
    <enclosure url="https://cdn/art.jpg" type="image/jpeg" length="1"/>
    <enclosure url="https://cdn/t.vtt" type="text/vtt" length="1"/>
    <enclosure url="https://cdn/ep.mp3" type="audio/mpeg" length="9"/>
    <enclosure url="https://cdn/t.srt" type="application/srt" length="1"/>
  </item>`;

  it("picks the audio one whatever its position", () => {
    expect(parseEpisode(many).enclosure?.url).toBe("https://cdn/ep.mp3");
  });

  it("picks the audio one when the order is reversed", () => {
    const reversed = many.split("\n").reverse().join("\n");
    expect(selectEnclosure(enclosuresIn(reversed))?.type).toBe("audio/mpeg");
  });

  it("never borrows the next item's enclosure", () => {
    const xml = feedXml(
      `<item><title>No media</title><guid>a</guid></item>` +
        `<item><title>Has media</title><guid>b</guid>` +
        `<enclosure url="https://cdn/b.mp3" type="audio/mpeg" length="1"/></item>`,
    );
    const feed = parseFeed(xml);
    expect(feed.episodes[0]?.enclosure).toBeNull();
    expect(feed.episodes[1]?.enclosure?.url).toBe("https://cdn/b.mp3");
  });

  it("prefers video when there is no audio", () => {
    const xml = `<item><title>V</title>
      <enclosure url="https://cdn/a.jpg" type="image/jpeg" length="1"/>
      <enclosure url="https://cdn/v.mp4" type="video/mp4" length="2"/></item>`;
    expect(parseEpisode(xml).enclosure?.type).toBe("video/mp4");
  });

  it("keeps a claimed length of zero rather than discarding the enclosure", () => {
    const xml = `<item><title>Z</title>
      <enclosure url="https://cdn/z.mp3" type="audio/mpeg" length="0"/></item>`;
    const e = parseEpisode(xml).enclosure;
    expect(e?.url).toBe("https://cdn/z.mp3");
    expect(e?.length).toBe(0);
  });
});

describe("channel", () => {
  it("reads the show title, not the artwork block's title", () => {
    // Every podcast feed carries <image> with its own <title>.
    const xml = feedXml(
      ITEM,
      `<image><url>https://cdn/art.png</url><title>Artwork Title</title><link>https://x</link></image>`,
    );
    expect(parseShow(xml).title).toBe("A Show");
  });

  it("takes iTunes artwork from the attribute, which has no text content", () => {
    const xml = feedXml(ITEM, `<itunes:image href="https://cdn/cover.jpg"/>`);
    expect(parseShow(xml).image_url).toBe("https://cdn/cover.jpg");
  });

  it("flattens nested categories", () => {
    const xml = feedXml(
      ITEM,
      `<itunes:category text="Technology"><itunes:category text="Gadgets"/></itunes:category>`,
    );
    expect(parseShow(xml).categories).toEqual(["Technology", "Gadgets"]);
  });

  it("reads a declared podcast:guid, lowercased", () => {
    const xml = feedXml(
      ITEM,
      `<podcast:guid>917393E3-1B1E-5CEF-ACE4-EDAA54E1F810</podcast:guid>`,
    );
    expect(parseShow(xml).podcast_guid).toBe(
      "917393e3-1b1e-5cef-ace4-edaa54e1f810",
    );
  });

  it("leaves the language exactly as the feed wrote it", () => {
    // en-us is data about the feed, not a mistake to correct.
    expect(parseShow(feedXml(ITEM)).language).toBe("en-us");
  });

  it("reads itunes:complete as an ended series", () => {
    expect(
      parseShow(feedXml(ITEM, `<itunes:complete>Yes</itunes:complete>`))
        .complete,
    ).toBe(true);
    expect(parseShow(feedXml(ITEM)).complete).toBeNull();
  });
});

describe("items", () => {
  it("defaults isPermaLink to true when the attribute is absent", () => {
    expect(
      parseEpisode(`<item><title>T</title><guid>abc</guid></item>`)
        .guid_is_permalink,
    ).toBe(true);
  });

  it("unwraps a CDATA guid", () => {
    const xml = `<item><title>T</title><guid isPermaLink="false"><![CDATA[479281e0-6e7b]]></guid></item>`;
    expect(parseEpisode(xml).guid).toBe("479281e0-6e7b");
  });

  it("keeps both duration forms", () => {
    const e = parseEpisode(
      `<item><title>T</title><itunes:duration>2:00</itunes:duration></item>`,
    );
    expect(e.duration_raw).toBe("2:00");
    expect(e.duration_seconds).toBe(120);
  });

  it("ignores elements that are commented out", () => {
    // LibriVox ships exactly this shape.
    const xml = `<item><title>T</title><!--<pubDate>Mon, 01 Jan 2001 00:00:00 +0000</pubDate>--></item>`;
    expect(parseEpisode(xml).pub_date).toBeNull();
  });

  it("skips an item with no title and counts it", () => {
    const feed = parseFeed(feedXml(`<item><guid>x</guid></item>` + ITEM));
    expect(feed.episodes).toHaveLength(1);
    expect(feed.skipped_unidentifiable).toBe(1);
  });

  it("keeps show notes as published and a plain-text description apart", () => {
    const xml = `<item><title>T</title>
      <description>Plain &amp; short</description>
      <content:encoded><![CDATA[<p>Rich <b>notes</b></p>]]></content:encoded></item>`;
    const e = parseEpisode(xml);
    expect(e.description).toBe("Plain & short");
    expect(e.content_encoded).toBe("<p>Rich <b>notes</b></p>");
  });

  it("survives a publication date carrying an alphabetic timezone", () => {
    const xml = `<item><title>T</title><pubDate>Sun, 16 Aug 2026 22:10:03 GMT</pubDate></item>`;
    const d = parseEpisode(xml).pub_date;
    expect(d).not.toBeNull();
    expect(String(d)).not.toContain("Invalid");
  });

  it("carries no explicitness field of its own onto the parsed shape when absent", () => {
    expect(parseEpisode(`<item><title>T</title></item>`).explicit).toBeNull();
  });
});

describe("whole feed", () => {
  it("keeps document order, newest first", () => {
    const xml = feedXml(
      `<item><title>Newest</title><guid>2</guid></item><item><title>Older</title><guid>1</guid></item>`,
    );
    expect(parseFeed(xml).episodes.map((e) => e.title)).toEqual([
      "Newest",
      "Older",
    ]);
  });

  it("reads a feed with no items at all", () => {
    const feed = parseFeed(feedXml(""));
    expect(feed.episodes).toHaveLength(0);
    expect(feed.show.title).toBe("A Show");
  });
});
