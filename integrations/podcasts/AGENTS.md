# Podcasts

Scheduled poll of podcast RSS feeds. One connection holds many subscriptions; each tick takes a few in rotation and writes a show and its episodes, joined by `in-collection` edges — which the show is a valid target for because `marfa.podcast.show` declares the `container` role.

Read-only. A feed is a document a publisher serves, so there is nothing to write back to: no item-event trigger.

Distinct from `rss-watcher`, which turns any feed into `core.bookmark`. That one stays as it is.

## Two write families

`target_types` names four types and a connection picks a family with `write_family`.

- **`podcast`** (the default) writes `marfa.podcast.show` and `marfa.podcast.episode`, which keep everything a feed carries.
- **`core`** writes `core.media.series` and `core.media.episode`, which any app understanding core media can read.

Core mode is lossy and the loss is deliberate: the enclosure's MIME type and claimed size, the raw duration string, explicitness, categories and episode type have no home on the core types and are dropped. `media_url` and `mime_type` exist on `core.media.episode` because this integration needed them; before that a core episode had nowhere to put its audio.

**Core's two `medium` fields are read from the enclosure**, not from `itunes:type`, which names an ordering rather than a material: a video feed and its audio sibling both declare `episodic`. An episode's comes from its own enclosure. The series takes `mixed` when the feed carries both kinds, and is written with no medium at all when the enclosures declare nothing usable, which leaves whatever is already stored in place: an upsert merges, so a property the integration does not send is not a property it clears. The default family has no medium field at all, and keeps the enclosure's MIME type verbatim instead.

The series medium is read across the whole document rather than the slice a tick drains, because the show is rewritten on every tick and would otherwise change medium as the drain moved through a long feed.

The families are declared on the manifest itself (`write_families`), so the platform validates centrally that each family's pair appears in `target_types` and the `write_family` chooser derives its options from the declared families (`from_write_families`). The per-manifest pairing test this file used to describe stood in for that schema feature and is retired.

## The upstream is not an API

**Feeds do not paginate.** One document carries every episode a show has published. The largest in ordinary circulation is close to eighteen megabytes across nearly three thousand items, and there is no `since` parameter, no cursor, and no partial fetch. Whatever a poll costs, it costs in full.

That is why the parser is hand-rolled rather than a dependency. A scanning parser holds the source, one item and the output; a tree parser holds the source and a structure several times its size, and that ratio is the same whatever the ceiling is. There was a measurement here once, taken against a ceiling this no longer runs under, and its figures did not reconcile with each other. It is gone rather than caveated: re-measure against the real runtime before quoting anything. It is also why nothing does a whole-document `.replace()`: that allocates a second copy of an eighteen-megabyte string. The channel is read from a slice taken before the first `<item`.

**Conditional requests carry the efficiency.** Every host tested honors `If-None-Match`, and all but one honor `If-Modified-Since`. A steady-state tick over thirty feeds should be a few kilobytes of headers rather than hundreds of megabytes of XML, plus one small `GET /items` per feed for the checkpoint check below. The ETag is echoed back verbatim, weak `W/` prefix included, because two hosts send weak tags. `<lastBuildDate>` is deliberately not used as a substitute: some hosts omit it, some regenerate it on every render, and one emits an alphabetic timezone that many date parsers mishandle.

**A checkpoint can outlive the rows it refers to.** The sweep remembers each episode by identity and skips anything it remembers, so a ring that is full while the show holds nothing produces a run that writes nothing and reports success. One connection swept hourly for three days that way. Every tick therefore asks, before the conditional request, whether the show has any episode at all in any state and under either write family, and says so once when it does not. It reports rather than repairing: no rows anywhere cannot tell loss from a deletion somebody meant, because a trashed item is purged once its retention expires. It does not catch partial loss, which needs a reconciliation rather than a question.

**Some feeds are truncated and none of them say so.** One show with over a thousand episodes publishes a ten-item feed. Nothing in the document distinguishes that from a show with ten episodes, and no heuristic recovers it — episode-number gaps are unreliable and plenty of feeds carry no `itunes:episode` at all. This is the gap Podcast Index would fill.

## Identity

**A feed address is not an identity.** Shows move hosts. If the address were the key, one subscription would become two the day a publisher switched provider.

A show is keyed on `podcast_guid`: the value the channel declares, or, where it declares none, the same value computed as Podcasting 2.0 defines it — a UUIDv5 over the address with the scheme and any trailing slash removed, under a fixed namespace. A feed that later adds a conformant guid therefore lands on the value already stored. Verified against the two sampled feeds that publish one; both reproduce exactly.

Most feeds declare nothing. Of fourteen sampled, three did, and none of the mainstream hosts were among them.

**The show's identity is written once and never recomputed.** It is read from the cursor, not derived per tick. Recomputing would re-key every stored episode the moment an address changed. The consequence to know: for a feed with no declared guid, re-pointing the subscription to a new address does start a second show. The alternative was silently rewriting a catalog, which is worse.

Episode identity falls back in three steps: the item's `guid`; the enclosure address with its query removed, because prefix analytics rewrite that on every request and keeping it would mint a new identity per poll; then a digest of title, date and episode number. `isPermaLink` is ignored entirely — it says whether a value can be fetched, not whether it is stable, and it defaults to true when absent.

`source_id` is scoped by the show (`ep:<guid>:<local>`). `source` is one value for the whole integration, and bare guids as plain as `1` exist, so without the scope two feeds would resolve to the same natural key and overwrite each other.

## Writes

**The cursor is written after every batch.** The previous integration in this program lost a backfill to the opposite choice: the cursor was written once after the loop, so every sweep that ran out of time discarded its progress and the import reported itself complete having stored a quarter of the library. A tick killed mid-drain here resumes at the next batch.

**A drained feed stays drained.** The ring is bounded at `RECENT_ID_RING_SIZE`, so on a feed longer than that it cannot answer "have I imported this" for the whole catalog, and a completed drain used to be walked from the beginning on every tick with only the tail remembered. A completed drain records the identity of the newest episode it reached and how many stood at or before it; the next tick finds that identity in its own list, and the count tells a drop from an insertion, which need opposite answers. The boundary stops at the last episode that actually landed, so a refusal is re-offered rather than stepped over. The refusal is recorded on the cursor rather than in a local, because a pass spans ticks and a local forgot it the moment the budget ran out.

**Revalidators are not sent while a drain is parked.** A parked drain persists the tag it just received, so asking whether the feed changed gets "no" for a feed it has read half of, and the 304 returns before anything looks at the parked position. Unconditional asking is bounded by `STUCK_FEED_DAYS`, measured from the last tick that wrote something rather than from when the pass began, so an import that is converging never trips it. A pass with no progress for that long says so once and goes back to asking conditionally, so a drain that can never finish does not pull a full body every tick forever. The parked position and the pass's first refusal are both carried by identity rather than by index, because an index recorded on one tick and read on another indexes two different lists: a publisher removing an old episode shifts every later one down. An anchor that has moved _up_, or vanished, means the list shifted in a way that can hide work: the pass carries on from the best position it has and owes one full walk, which the pass after it performs. Restarting the drain instead does not converge, because whatever moved the anchor is usually still there on the next tick, and a pass that never completes never stops pulling the whole body.

`backfill_cursor` indexes **every episode the feed carries**, oldest first, never a filtered subset. The remembered-id ring is a per-episode skip applied while walking that list, not a reshaping of it. Filtering first was the original shape and it was wrong: the list changed between the tick that parked and the tick that resumed, so a resume landed past its own end and did nothing. There is a test for exactly that.

**The watermark is stricter than progress.** It advances only when a feed drains completely with every batch applied. Stepping over a refused episode would strand it permanently, since nothing re-offers an episode that has not changed; holding forever would re-walk the catalog every tick for one bad row, so a pass that has already been retried once releases it.

**The containment edge is written with `ensureEdge`, never inline on the batch.** Inline edges replace rather than append, per edge type: `applyInlineEdges` deletes every outbound edge of that type from the item before writing. Since `in-collection` accepts every container a space holds, a sweep carrying inline edges would silently delete any playlist a person had added an episode to — no error, no activity row. The edge is written once at creation and is idempotent, so there is nothing to redo on an update. The inline path is free and available, which is exactly why there is a test asserting the batch never carries edges.

`emit_events` is left false, which is the route's default but a decision rather than an inheritance. A first sweep of a thirty-feed subscription would emit on the order of twenty thousand item events, each fanning out through the reactive bridge and every webhook, and nothing consumes these types today.

`itunes:new-feed-url` is surfaced for a person and never followed. A feed naming its own replacement is an instruction from a document nobody here controls.

## Podcast Index

Enrichment gates on two **deployment environment variables**, `PODCASTINDEX_API_KEY` and `PODCASTINDEX_API_SECRET`. **Nothing reads them yet**: `readCredentials` has no caller, no lookup is issued, and a sweep behaves identically with or without them. Reading RSS never depends on it, which is true in the strong sense that the feature does not exist.

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
