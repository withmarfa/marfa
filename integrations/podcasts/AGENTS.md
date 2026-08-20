# Podcasts

Scheduled poll of podcast RSS feeds. One connection holds many subscriptions; each tick takes a few in rotation and writes a show and its episodes, joined by `in-collection` edges.

Read-only. A feed is a document a publisher serves, so there is nothing to write back to: no item-event trigger.

Distinct from `rss-watcher`, which turns any feed into `core.bookmark`. That one stays as it is.

## Two write families

`target_types` names four types and a connection picks a family with `write_family`.

- **`podcast`** (the default) writes `marfa.podcast.show` and `marfa.podcast.episode`, which keep everything a feed carries.
- **`core`** writes `core.media.series` and `core.media.episode`, which any app understanding core media can read.

Core mode is lossy and the loss is deliberate: the enclosure's MIME type and claimed size, the raw duration string, explicitness, categories and episode type have no home on the core types and are dropped. `media_url` and `mime_type` exist on `core.media.episode` because this integration needed them; before that a core episode had nowhere to put its audio.

The families are declared on the manifest itself (`write_families`), so the platform validates centrally that each family's pair appears in `target_types` and the `write_family` chooser derives its options from the declared families (`from_write_families`). The per-manifest pairing test this file used to describe stood in for that schema feature and is retired.

## The upstream is not an API

**Feeds do not paginate.** One document carries every episode a show has published. The largest in ordinary circulation is close to eighteen megabytes across nearly three thousand items, and there is no `since` parameter, no cursor, and no partial fetch. Whatever a poll costs, it costs in full.

Measured against the largest of them: 17.6 MB of characters, which is 35 MB held as a string, parsed in 98 ms into all 2,951 episodes for 11 MB of output, peaking at 19.5 MB of heap against a 128 MB ceiling. That is the headroom the shape below buys.

That is why the parser is hand-rolled rather than a dependency. A general XML parser materializes the whole document as an object tree several times the size of the source, which does not fit the memory a Worker gets; scanning for item blocks holds the source, one item, and the output. It is also why nothing does a whole-document `.replace()` — that allocates a second copy of an eighteen-megabyte string. The channel is read from a slice taken before the first `<item`.

**Conditional requests are the whole efficiency story.** Every host tested honors `If-None-Match`, and all but one honor `If-Modified-Since`. A steady-state tick over thirty feeds should be a few kilobytes of headers rather than hundreds of megabytes of XML. The ETag is echoed back verbatim, weak `W/` prefix included, because two hosts send weak tags. `<lastBuildDate>` is deliberately not used as a substitute: some hosts omit it, some regenerate it on every render, and one emits an alphabetic timezone that many date parsers mishandle.

**Some feeds are truncated and none of them say so.** One show with over a thousand episodes publishes a ten-item feed. Nothing in the document distinguishes that from a show with ten episodes, and no heuristic recovers it — episode-number gaps are unreliable and plenty of feeds carry no `itunes:episode` at all. This is the gap Podcast Index would fill.

## Identity

**A feed address is not an identity.** Shows move hosts. If the address were the key, one subscription would become two the day a publisher switched provider.

A show is keyed on `podcast_guid`: the value the channel declares, or, where it declares none, the same value computed as Podcasting 2.0 defines it — a UUIDv5 over the address with the scheme and any trailing slash removed, under a fixed namespace. A feed that later adds a conformant guid therefore lands on the value already stored. Verified against the two sampled feeds that publish one; both reproduce exactly.

Most feeds declare nothing. Of fourteen sampled, three did, and none of the mainstream hosts were among them.

**The show's identity is written once and never recomputed.** It is read from the cursor, not derived per tick. Recomputing would re-key every stored episode the moment an address changed. The consequence to know: for a feed with no declared guid, re-pointing the subscription to a new address does start a second show. The alternative was silently rewriting a catalogue, which is worse.

Episode identity falls back in three steps: the item's `guid`; the enclosure address with its query removed, because prefix analytics rewrite that on every request and keeping it would mint a new identity per poll; then a digest of title, date and episode number. `isPermaLink` is ignored entirely — it says whether a value can be fetched, not whether it is stable, and it defaults to true when absent.

`source_id` is scoped by the show (`ep:<guid>:<local>`). `source` is one value for the whole integration, and bare guids as plain as `1` exist, so without the scope two feeds would resolve to the same natural key and overwrite each other.

## Writes

**The cursor is written after every batch.** The previous integration in this programme lost a backfill to the opposite choice: the cursor was written once after the loop, so every sweep that ran out of time discarded its progress and the import reported itself complete having stored a quarter of the library. A tick killed mid-drain here resumes at the next batch.

`backfill_cursor` indexes **every episode the feed carries**, oldest first, never a filtered subset. The remembered-id ring is a per-episode skip applied while walking that list, not a reshaping of it. Filtering first was the original shape and it was wrong: the list changed between the tick that parked and the tick that resumed, so a resume landed past its own end and did nothing. There is a test for exactly that.

**The watermark is stricter than progress.** It advances only when a feed drains completely with every batch applied. Stepping over a refused episode would strand it permanently, since nothing re-offers an episode that has not changed; holding forever would re-walk the catalogue every tick for one bad row, so a pass that has already been retried once releases it.

**The containment edge is written with `ensureEdge`, never inline on the batch.** Inline edges replace rather than append, per edge type: `applyInlineEdges` deletes every outbound edge of that type from the item before writing. Since `in-collection` also accepts `user.collection`, a sweep carrying inline edges would silently delete any playlist a person had added an episode to — no error, no activity row. The edge is written once at creation and is idempotent, so there is nothing to redo on an update. The inline path is free and available, which is exactly why there is a test asserting the batch never carries edges.

`emit_events` is left false, which is the route's default but a decision rather than an inheritance. A first sweep of a thirty-feed subscription would emit on the order of twenty thousand item events, each fanning out through the reactive bridge and every webhook, and nothing consumes these types today.

`itunes:new-feed-url` is surfaced for a person and never followed. A feed naming its own replacement is an instruction from a document nobody here controls.

## Podcast Index

Enrichment gates on two **Worker secrets**, `PODCASTINDEX_API_KEY` and `PODCASTINDEX_API_SECRET`. Both present, it runs; either missing, it does not, and reading RSS never depends on it.

It is not a `token_requirements` entry. That field admits only `"required"`, so declaring it would make a directory lookup a precondition for reading a public feed. It is not a per-connection credential either: the key identifies whoever runs the deployment rather than the person using it, so every connection would present the same value and asking each person to register their own is a strictly worse install.

**The signing scheme, confirmed by probe.** Four headers: a specific `User-Agent` (generic ones are refused), `X-Auth-Key`, `X-Auth-Date` as UTC epoch **seconds** within a three-minute window, and `Authorization` as `sha1(key + secret + seconds)`, hex and lower case, no delimiters, with the header's timestamp identical to the one in the digest. Three live probes established this: the key alone returns "Authorization header value either not set or blank"; the full triple with an empty secret returns "The hash in the Authorization header doesn't match up", which is the response that proves the shape and algorithm are right and only the secret is missing.

**No response mapping is written, deliberately.** Signing is fully specified and testable against fixed vectors with no network, so it exists and is tested. The response shapes cannot be observed without a secret this deployment does not hold, and writing interfaces from documentation is guessing with type annotations on — the previous integration produced seven upstream behaviors that contradicted the vendor's own documentation. When the secret arrives, the mapping goes here against observed responses, under one rule: the feed is authoritative for everything the feed carries, and Podcast Index only supplies episodes the feed truncated away.

There is also a credential-free path upstream. The Apple-replacement `/search` and `/lookup` endpoints, on `https://api.podcastindex.org` with no `/api/1.0` segment, answer unauthenticated. It is not called from here: configuration is a static form with no way to show results and ask, so the only use would be resolving a free-text query at tick time, which means choosing what to sync from a fuzzy match. A picker belongs in a surface that can present seven results to a person.

## Parser limits, stated rather than discovered

Namespace prefixes are matched literally — `itunes:`, `podcast:`, `content:`, `dc:` — rather than resolved from their declarations. A feed binding those namespaces to other prefixes returns empty fields rather than wrong ones. Every feed observed uses the conventional prefixes.

It does not validate XML grammar. Comments are stripped before matching, because feeds ship commented-out elements and a naive match reads them as real. `<enclosure>` is matched within an item only: modern feeds attach artwork, transcripts and captions beside the audio, and one sampled feed carries five enclosure types per item, so a document-wide scan hands an episode the wrong file.

`enclosure length` is mirrored as claimed and should not be trusted; whole feeds report `0`.

A feed above forty megabytes is refused with an `action_required` rather than read.

## Validation feeds

Fetched and measured live. Kept here because each earns its place.

| Feed                                  | Size / items    | What it exercises                                                                                                                                                         |
| ------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `librivox.org/rss/52`                 | 45 KB / 57      | Zero guids, `length="0"` throughout, CDATA duration with surrounding whitespace, `itunes:explicit` as `No`, interleaved comments, non-ASCII, and no ETag or Last-Modified |
| `feeds.twit.tv/twit_video_hd.xml`     | 137 KB / 10     | Video (`video/mp4`) while declaring the same `itunes:type` as its audio sibling; also truncated                                                                           |
| `feeds.podcastindex.org/pc20.xml`     | 1.5 MB / 200    | Declared `podcast:guid`, plain-seconds durations, namespace declared by its GitHub URI                                                                                    |
| `feeds.transistor.fm/build-your-saas` | 1.8 MB / 163    | Declared `podcast:guid`, weak ETag                                                                                                                                        |
| Stuff You Should Know (Omny)          | 9.8 MB / 2,862  | Five enclosure types per item, weak ETag, no `lastBuildDate`                                                                                                              |
| `feeds.simplecast.com/54nAGcIl`       | 17.7 MB / 2,951 | The memory ceiling, and no declared guid so the computed path carries it                                                                                                  |
