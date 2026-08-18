import { describe, expect, it } from "vitest";
import {
  canonicalFeedName,
  episodeLocalId,
  episodeSourceId,
  showScopeKey,
  showSourceId,
  stableEnclosureUrl,
  uuidV5,
} from "./identity.js";
import type { ParsedEpisode } from "./feed-parser.js";

const NAMESPACE = "ead4c236-bf58-58c6-a2c6-a6b28d128cb6";

function episode(over: Partial<ParsedEpisode> = {}): ParsedEpisode {
  return {
    title: "An Episode",
    guid: null,
    guid_is_permalink: null,
    link: null,
    description: null,
    content_encoded: null,
    pub_date: null,
    duration_raw: null,
    duration_seconds: null,
    season_number: null,
    episode_number: null,
    episode_type: null,
    explicit: null,
    author: null,
    image_url: null,
    enclosure: null,
    ...over,
  };
}

describe("show identity", () => {
  // Both values were read out of the live feeds that publish them. If the
  // derivation were wrong, a feed declaring a guid and one computing it
  // would disagree, and the same show would exist twice.
  it.each([
    [
      "mp3s.nashownotes.com/pc20rss.xml",
      "917393e3-1b1e-5cef-ace4-edaa54e1f810",
    ],
    [
      "feeds.transistor.fm/build-your-saas",
      "778116ac-6b1e-5ae2-b037-26a7ff2aee64",
    ],
  ])("reproduces the guid %s publishes", async (name, expected) => {
    expect(await uuidV5(name, NAMESPACE)).toBe(expected);
  });

  it("reaches one identifier from every spelling of the same address", async () => {
    const forms = [
      "https://feeds.transistor.fm/build-your-saas",
      "http://feeds.transistor.fm/build-your-saas",
      "feeds.transistor.fm/build-your-saas",
      "https://feeds.transistor.fm/build-your-saas/",
      "  https://feeds.transistor.fm/build-your-saas//  ",
    ];
    const keys = new Set(
      await Promise.all(forms.map((f) => showScopeKey(f, null))),
    );
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("778116ac-6b1e-5ae2-b037-26a7ff2aee64");
  });

  it("strips the scheme and trailing slashes, and nothing else", () => {
    expect(canonicalFeedName("https://a.example/b/c/")).toBe("a.example/b/c");
    expect(canonicalFeedName("a.example/b?x=1")).toBe("a.example/b?x=1");
  });

  it("prefers a declared guid over the computed one", async () => {
    const declared = await showScopeKey("https://a.example/feed", "ABC-123");
    expect(declared).toBe("abc-123");
  });

  it("falls back to computing when the declared value is blank", async () => {
    expect(await showScopeKey("https://a.example/feed", "   ")).toBe(
      await showScopeKey("https://a.example/feed", null),
    );
  });
});

describe("episode identity", () => {
  it("uses the guid when there is one", async () => {
    expect(await episodeLocalId(episode({ guid: "ep-1" }))).toBe("g:ep-1");
  });

  it("uses the guid regardless of isPermaLink, which says nothing about stability", async () => {
    const a = await episodeLocalId(
      episode({ guid: "x", guid_is_permalink: true }),
    );
    const b = await episodeLocalId(
      episode({ guid: "x", guid_is_permalink: false }),
    );
    expect(a).toBe(b);
  });

  it("falls back to the enclosure, ignoring the query", async () => {
    // Prefix analytics rewrite the query per request; keeping it would mint
    // a new identity on every poll.
    const first = await episodeLocalId(
      episode({
        enclosure: {
          url: "https://cdn/e.mp3?ref=a&t=1",
          type: "audio/mpeg",
          length: 1,
        },
      }),
    );
    const second = await episodeLocalId(
      episode({
        enclosure: {
          url: "https://cdn/e.mp3?ref=b&t=2",
          type: "audio/mpeg",
          length: 1,
        },
      }),
    );
    expect(first).toBe(second);
    expect(first).toBe("e:https://cdn/e.mp3");
  });

  it("falls back to a digest when there is neither", async () => {
    const id = await episodeLocalId(
      episode({ title: "Letter 1", pub_date: "2020-01-01T00:00:00.000Z" }),
    );
    expect(id).toMatch(/^h:[0-9a-f]{32}$/);
  });

  it("gives near-identical titles distinct identities", async () => {
    // A serialized audiobook names its parts almost the same.
    const a = await episodeLocalId(
      episode({ title: "Letter 1", episode_number: 1 }),
    );
    const b = await episodeLocalId(
      episode({ title: "Letter 2", episode_number: 2 }),
    );
    expect(a).not.toBe(b);
  });

  it("returns nothing when an item offers no identity at all", async () => {
    expect(await episodeLocalId(episode({ title: null }))).toBeNull();
  });

  it("strips a fragment as well as a query", () => {
    expect(stableEnclosureUrl("https://cdn/e.mp3#t=30")).toBe(
      "https://cdn/e.mp3",
    );
  });
});

describe("provenance keys", () => {
  it("scopes an episode by its show", () => {
    // Two feeds emitting the identical bare guid must not resolve to one
    // natural key and overwrite each other.
    expect(episodeSourceId("show-a", "g:1")).not.toBe(
      episodeSourceId("show-b", "g:1"),
    );
    expect(episodeSourceId("show-a", "g:1")).toBe("ep:show-a:g:1");
  });

  it("keys a show on its identity", () => {
    expect(showSourceId("abc")).toBe("show:abc");
  });
});
