import { familyOnlyMappingResolver } from "@withmarfa/runtime-sdk";
import { MAX_FILTER_INPUT_LENGTH } from "@withmarfa/shared";
/* eslint-disable @typescript-eslint/require-await --
   The harness stubs stand in for asynchronous SDK methods, so they are
   async to match the interface they replace rather than because their
   bodies await anything. */
import { describe, expect, it } from "vitest";
import { createScheduleHandler } from "./handlers.js";
import {
  EPISODE_BATCH_SIZE,
  MAX_EPISODES_PER_TICK,
  RECENT_ID_RING_SIZE,
  STUCK_FEED_DAYS,
} from "./manifest.js";
import type { ConnectionContext } from "@withmarfa/runtime-sdk";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

interface EdgeCall {
  source_id: string;
  target_id: string;
  edge_type: string;
}

interface BulkCall {
  inputs: {
    type: string;
    source_id?: string;
    properties?: Record<string, unknown>;
    edges?: unknown;
  }[];
}

interface HarnessOptions {
  feedUrls?: string[];
  writeFamily?: "podcast" | "core";
  /** Responses keyed by URL; each call shifts the next one off. */
  responses?: Record<string, (Response | Error)[]>;
  /** Return "errored" for source_ids matching this. */
  failEpisode?: (sourceId: string) => boolean;
  /** Throw from bulkUpsertItems on the nth call (1-based). */
  throwOnBulkCall?: number;
  /** Mutable so a test can fail a join on one tick and let it
   *  succeed on the next, which is the whole retry property. */
  ensureEdgeThrows?: boolean;
  configReadThrows?: boolean;
  cursors?: Record<string, unknown>;
  /** How many episode rows a `listItems` lookup finds. Defaults to one,
   *  because the stale-checkpoint check only fires on none. */
  storedEpisodes?: number;
  /** Overrides `storedEpisodes` per item state. */
  storedEpisodesByState?: Record<string, number>;
  /** Overrides both, per episode type and then per item state. */
  storedEpisodesByType?: Record<string, Record<string, number>>;
  /** Throw from `activity.emit` on summaries matching this. */
  activityThrowsOn?: (summary: string) => boolean;
  listItemsThrows?: boolean;
}

function harness(opts: HarnessOptions = {}) {
  // structuredClone on both sides, so a handler cannot mutate stored state
  // by reference and make a later assertion pass for the wrong reason.
  const store = new Map<string, unknown>();
  for (const [k, v] of Object.entries(opts.cursors ?? {}))
    store.set(k, structuredClone(v));

  const cursorWrites: { key: string; value: Record<string, unknown> }[] = [];
  const activity: {
    severity: string;
    summary: string;
    detail?: Record<string, unknown>;
  }[] = [];
  const bulkCalls: BulkCall[] = [];
  const listQueries: {
    type?: string;
    filter?: string;
    state?: string;
    limit?: number;
  }[] = [];
  const edges: EdgeCall[] = [];
  const created: {
    type: string;
    source_id?: string;
    properties?: Record<string, unknown>;
  }[] = [];
  const fetched: { url: string; headers: Record<string, string> }[] = [];

  let itemSeq = 0;
  let bulkSeq = 0;

  const marfa = {
    async getItem(id: string) {
      if (opts.configReadThrows === true)
        throw new Error("connection lookup failed");
      return {
        id,
        type: "system.connection",
        properties: {
          configuration: {
            feed_urls: opts.feedUrls ?? ["https://feeds.example/show"],
            write_family: opts.writeFamily ?? "podcast",
          },
        },
      };
    },
    async createItem(input: {
      type: string;
      source_id?: string;
      properties?: Record<string, unknown>;
    }) {
      created.push(input);
      itemSeq += 1;
      return { id: `item-${String(itemSeq)}` };
    },
    async bulkUpsertItems(inputs: BulkCall["inputs"]) {
      bulkSeq += 1;
      if (opts.throwOnBulkCall === bulkSeq)
        throw new Error("bulk write failed");
      bulkCalls.push({ inputs });
      return {
        counts: { created: inputs.length, updated: 0, skipped: 0, errored: 0 },
        results: inputs.map((input, index) => {
          if (opts.failEpisode?.(input.source_id ?? "") === true) {
            return {
              index,
              outcome: "errored" as const,
              error: { code: "x", message: "refused" },
            };
          }
          itemSeq += 1;
          return {
            index,
            outcome: "created" as const,
            id: `item-${String(itemSeq)}`,
          };
        }),
      };
    },
    async ensureEdge(input: EdgeCall) {
      if (opts.ensureEdgeThrows === true) throw new Error("edge refused");
      edges.push(input);
      return "created" as const;
    },
    async listItems(query: {
      type?: string;
      filter?: string;
      state?: string;
      limit?: number;
    }) {
      listQueries.push(query);
      if (opts.listItemsThrows === true) throw new Error("list failed");
      // Keyed by type first, then by state, so a test can put a show's
      // episodes under the other write family or in the trash and still say
      // they exist.
      const byType = opts.storedEpisodesByType?.[query.type ?? ""];
      const count =
        byType?.[query.state ?? "active"] ??
        (byType === undefined
          ? (opts.storedEpisodesByState?.[query.state ?? "active"] ??
            (query.state === "active" ? (opts.storedEpisodes ?? 1) : 0))
          : 0);
      return {
        data: Array.from({ length: count }, (_, i) => ({
          id: `stored-${String(i)}`,
        })),
        cursor: null,
        has_more: false,
      };
    },
  };

  const ctx = {
    connection_id: "conn-1",
    integration_name: "marfa/podcasts",
    marfa,
    cursor: {
      async read(key: string) {
        const v = store.get(key);
        return v === undefined ? null : structuredClone(v);
      },
      async write(key: string, value: unknown) {
        store.set(key, structuredClone(value));
        cursorWrites.push({
          key,
          value: structuredClone(value) as Record<string, unknown>,
        });
      },
    },
    activity: {
      async emit(a: {
        severity: string;
        summary: string;
        detail?: Record<string, unknown>;
      }) {
        if (opts.activityThrowsOn?.(a.summary) === true) {
          throw new Error("activity emit failed");
        }
        activity.push(a);
      },
    },
    echo: {} as never,
    mapping: familyOnlyMappingResolver(),
    cycle: null,
  } as unknown as ConnectionContext;

  const fetchImpl = (async (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => {
    fetched.push({ url, headers: init?.headers ?? {} });
    const queue = opts.responses?.[url];
    const next = queue?.shift();
    if (next instanceof Error) throw next;
    return next ?? feedResponse(feedXml(3));
  }) as unknown as typeof fetch;

  return {
    ctx,
    store,
    cursorWrites,
    activity,
    bulkCalls,
    listQueries,
    edges,
    created,
    fetched,
    fetchImpl,
  };
}

function feedResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(init.status === 304 ? null : body, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

/**
 * The same feed with video enclosures. A video podcast is an ordinary RSS
 * feed whose enclosures carry a video MIME type, and `itunes:type` says
 * `episodic` either way, so the enclosure is the only thing that
 * distinguishes one.
 */
function videoFeedXml(episodes: number): string {
  return feedXml(episodes)
    .replaceAll(".mp3", ".mp4")
    .replaceAll('type="audio/mpeg"', 'type="video/mp4"');
}

/** A show that publishes both, which the core series type calls `mixed`. */
function mixedFeedXml(): string {
  return feedXml(2)
    .replace(".mp3", ".mp4")
    .replace('type="audio/mpeg"', 'type="video/mp4"');
}

function feedXml(
  episodes: number,
  guidPrefix = "ep",
  showGuid = "11111111-2222-5333-8444-555555555555",
): string {
  const items = Array.from({ length: episodes }, (_, i) => {
    const n = episodes - i; // newest first, as feeds are written
    return `<item><title>Episode ${String(n)}</title><guid isPermaLink="false">${guidPrefix}-${String(n)}</guid>
      <pubDate>Mon, 0${String((n % 9) + 1)} Jan 2024 00:00:00 +0000</pubDate>
      <enclosure url="https://cdn.example/${guidPrefix}-${String(n)}.mp3" type="audio/mpeg" length="1"/>
      <itunes:duration>600</itunes:duration></item>`;
  }).join("\n");
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel><title>A Show</title><link>https://example.com</link>
  <podcast:guid>${showGuid}</podcast:guid>
  ${items}</channel></rss>`;
}

const MSG = { scheduled_for_ms: Date.parse("2026-08-18T12:00:00.000Z") };

function feedCursors(
  writes: { key: string; value: Record<string, unknown> }[],
) {
  return writes.filter((w) => w.key.startsWith("feed:"));
}

/* ------------------------------------------------------------------ */
/* Durability — the four that the previous integration's bug required   */
/* ------------------------------------------------------------------ */

describe("progress is recorded as it happens", () => {
  it("writes the cursor after every batch, not once at the end", async () => {
    // The failure this guards against passed a "cursor is correct at the
    // end" test perfectly: it was correct at the end, and empty every time
    // a sweep died before reaching it.
    const episodes = EPISODE_BATCH_SIZE * 3;
    const h = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(episodes))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const checkpoints = feedCursors(h.cursorWrites).filter(
      (w) => "backfill_cursor" in w.value,
    );
    expect(checkpoints.length).toBeGreaterThanOrEqual(3);
    expect(h.bulkCalls).toHaveLength(3);
  });

  it("leaves completed batches recorded when a sweep dies mid-drain", async () => {
    const episodes = EPISODE_BATCH_SIZE * 3;
    const h = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(episodes))],
      },
      throwOnBulkCall: 2,
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const feedKey = [...h.store.keys()].find((k) => k.startsWith("feed:"));
    const stored = h.store.get(String(feedKey)) as {
      backfill_cursor: number | null;
    };
    // The first batch applied and is not repeated; the second did not and is.
    expect(stored.backfill_cursor).toBe(EPISODE_BATCH_SIZE);
    expect(h.bulkCalls).toHaveLength(1);
  });

  it("resumes from where it stopped rather than starting the feed again", async () => {
    const episodes = EPISODE_BATCH_SIZE * 2;
    const first = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(episodes))],
      },
      throwOnBulkCall: 2,
    });
    await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);

    const carried: Record<string, unknown> = {};
    for (const [k, v] of first.store) carried[k] = v;

    const second = harness({
      cursors: carried,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(episodes))],
      },
    });
    await createScheduleHandler({ fetch: second.fetchImpl })(second.ctx, MSG);

    // Nothing from the first batch is offered again.
    const written = second.bulkCalls.flatMap((c) =>
      c.inputs.map((i) => i.source_id),
    );
    expect(written.some((s) => String(s).endsWith("g:ep-1"))).toBe(false);
    expect(written.length).toBe(EPISODE_BATCH_SIZE);
  });

  it("holds the watermark for a refused episode, then releases it after a retry", async () => {
    const feed = feedXml(2);
    const h = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(feed), feedResponse(feed)],
      },
      failEpisode: (s) => s.endsWith("g:ep-2"),
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });

    await handler(h.ctx, MSG);
    const feedKey = String(
      [...h.store.keys()].find((k) => k.startsWith("feed:")),
    );
    const afterFirst = h.store.get(feedKey) as {
      retried_after_failure: boolean;
      drained_through_id: string | null;
    };
    expect(afterFirst.retried_after_failure).toBe(true);
    // The boundary stops at the last episode that landed, not at the end
    // of the feed: recording it past the refusal would strand the episode,
    // because nothing re-offers one that has not changed.
    expect(afterFirst.drained_through_id).toBe("g:ep-1");

    await handler(h.ctx, MSG);
    const afterSecond = h.store.get(feedKey) as {
      retried_after_failure: boolean;
      drained_through_id: string | null;
    };
    // Held forever, one bad episode makes every tick re-walk the catalog.
    expect(afterSecond.retried_after_failure).toBe(false);
    // And the boundary still stops short of the refusal, which is what
    // keeps it reachable after the retry flag has released.
    expect(afterSecond.drained_through_id).toBe("g:ep-1");
  });

  it("offers the refused episode again on the retry pass", async () => {
    // The retry the flags above grant is only worth granting if the pass
    // actually re-offers the refusal. Nothing re-offers an episode the
    // sweep has stepped over, so a drain boundary recorded past a refusal
    // strands it permanently and leaves the retry pass with no work in it,
    // while both assertions above still pass.
    const feed = feedXml(2);
    const h = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(feed), feedResponse(feed)],
      },
      failEpisode: (s) => s.endsWith("g:ep-2"),
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });

    await handler(h.ctx, MSG);
    const firstTickWrites = h.bulkCalls.length;
    await handler(h.ctx, MSG);

    const offeredOnRetry = h.bulkCalls
      .slice(firstTickWrites)
      .flatMap((c) => c.inputs.map((i) => String(i.source_id)));
    expect(offeredOnRetry.some((id) => id.endsWith("g:ep-2"))).toBe(true);
  });

  it("remembers a refusal from an earlier tick of the same pass", async () => {
    // A pass spans ticks and the boundary is a property of the pass. Held
    // in a local it was forgotten the moment the budget ran out, so a feed
    // one tick's budget too long refused an episode in tick one, finished
    // in tick two with nothing refused, and recorded its boundary at the
    // end of the feed. The episode was never written, so it is not in the
    // ring either, and every tick afterwards reported a clean sweep.
    const episodes = MAX_EPISODES_PER_TICK + 20;
    const xml = feedXml(episodes);
    const carried: Record<string, unknown> = {};
    const written: string[] = [];
    // `ep-1` is the oldest, so it is offered first and refused in tick one.
    for (let tick = 0; tick < 4; tick += 1) {
      const h = harness({
        cursors: carried,
        responses: { "https://feeds.example/show": [feedResponse(xml)] },
        failEpisode: (id) => id.endsWith("g:ep-1"),
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
      for (const [k, v] of h.store) carried[k] = v;
      if (tick === 3) {
        written.push(
          ...h.bulkCalls.flatMap((c) =>
            c.inputs.map((i) => String(i.source_id)),
          ),
        );
      }
    }

    // Two ticks to drain, a third and a fourth after it. The refusal is
    // still offered rather than sitting behind the boundary.
    expect(written.some((id) => id.endsWith("g:ep-1"))).toBe(true);
  });

  it("still stops short of the refusal when the feed loses an older episode", async () => {
    // The refusal decides where a pass's boundary lands, and a pass spans
    // ticks, so recording it as an index makes it an index into two
    // different lists. A publisher removing an older episode shifts every
    // later one down, and the boundary then lands *on* the refused episode
    // rather than before it, which strands it in exactly the way the
    // boundary exists to prevent.
    const episodes = MAX_EPISODES_PER_TICK + 40;
    const full = feedXml(episodes);
    // Drop the oldest, which is last in the document.
    const lastItemAt = full.lastIndexOf("<item>");
    const shorter =
      full.slice(0, lastItemAt) +
      full.slice(full.indexOf("</item>", lastItemAt) + "</item>".length);

    const carried: Record<string, unknown> = {};
    const offeredLater: string[] = [];
    let boundaryAfterCompletion: string | null = null;
    // `ep-3` is the third oldest, so it is refused in the first tick and
    // the removal happens before the tick that finishes the pass.
    const bodies = [full, shorter, shorter];
    for (const [tick, body] of bodies.entries()) {
      const h = harness({
        cursors: carried,
        responses: { "https://feeds.example/show": [feedResponse(body)] },
        failEpisode: (id) => id.endsWith("g:ep-3"),
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
      for (const [k, v] of h.store) carried[k] = v;
      if (tick === 1) {
        const feedKey = String(
          Object.keys(carried).find((k) => k.includes("feed:")),
        );
        boundaryAfterCompletion = (
          carried[feedKey] as { drained_through_id: string | null }
        ).drained_through_id;
      }
      if (tick === bodies.length - 1) {
        offeredLater.push(
          ...h.bulkCalls.flatMap((c) =>
            c.inputs.map((i) => String(i.source_id)),
          ),
        );
      }
    }

    // Asserted after the tick that completed the pass, which is where the
    // value differs: recorded positionally it lands on `ep-3` itself, and
    // a later tick would then rewrite it to the end of the feed and hide
    // that.
    expect(boundaryAfterCompletion).toBe("g:ep-2");
    expect(offeredLater.some((id) => id.endsWith("g:ep-3"))).toBe(true);
  });

  it("clears the stuck report when an episode lands, so a second stall is not silent", async () => {
    // The sibling marker clears on the same evidence and for the same
    // reason: a pass that stalls, moves, and stalls again has stalled
    // twice, and suppressing the second report for the life of the pass
    // hides it.
    // Long enough that the second tick writes and parks again, so the
    // pass is still open when the marker is read. A pass that completes
    // clears it anyway, which would say nothing about this.
    const episodes = MAX_EPISODES_PER_TICK * 2 + 20;
    const body = feedXml(episodes);
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(body, { headers: { etag: '"v1"' } }),
          feedResponse(body, { headers: { etag: '"v1"' } }),
        ],
      },
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });
    await handler(h.ctx, MSG);
    // Long enough later to be stuck, and the tick writes, so the report
    // fires and is then cleared by the write in the same tick.
    await handler(h.ctx, {
      scheduled_for_ms:
        MSG.scheduled_for_ms + (STUCK_FEED_DAYS + 1) * 24 * 3_600_000,
    });

    const feedKey = String(
      [...h.store.keys()].find((k) => k.includes("feed:")),
    );
    const stored = h.store.get(feedKey) as {
      stuck_pass_reported_at: string | null;
      backfill_cursor: number | null;
    };
    expect(
      h.activity.some((a) => a.summary.includes("longer than it should be")),
    ).toBe(true);
    // Still mid-pass, so the completion clear has not run.
    expect(stored.backfill_cursor).not.toBeNull();
    expect(stored.stuck_pass_reported_at).toBeNull();
  });

  it("keeps offering it after the retry flag has released", async () => {
    // The flag releases after one retry so a permanently bad episode
    // cannot make every tick re-walk the catalog. If the boundary released
    // with it, the third pass would step over the refusal and the episode
    // would be gone for good, with the feed reporting a quiet successful
    // sweep every hour afterwards.
    const feed = feedXml(2);
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(feed),
          feedResponse(feed),
          feedResponse(feed),
        ],
      },
      failEpisode: (s) => s.endsWith("g:ep-2"),
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });

    await handler(h.ctx, MSG);
    await handler(h.ctx, MSG);
    const beforeThird = h.bulkCalls.length;
    await handler(h.ctx, MSG);

    const offered = h.bulkCalls
      .slice(beforeThird)
      .flatMap((c) => c.inputs.map((i) => String(i.source_id)));
    expect(offered.some((id) => id.endsWith("g:ep-2"))).toBe(true);
    // And it does not re-offer what already landed.
    expect(offered.some((id) => id.endsWith("g:ep-1"))).toBe(false);
  });

  it("stops asking whether the feed changed while a drain is parked", async () => {
    // A parked drain persists the revalidator it just received, so asking
    // the conditional question on the next tick gets "no" for a feed it
    // has read half of, and the 304 returns before anything looks at the
    // parked position. Every host tested honors `If-None-Match`, so a feed
    // longer than one tick's budget simply stopped importing.
    const episodes = MAX_EPISODES_PER_TICK + 20;
    const body = feedXml(episodes);
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(body, { headers: { etag: '"v1"' } }),
          // What a host returns to an unconditional request. Asking
          // conditionally here is the defect: the same host would answer
          // 304 and the parked drain would never continue.
          feedResponse(body, { headers: { etag: '"v1"' } }),
        ],
      },
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });

    await handler(h.ctx, MSG);
    await handler(h.ctx, MSG);

    expect(h.fetched).toHaveLength(2);
    expect(h.fetched[0]?.headers["If-None-Match"]).toBeUndefined();
    expect(h.fetched[1]?.headers["If-None-Match"]).toBeUndefined();
    // And the drain carried on rather than answering 304 to itself.
    const written = h.bulkCalls.flatMap((c) => c.inputs.length);
    expect(written.reduce((a, b) => a + b, 0)).toBeGreaterThan(
      MAX_EPISODES_PER_TICK,
    );
  });

  it("goes back to asking, and says so, once a pass has been open too long", async () => {
    // Unconditional asking is bounded by the drain finishing, and several
    // ways of parking do not finish: a fetch that throws, a body over the
    // ceiling, a parse failure, a batch that fails the same way every
    // time. On a seventeen-megabyte feed that is the whole body pulled
    // from somebody else's CDN every hour, forever.
    const episodes = MAX_EPISODES_PER_TICK + 20;
    const body = feedXml(episodes);
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(body, { headers: { etag: '"v1"' } }),
          feedResponse(body, { headers: { etag: '"v1"' } }),
        ],
      },
    });
    // First tick parks. The clock then jumps past the ceiling without the
    // drain having moved.
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, {
      scheduled_for_ms:
        MSG.scheduled_for_ms + (STUCK_FEED_DAYS + 1) * 24 * 3_600_000,
    });

    expect(h.fetched[1]?.headers["If-None-Match"]).toBe('"v1"');
    expect(
      h.activity.some((a) => a.summary.includes("longer than it should be")),
    ).toBe(true);
  });

  it("does not call a converging import stuck, however long it takes", async () => {
    // The ceiling is documented as a pass open this long without progress.
    // Measured from when the pass began instead, an import too large to
    // finish inside it trips on its own size: the feed goes back to asking
    // conditionally, the host answers 304, and the drain that was working
    // stops. A whole-connection budget of five hundred an hour makes that
    // reachable on a catalog of a few tens of thousands.
    const episodes = MAX_EPISODES_PER_TICK * 2 + 10;
    const xml = feedXml(episodes);
    const carried: Record<string, unknown> = {};
    const activity: string[] = [];
    // Ticks spaced just inside the ceiling, so no single gap trips it
    // while the total elapsed comfortably exceeds it. That is the whole
    // difference between measuring progress and measuring the pass.
    for (let tick = 0; tick < 3; tick += 1) {
      const at =
        MSG.scheduled_for_ms + tick * (STUCK_FEED_DAYS - 1) * 24 * 3_600_000;
      const h = harness({
        cursors: carried,
        responses: {
          "https://feeds.example/show": [
            feedResponse(xml, { headers: { etag: '"v1"' } }),
          ],
        },
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, {
        scheduled_for_ms: at,
      });
      for (const [k, v] of h.store) carried[k] = v;
      activity.push(...h.activity.map((a) => a.summary));
    }

    expect(
      activity.some((sum) => sum.includes("longer than it should be")),
    ).toBe(false);
  });

  it("asks whether the feed changed once the drain has finished", async () => {
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(3), { headers: { etag: '"v1"' } }),
          feedResponse("", { status: 304 }),
        ],
      },
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });
    await handler(h.ctx, MSG);
    await handler(h.ctx, MSG);

    expect(h.fetched[1]?.headers["If-None-Match"]).toBe('"v1"');
  });

  it("parks rather than exceeding its episode budget in one tick", async () => {
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(MAX_EPISODES_PER_TICK + 40)),
        ],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const feedKey = String(
      [...h.store.keys()].find((k) => k.startsWith("feed:")),
    );
    const stored = h.store.get(feedKey) as {
      backfill_cursor: number | null;
      drained_through_id: string | null;
    };
    expect(stored.backfill_cursor).not.toBeNull();
    // A parked feed has not finished, so its boundary must not move.
    expect(stored.drained_through_id).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The containment edge                                                */
/* ------------------------------------------------------------------ */

describe("episodes are joined to their show", () => {
  it("writes the edge from the episode to the show", async () => {
    const h = harness({
      responses: { "https://feeds.example/show": [feedResponse(feedXml(2))] },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(h.edges).toHaveLength(2);
    for (const edge of h.edges) {
      // Asserted by name, not position: a swap is the mistake this catches,
      // and the two arguments are the same shape.
      expect(edge.edge_type).toBe("in-collection");
      expect(edge.target_id).toBe("item-1"); // the show, written first
      expect(edge.source_id).not.toBe("item-1");
    }
  });

  it("never sends inline edges on the batch write", async () => {
    // Inline edges replace rather than append, per edge type, so a sweep
    // would silently delete any collection a person had added an episode
    // to. This is the test that stops that becoming an optimization.
    const h = harness({
      responses: { "https://feeds.example/show": [feedResponse(feedXml(3))] },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    for (const call of h.bulkCalls) {
      for (const input of call.inputs) expect(input.edges).toBeUndefined();
    }
  });

  it("writes the show before any episode", async () => {
    const h = harness({
      responses: { "https://feeds.example/show": [feedResponse(feedXml(2))] },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(h.created[0]?.type).toBe("marfa.podcast.show");
    expect(h.bulkCalls[0]?.inputs[0]?.type).toBe("marfa.podcast.episode");
  });

  it("retries a failed join on the next tick instead of orphaning it", async () => {
    // The defect this replaces: the join was attempted only on the tick
    // that created the episode. A failure emitted a row, but the episode
    // was still counted as written and still entered the remembered-ids
    // ring, so it was never offered again and the edge could never form.
    // One transient refusal orphaned a member permanently.
    const opts = {
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(1)),
          feedResponse(feedXml(1)),
        ],
      },
      ensureEdgeThrows: true,
    };
    const h = harness(opts);
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    // Parked rather than reported: a first failure is not yet a person's
    // problem, because the next tick is going to try again.
    const parked = [...h.store.values()].find(
      (c): c is { pending_joins?: string[] } =>
        typeof c === "object" && c !== null && "pending_joins" in c,
    );
    expect(parked?.pending_joins ?? []).toHaveLength(1);
    expect(h.activity.some((a) => a.summary.includes("not joined"))).toBe(
      false,
    );

    // Second tick, with the edge now accepted. The episode is already
    // remembered, so the sweep will not offer it — the drain is the only
    // thing that can repair it.
    opts.ensureEdgeThrows = false;
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(h.edges.length).toBeGreaterThan(0);
    const stillParked = [...h.store.values()].find(
      (c): c is { pending_joins?: string[] } =>
        typeof c === "object" && c !== null && "pending_joins" in c,
    );
    expect(stillParked?.pending_joins ?? []).toHaveLength(0);
  });

  it("reports only once the retry has also failed", async () => {
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(1)),
          feedResponse(feedXml(1)),
        ],
      },
      ensureEdgeThrows: true,
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(
      h.activity.some(
        (a) =>
          a.severity === "action_required" &&
          a.summary.includes("still not joined to their show"),
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Conditional requests                                                */
/* ------------------------------------------------------------------ */

describe("a feed that has not changed", () => {
  it("sends both revalidators, echoing a weak tag verbatim", async () => {
    const feed = feedXml(1);
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(feed, {
            headers: {
              etag: 'W/"abc"',
              "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
            },
          }),
          feedResponse("", { status: 304 }),
        ],
      },
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });
    await handler(h.ctx, MSG);
    await handler(h.ctx, MSG);

    const second = h.fetched[1]?.headers ?? {};
    expect(second["If-None-Match"]).toBe('W/"abc"');
    expect(second["If-Modified-Since"]).toBe("Mon, 01 Jan 2024 00:00:00 GMT");
  });

  it("does no work at all on a 304", async () => {
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(1), { headers: { etag: '"v1"' } }),
          feedResponse("", { status: 304 }),
        ],
      },
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });
    await handler(h.ctx, MSG);
    const bulkAfterFirst = h.bulkCalls.length;
    await handler(h.ctx, MSG);

    expect(h.bulkCalls).toHaveLength(bulkAfterFirst);
    expect(
      h.created.filter((c) => c.type === "marfa.podcast.show"),
    ).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

describe("configuration", () => {
  it("aborts the tick when the configuration cannot be read", async () => {
    // An empty list and a failed read are indistinguishable downstream, and
    // an empty list reads as "unsubscribed from everything".
    const h = harness({ configReadThrows: true });
    const result = await createScheduleHandler({ fetch: h.fetchImpl })(
      h.ctx,
      MSG,
    );

    expect(result).toEqual(expect.objectContaining({ ok: false, retry: true }));
    expect(h.cursorWrites).toHaveLength(0);
    expect(h.fetched).toHaveLength(0);
  });

  it("retires a removed feed rather than forgetting it", async () => {
    const first = harness({
      feedUrls: ["https://feeds.example/a", "https://feeds.example/b"],
      responses: {
        "https://feeds.example/a": [feedResponse(feedXml(1, "a"))],
        "https://feeds.example/b": [feedResponse(feedXml(1, "b"))],
      },
    });
    await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);

    const carried: Record<string, unknown> = {};
    for (const [k, v] of first.store) carried[k] = v;

    const second = harness({
      cursors: carried,
      feedUrls: ["https://feeds.example/a"],
      responses: {
        "https://feeds.example/a": [feedResponse("", { status: 304 })],
      },
    });
    await createScheduleHandler({ fetch: second.fetchImpl })(second.ctx, MSG);

    const retired = [...second.store.values()].filter(
      (v) => (v as { retired_at?: string | null }).retired_at != null,
    );
    expect(retired).toHaveLength(1);
    // Kept, not deleted: re-adding must not replay the back catalog.
    expect(retired[0]).toHaveProperty("recent_entry_ids");
  });

  it("writes the core family when a connection asks for it", async () => {
    const h = harness({
      writeFamily: "core",
      responses: { "https://feeds.example/show": [feedResponse(feedXml(1))] },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(h.created[0]?.type).toBe("core.media.series");
    expect(h.bulkCalls[0]?.inputs[0]?.type).toBe("core.media.episode");
    const props = h.bulkCalls[0]?.inputs[0]?.properties ?? {};
    expect(props.media_url).toBe("https://cdn.example/ep-1.mp3");
    expect(props.mime_type).toBe("audio/mpeg");
    expect(props.medium).toBe("podcast");
    expect(h.created[0]?.properties?.medium).toBe("podcast");
  });

  it("carries a video enclosure through to the core family's medium", async () => {
    const h = harness({
      writeFamily: "core",
      responses: {
        "https://feeds.example/show": [feedResponse(videoFeedXml(1))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const props = h.bulkCalls[0]?.inputs[0]?.properties ?? {};
    expect(props.medium).toBe("video");
    expect(props.mime_type).toBe("video/mp4");
    expect(props.media_url).toBe("https://cdn.example/ep-1.mp4");
    // The series has to agree with its episodes. Held to "podcast" it said
    // one thing while every child said another.
    expect(h.created[0]?.properties?.medium).toBe("video");
  });

  it("calls a series carrying both kinds mixed rather than the first one seen", async () => {
    const h = harness({
      writeFamily: "core",
      responses: {
        "https://feeds.example/show": [feedResponse(mixedFeedXml())],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(h.created[0]?.properties?.medium).toBe("mixed");
  });

  it("gives a series no medium rather than guessing one", async () => {
    const h = harness({
      writeFamily: "core",
      responses: {
        "https://feeds.example/show": [
          feedResponse(
            feedXml(1).replace(
              /<enclosure[^>]*\/>/,
              '<enclosure url="https://cdn.example/ep-1.bin" type="application/octet-stream" length="1"/>',
            ),
          ),
        ],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(h.created[0]?.properties).not.toHaveProperty("medium");
  });

  it("carries a video enclosure through to the default family", async () => {
    const h = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(videoFeedXml(1))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const props = h.bulkCalls[0]?.inputs[0]?.properties ?? {};
    expect(props.enclosure_type).toBe("video/mp4");
    expect(props.enclosure_url).toBe("https://cdn.example/ep-1.mp4");
  });

  it("writes its own family by default, keeping what core cannot hold", async () => {
    const h = harness({
      responses: { "https://feeds.example/show": [feedResponse(feedXml(1))] },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const props = h.bulkCalls[0]?.inputs[0]?.properties ?? {};
    expect(props.enclosure_type).toBe("audio/mpeg");
    expect(props.duration_raw).toBe("600");
    expect(props.podcast_guid).toBe("11111111-2222-5333-8444-555555555555");
  });
});

/* ------------------------------------------------------------------ */
/* Rotation                                                            */
/* ------------------------------------------------------------------ */

describe("many feeds", () => {
  it("scopes an episode's provenance by its show", async () => {
    // Two feeds emitting the identical bare guid must not collide.
    const h = harness({
      feedUrls: ["https://feeds.example/a", "https://feeds.example/b"],
      responses: {
        "https://feeds.example/a": [feedResponse(feedXml(1, "shared"))],
        "https://feeds.example/b": [
          feedResponse(
            feedXml(1, "shared").replace(
              "11111111-2222-5333-8444-555555555555",
              "99999999-2222-5333-8444-555555555555",
            ),
          ),
        ],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const ids = h.bulkCalls.flatMap((c) => c.inputs.map((i) => i.source_id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(2);
  });

  it("surfaces a feed that asks to be followed elsewhere, without following it", async () => {
    const xml = feedXml(1).replace(
      "<link>https://example.com</link>",
      "<link>https://example.com</link><itunes:new-feed-url>https://elsewhere.example/feed</itunes:new-feed-url>",
    );
    const h = harness({
      responses: { "https://feeds.example/show": [feedResponse(xml)] },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(
      h.activity.some(
        (a) =>
          a.severity === "action_required" && a.summary.includes("new address"),
      ),
    ).toBe(true);
    // Following an address a document hands you is an open redirect.
    expect(h.fetched.map((f) => f.url)).not.toContain(
      "https://elsewhere.example/feed",
    );
  });
});

/* ------------------------------------------------------------------ */
/* A checkpoint that outlived the rows it refers to                     */
/* ------------------------------------------------------------------ */

/** A first sweep that writes everything, so the ring is full and real. */
async function sweptOnce(
  opts: { etag?: string } = {},
): Promise<Record<string, unknown>> {
  const first = harness({
    responses: {
      "https://feeds.example/show": [
        feedResponse(
          feedXml(3),
          opts.etag === undefined ? {} : { headers: { etag: opts.etag } },
        ),
      ],
    },
  });
  await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);
  const carried: Record<string, unknown> = {};
  for (const [k, v] of first.store) carried[k] = v;
  return carried;
}

const REPORT = "remembers episodes the space no longer has";

function reports(activity: { summary: string }[]): { summary: string }[] {
  return activity.filter((a) => a.summary.includes(REPORT));
}

describe("a ring that remembers episodes the space does not have", () => {
  it("says so, and leaves the checkpoint alone", async () => {
    // The shape that swept hourly for three days and imported nothing. It
    // reports rather than repairing, because "no rows anywhere" cannot tell
    // rows that were lost from rows somebody deleted: a trashed item is
    // purged when its retention expires, and after that the two look the
    // same. Re-importing a catalog somebody deleted is the worse fault.
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const said = h.activity.filter((a) => a.summary.includes(REPORT));
    expect(said).toHaveLength(1);
    expect(said[0]?.severity).toBe("action_required");
    expect(said[0]?.detail).toMatchObject({ remembered: 3 });
    expect(said[0]?.detail?.remedy).toBe(
      "reinstall the connection to re-import the feed",
    );
    // Precise about what stops. A newly published episode is not in the ring
    // and imports normally; it is the back catalog that does not return.
    expect(said[0]?.summary).toContain("back catalog will not be re-imported");

    const last = feedCursors(h.cursorWrites).at(-1)?.value;
    expect(last?.recent_entry_ids).toHaveLength(3);
  });

  it("still says so when the feed answers 304", async () => {
    // The case a check further down would miss entirely. A feed that serves
    // an ETag answers 304 and the sweep returns before it looks at any
    // episode, so a stuck connection on such a feed would never be noticed.
    const carried = await sweptOnce({ etag: '"v1"' });
    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [feedResponse("", { status: 304 })],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(1);
    expect(h.bulkCalls).toHaveLength(0);
  });

  it("says it once, not every hour", async () => {
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(3)),
          feedResponse(feedXml(3)),
        ],
      },
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });
    await handler(h.ctx, MSG);
    await handler(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(1);
  });

  it("clears the marker when an episode lands, so a recurrence can report", async () => {
    // A write means the situation changed, so a later recurrence is a new
    // fact rather than the same one repeated. Against a real server the
    // second report needs a second loss event; the stub holds the space
    // empty throughout, which is what makes the cleared marker observable.
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(3)),
          feedResponse(feedXml(4)),
          feedResponse(feedXml(4)),
        ],
      },
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });
    await handler(h.ctx, MSG);
    expect(reports(h.activity)).toHaveLength(1);
    await handler(h.ctx, MSG);
    expect(h.bulkCalls.length).toBeGreaterThan(0);
    await handler(h.ctx, MSG);
    expect(reports(h.activity)).toHaveLength(2);
  });

  it("scopes the lookup to this show's own episodes", async () => {
    // An unscoped lookup would find another show's episodes and conclude
    // this one was fine, which would make the check silently useless.
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    // The literal scope the fixture declares, not merely something
    // scope-shaped: a regression using the wrong key would still match a
    // loose pattern.
    for (const q of h.listQueries) {
      expect(q.filter).toBe(
        'source_id starts_with "ep:11111111-2222-5333-8444-555555555555:"',
      );
      expect(q.limit).toBe(1);
    }
    // The whole sequence, not the distinct set of each column. A set would
    // be satisfied by asking one type for one state and the other for the
    // rest, which is not the same property.
    expect(
      h.listQueries.map((q) => `${q.type ?? ""}/${q.state ?? ""}`),
    ).toEqual([
      "marfa.podcast.episode/active",
      "marfa.podcast.episode/archived",
      "marfa.podcast.episode/trashed",
      "core.media.episode/active",
      "core.media.episode/archived",
      "core.media.episode/trashed",
    ]);
  });

  it("says nothing when the episodes are there", async () => {
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(0);
    // Stops at the first hit, so the ordinary case costs one lookup rather
    // than six.
    expect(h.listQueries).toHaveLength(1);
  });

  it("says nothing when the episodes are under the other write family", async () => {
    // `write_family` is configurable per connection and the ring does not
    // record which one wrote an entry, so a connection that switched has its
    // episodes under the other type. Checking only the current one would
    // tell somebody to reinstall a connection whose rows are right there.
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      writeFamily: "core",
      storedEpisodesByType: {
        "core.media.episode": { active: 0, archived: 0, trashed: 0 },
        "marfa.podcast.episode": { active: 3 },
      },
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(0);
    // The fall-through, asserted rather than assumed: the connection's own
    // family is asked first and comes back empty in all three states, and
    // the other family is what stops the check.
    expect(
      h.listQueries.map((q) => `${q.type ?? ""}/${q.state ?? ""}`),
    ).toEqual([
      "core.media.episode/active",
      "core.media.episode/archived",
      "core.media.episode/trashed",
      "marfa.podcast.episode/active",
    ]);
  });

  it("warns again after a lookup recovers and then fails once more", async () => {
    // The failure marker is cleared by the next lookup that succeeds, so a
    // second outage is a second fact rather than the same one suppressed.
    const carried = await sweptOnce();
    const failing = harness({
      cursors: carried,
      listItemsThrows: true,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: failing.fetchImpl })(failing.ctx, MSG);
    const afterFailure: Record<string, unknown> = {};
    for (const [k, v] of failing.store) afterFailure[k] = v;

    // A tick where the lookup works and finds the episodes.
    const healthy = harness({
      cursors: afterFailure,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: healthy.fetchImpl })(healthy.ctx, MSG);
    const afterRecovery: Record<string, unknown> = {};
    for (const [k, v] of healthy.store) afterRecovery[k] = v;

    const h = harness({
      cursors: afterRecovery,
      listItemsThrows: true,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(
      h.activity.filter((a) => a.summary.includes("could not check")),
    ).toHaveLength(1);
  });

  it("says nothing when the episodes were put in the trash", async () => {
    // Somebody who trashed a show's episodes still has them.
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      storedEpisodesByState: { active: 0, archived: 0, trashed: 3 },
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(0);
  });

  it("refuses an identifier too long to ask about, and says so", async () => {
    // Declared guids come from third-party XML. The filter grammar caps its
    // input, so a long enough one would throw on every tick forever.
    // Refused here instead, once, on its own marker.
    //
    // A backslash is deliberately not refused: the grammar escapes quotes
    // and consumes any other backslash literally, and the one shape it
    // cannot express is a value ending in one, which the trailing colon on
    // every prefix rules out.
    const enormous = "a".repeat(2100);
    const first = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(3, "ep", enormous)),
        ],
      },
    });
    await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);
    const carried: Record<string, unknown> = {};
    for (const [k, v] of first.store) carried[k] = v;

    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(3, "ep", enormous)),
        ],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    // No lookup attempted, and no false finding either.
    expect(h.listQueries).toHaveLength(0);
    expect(reports(h.activity)).toHaveLength(0);
    const refused = h.activity.filter((a) =>
      a.summary.includes("too long to ask about"),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.severity).toBe("warning");
  });

  it("asks about an identifier carrying quotes and backslashes", async () => {
    // The grammar consumes a backslash literally unless it precedes a
    // quote, so escaping quotes alone round-trips every value. Refusing on
    // a backslash, which an earlier revision did, would have switched the
    // detector off for any feed whose declared identifier contained one.
    const awkward = 'a\\b"c';
    const first = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3, "ep", awkward))],
      },
    });
    await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);
    const carried: Record<string, unknown> = {};
    for (const [k, v] of first.store) carried[k] = v;

    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3, "ep", awkward))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    // Asked about rather than refused, and the quote is escaped.
    expect(h.listQueries.length).toBeGreaterThan(0);
    expect(h.listQueries[0]?.filter).toContain('\\"');
    expect(reports(h.activity)).toHaveLength(1);
  });

  it("asks at the grammar's limit and refuses one character past it", async () => {
    // Pins the boundary rather than a number well clear of it. The cap the
    // grammar enforces is the one this checks against, imported rather than
    // copied, so the two cannot drift.
    const overhead = 'source_id starts_with "ep::"'.length;
    const exact = "a".repeat(MAX_FILTER_INPUT_LENGTH - overhead);

    for (const [guid, expectLookup] of [
      [exact, true],
      [exact + "a", false],
    ] as const) {
      const first = harness({
        responses: {
          "https://feeds.example/show": [feedResponse(feedXml(3, "ep", guid))],
        },
      });
      await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);
      const carried: Record<string, unknown> = {};
      for (const [k, v] of first.store) carried[k] = v;

      const h = harness({
        cursors: carried,
        storedEpisodes: 0,
        responses: {
          "https://feeds.example/show": [feedResponse(feedXml(3, "ep", guid))],
        },
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
      expect(h.listQueries.length > 0).toBe(expectLookup);
    }
  });

  it("still reports a finding after a lookup has failed once", async () => {
    // The two markers are separate on purpose. Sharing one meant a single
    // transient error suppressed the finding for the life of the cursor,
    // and on a feed that is genuinely stuck nothing ever clears it, because
    // the thing that clears it is an episode landing.
    const carried = await sweptOnce();
    const failing = harness({
      cursors: carried,
      listItemsThrows: true,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: failing.fetchImpl })(failing.ctx, MSG);
    expect(
      failing.activity.filter((a) => a.summary.includes("could not check")),
    ).toHaveLength(1);

    const afterwards: Record<string, unknown> = {};
    for (const [k, v] of failing.store) afterwards[k] = v;

    const h = harness({
      cursors: afterwards,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(1);
  });

  it("does not let a failed report wedge the rest of the connection", async () => {
    // The check runs before the fetch and before the index that rotates
    // feeds is advanced. A throw there would leave the same feed at the head
    // of the rotation forever, so every other feed on the connection would
    // stop being swept: a far worse failure than the one it detects.
    const one = "https://feeds.example/show";
    const two = "https://feeds.example/other";
    const seed = harness({
      feedUrls: [one, two],
      responses: {
        [one]: [feedResponse(feedXml(3))],
        [two]: [feedResponse(feedXml(2))],
      },
    });
    await createScheduleHandler({ fetch: seed.fetchImpl })(seed.ctx, MSG);
    const carried: Record<string, unknown> = {};
    for (const [k, v] of seed.store) carried[k] = v;

    const h = harness({
      cursors: carried,
      feedUrls: [one, two],
      storedEpisodes: 0,
      activityThrowsOn: (summary) => summary.includes(REPORT),
      responses: {
        [one]: [feedResponse(feedXml(3))],
        [two]: [feedResponse(feedXml(2))],
      },
    });
    const result = await createScheduleHandler({ fetch: h.fetchImpl })(
      h.ctx,
      MSG,
    );

    expect(result).toEqual({ ok: true });
    // Both feeds were fetched, so the throw on the first did not stop the
    // second.
    expect(new Set(h.fetched.map((f) => f.url))).toEqual(new Set([one, two]));
    // And the rotation index was written. That is the assertion that
    // distinguishes a wedge: the write happens after the sweep loop, so a
    // throw anywhere inside it leaves the index untouched and the same feed
    // at the head of the rotation next tick.
    expect(h.cursorWrites.filter((w) => w.key === "main")).not.toHaveLength(0);
  });

  it("retires the feeds when the last one is removed", async () => {
    // Emptying the configuration used to return before the retirement loop,
    // so every cursor stayed un-retired and orphaned from an index that no
    // longer named it. Adding the feeds back then gave a full ring with its
    // report marker intact and the detector silent, which is the outcome of
    // the most natural way anyone tries to reset a connection.
    // Seeded with the marker actually set, so the clear is observable
    // rather than asserting a value that was already null.
    const carried = await sweptOnce();
    const reported = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: reported.fetchImpl })(
      reported.ctx,
      MSG,
    );
    expect(reports(reported.activity)).toHaveLength(1);
    const marked: Record<string, unknown> = {};
    for (const [k, v] of reported.store) marked[k] = v;
    expect(
      feedCursors(reported.cursorWrites).at(-1)?.value
        .stale_checkpoint_reported_at,
    ).toBeTruthy();

    // Parked, so the progress stamp is set and the assertion below is not
    // trivially satisfied by a cursor that never had one.
    for (const [k, v] of Object.entries(marked)) {
      if (!k.includes("feed:")) continue;
      marked[k] = {
        ...(v as Record<string, unknown>),
        backfill_cursor: 1,
        last_progress_at: "2026-08-18T12:00:00.000Z",
        stuck_pass_reported_at: "2026-08-18T12:00:00.000Z",
      };
    }

    const h = harness({ cursors: marked, feedUrls: [], responses: {} });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const retired = feedCursors(h.cursorWrites).at(-1)?.value;
    expect(retired?.retired_at).toBeTruthy();
    expect(retired?.stale_checkpoint_reported_at).toBeNull();
    expect(retired?.checkpoint_lookup_failed_at).toBeNull();
    expect(retired?.stuck_pass_reported_at).toBeNull();
    // The progress stamp goes with the markers. State is kept, so a
    // re-added feed resumes its parked pass, and a stamp that counted the
    // period the feed was not being swept would call it stuck on its first
    // tick back and send it straight into a 304.
    expect(retired?.last_progress_at).toBeNull();
  });

  it("reports a lookup it could not perform, rather than going quiet", async () => {
    // A detector that switches itself off on an error is the failure this
    // whole check exists against, one level up.
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      listItemsThrows: true,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(0);
    const warned = h.activity.filter((a) =>
      a.summary.includes("could not check whether"),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]?.severity).toBe("warning");
  });
});

/* ------------------------------------------------------------------ */
/* The two acceptance claims nothing had ever run                      */
/* ------------------------------------------------------------------ */

describe("a feed is imported the same way twice", () => {
  it("writes nothing the second time when the feed has not changed", async () => {
    // Deliberately longer than the ring. At forty episodes the ring alone
    // makes this pass and the test says nothing about the drain boundary,
    // which is the mechanism that has to carry a real catalog.
    const episodes = RECENT_ID_RING_SIZE + 40;
    const first = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(episodes))],
      },
    });
    await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);
    const firstIds = first.bulkCalls.flatMap((c) =>
      c.inputs.map((i) => i.source_id),
    );
    expect(firstIds).toHaveLength(episodes);

    const carried: Record<string, unknown> = {};
    for (const [k, v] of first.store) carried[k] = v;

    const second = harness({
      cursors: carried,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(episodes))],
      },
    });
    await createScheduleHandler({ fetch: second.fetchImpl })(second.ctx, MSG);

    expect(second.bulkCalls).toHaveLength(0);
  });

  it("derives the same identities from the same feed with no memory of the first run", async () => {
    // The claim is that identity is a function of the feed, not of what a
    // previous run happened to record. A connection whose rows are gone and
    // whose cursors are gone with them has to arrive back at the same
    // source_ids, or reinstalling produces a second copy of a show.
    const run = async () => {
      const h = harness({
        responses: {
          "https://feeds.example/show": [feedResponse(feedXml(40))],
        },
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
      return h.bulkCalls.flatMap((c) =>
        c.inputs.map((i) => ({
          source_id: i.source_id,
          properties: i.properties,
        })),
      );
    };

    expect(await run()).toEqual(await run());
  });
});

describe("a feed larger than the ring", () => {
  /** Drive ticks until the feed stops offering work, or give up. */
  async function drain(episodes: number, maxTicks: number) {
    const xml = feedXml(episodes);
    const carried: Record<string, unknown> = {};
    const perTick: number[] = [];
    const everyId = new Set<string>();

    for (let tick = 0; tick < maxTicks; tick += 1) {
      const h = harness({
        cursors: carried,
        responses: { "https://feeds.example/show": [feedResponse(xml)] },
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
      for (const [k, v] of h.store) carried[k] = v;

      const written = h.bulkCalls.flatMap((c) =>
        c.inputs.map((i) => String(i.source_id)),
      );
      perTick.push(written.length);
      for (const id of written) everyId.add(id);
      if (written.length === 0) break;
    }
    return { perTick, distinct: everyId.size };
  }

  it("imports every episode across as many ticks as the budget needs", async () => {
    const episodes = MAX_EPISODES_PER_TICK * 2 + 137;
    const { perTick, distinct } = await drain(episodes, 8);

    expect(distinct).toBe(episodes);
    // Each tick spends its whole budget until the last one, which spends
    // what is left.
    expect(perTick.slice(0, 2)).toEqual([
      MAX_EPISODES_PER_TICK,
      MAX_EPISODES_PER_TICK,
    ]);
    expect(perTick[2]).toBe(137);
  });

  /** Drain a feed, then run one more tick against `nextXml`. */
  async function drainThenOneTick(episodes: number, nextXml: string) {
    const xml = feedXml(episodes);
    const carried: Record<string, unknown> = {};
    for (let tick = 0; tick < 8; tick += 1) {
      const h = harness({
        cursors: carried,
        responses: { "https://feeds.example/show": [feedResponse(xml)] },
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
      for (const [k, v] of h.store) carried[k] = v;
      if (h.bulkCalls.length === 0) break;
    }
    const after = harness({
      cursors: carried,
      responses: { "https://feeds.example/show": [feedResponse(nextXml)] },
    });
    await createScheduleHandler({ fetch: after.fetchImpl })(after.ctx, MSG);
    return after.bulkCalls.flatMap((c) =>
      c.inputs.map((i) => String(i.source_id)),
    );
  }

  it("keeps the drain boundary when a tick parses to nothing", async () => {
    // A momentarily empty channel is a transient. Treating it as a
    // completed drain of zero episodes would clear the boundary, and the
    // next good tick would full-walk the whole catalog.
    const episodes = RECENT_ID_RING_SIZE * 2;
    const xml = feedXml(episodes);
    const carried: Record<string, unknown> = {};
    for (let tick = 0; tick < 8; tick += 1) {
      const h = harness({
        cursors: carried,
        responses: { "https://feeds.example/show": [feedResponse(xml)] },
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
      for (const [k, v] of h.store) carried[k] = v;
      if (h.bulkCalls.length === 0) break;
    }

    const emptied = harness({
      cursors: carried,
      responses: { "https://feeds.example/show": [feedResponse(feedXml(0))] },
    });
    await createScheduleHandler({ fetch: emptied.fetchImpl })(emptied.ctx, MSG);
    for (const [k, v] of emptied.store) carried[k] = v;

    const back = harness({
      cursors: carried,
      responses: { "https://feeds.example/show": [feedResponse(xml)] },
    });
    await createScheduleHandler({ fetch: back.fetchImpl })(back.ctx, MSG);
    expect(back.bulkCalls).toHaveLength(0);
  });

  it("does not step over episodes when the feed loses one mid-drain", async () => {
    // The parked position is an index into a list rebuilt from the feed
    // every tick. A show deleting one old episode shifts every later index
    // down, so resuming at the stored number steps over exactly as many as
    // were removed. They were never written and are not in the ring, and
    // the boundary recorded at the end of the pass puts them out of reach.
    const episodes = MAX_EPISODES_PER_TICK + 40;
    const full = feedXml(episodes);
    // The oldest item is last in the document, and the first tick's budget
    // never reaches the newest, so removing the oldest shifts the parked
    // index.
    const lastItemAt = full.lastIndexOf("<item>");
    const shorter =
      full.slice(0, lastItemAt) +
      full.slice(full.indexOf("</item>", lastItemAt) + "</item>".length);

    const carried: Record<string, unknown> = {};
    const seen = new Set<string>();
    const bodies = [full, shorter, shorter, shorter];
    for (const body of bodies) {
      const h = harness({
        cursors: carried,
        responses: { "https://feeds.example/show": [feedResponse(body)] },
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
      for (const [k, v] of h.store) carried[k] = v;
      for (const c of h.bulkCalls)
        for (const i of c.inputs) seen.add(String(i.source_id));
    }

    // Every episode the shorter feed still carries was written. The one
    // the publisher removed is the only absence.
    for (let n = 2; n <= episodes; n += 1) {
      expect([...seen].some((id) => id.endsWith(`g:ep-${String(n)}`))).toBe(
        true,
      );
    }
  });

  it("converges when the anchor keeps disappearing underneath a parked drain", async () => {
    // The other way the list can shift under a parked position: a guid-less
    // feed whose publisher retitles or re-hosts an old item gives it a new
    // identity, so the episode the pass was standing on is simply gone.
    // Restarting the drain on that does not converge either, and it was
    // the leg left open when the insertion leg was fixed.
    const episodes = MAX_EPISODES_PER_TICK * 2 + 40;
    const carried: Record<string, unknown> = {};
    let settledAt: number | null = null;
    let parkedOn: number | null = null;
    for (let tick = 0; tick < 10; tick += 1) {
      // Re-identify exactly the episode the previous tick parked on, every
      // tick, which is what a publisher retitling old items looks like to
      // a guid-less feed. Anything narrower lets the drain walk past the
      // affected band and finish, which says nothing.
      let body = feedXml(episodes);
      if (parkedOn !== null) {
        // Candidates are oldest first, so index i is `ep-(i + 1)`.
        const at = `ep-${String(parkedOn + 1)}`;
        body = body.replace(`>${at}<`, `>${at}-r${String(tick)}<`);
      }
      const h = harness({
        cursors: carried,
        responses: { "https://feeds.example/show": [feedResponse(body)] },
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
      for (const [k, v] of h.store) carried[k] = v;

      const feedKey = String(
        Object.keys(carried).find((k) => k.includes("feed:")),
      );
      const stored = carried[feedKey] as { backfill_cursor: number | null };
      parkedOn = stored.backfill_cursor;
      if (stored.backfill_cursor === null && settledAt === null) {
        settledAt = tick;
      }
    }

    expect(settledAt).not.toBeNull();
  });

  it("converges when the feed keeps growing underneath a parked drain", async () => {
    // The drain follows its anchor rather than restarting, and this is
    // why. Restarting from the beginning on every insertion means a
    // publisher adding one older episode before each tick moves the anchor
    // again, the pass never completes, `backfill_cursor` never returns to
    // null, and the unconditional full-body fetch a parked pass performs
    // never stops. That is the oscillation the drain boundary exists to
    // eliminate, reached through a different door.
    const episodes = MAX_EPISODES_PER_TICK * 2 + 40;
    const carried: Record<string, unknown> = {};
    let extra = 0;
    let settledAt: number | null = null;
    const written = new Set<string>();
    for (let tick = 0; tick < 10; tick += 1) {
      // One more archive item at the oldest end before every tick.
      extra += 1;
      let body = feedXml(episodes);
      for (let n = 1; n <= extra; n += 1) {
        body = body.replace(
          "</channel>",
          `<item><title>Archive ${String(n)}</title><guid isPermaLink="false">arc-${String(n)}</guid>
           <pubDate>Mon, 01 Jan 1990 00:00:00 +0000</pubDate>
           <enclosure url="https://cdn.example/arc-${String(n)}.mp3" type="audio/mpeg" length="1"/></item></channel>`,
        );
      }
      const h = harness({
        cursors: carried,
        responses: { "https://feeds.example/show": [feedResponse(body)] },
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
      for (const [k, v] of h.store) carried[k] = v;
      for (const c of h.bulkCalls)
        for (const i of c.inputs) written.add(String(i.source_id));

      const feedKey = String(
        Object.keys(carried).find((k) => k.includes("feed:")),
      );
      const stored = carried[feedKey] as { backfill_cursor: number | null };
      if (stored.backfill_cursor === null && settledAt === null) {
        settledAt = tick;
      }
    }

    // It parks, follows its anchor, and finishes. Restarting on every
    // insertion never reaches this.
    expect(settledAt).not.toBeNull();
    // And nothing inserted was lost on the way: the walk a pass owes after
    // an insertion is what picks them up.
    for (let n = 1; n <= extra; n += 1) {
      expect([...written].some((id) => id.includes(`arc-${String(n)}`))).toBe(
        true,
      );
    }
  });

  it("does not step over an episode inserted below a parked position", async () => {
    // The anchor says where the parked position went. Moved down, episodes
    // were removed before it and everything up to it was still drained.
    // Moved up, episodes were inserted below it, which is a show uploading
    // its back catalog mid-drain: following the anchor steps over exactly
    // those, and they are not in the ring because they were never offered.
    const episodes = MAX_EPISODES_PER_TICK + 40;
    const full = feedXml(episodes);
    // An archive item at the oldest end, which is the end of the document.
    const withArchive = full.replace(
      "</channel>",
      `<item><title>Archive</title><guid isPermaLink="false">ep-archive</guid>
       <pubDate>Mon, 01 Jan 1990 00:00:00 +0000</pubDate>
       <enclosure url="https://cdn.example/archive.mp3" type="audio/mpeg" length="1"/></item></channel>`,
    );

    const carried: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const body of [full, withArchive, withArchive, withArchive]) {
      const h = harness({
        cursors: carried,
        responses: { "https://feeds.example/show": [feedResponse(body)] },
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
      for (const [k, v] of h.store) carried[k] = v;
      for (const c of h.bulkCalls)
        for (const i of c.inputs) seen.add(String(i.source_id));
    }

    expect([...seen].some((id) => id.includes("ep-archive"))).toBe(true);
  });

  it("imports only the new episode when a drained feed publishes one", async () => {
    const episodes = RECENT_ID_RING_SIZE * 2;
    const written = await drainThenOneTick(episodes, feedXml(episodes + 1));
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(`ep-${String(episodes + 1)}`);
  });

  it("walks the whole feed again when an episode appears behind the boundary", async () => {
    // A show uploading its back catalog inserts episodes older than
    // everything already imported. Resuming past the boundary would skip
    // exactly those, so the count check sends this down the full walk.
    const episodes = RECENT_ID_RING_SIZE * 2;
    const older = feedXml(episodes).replace(
      "</channel>",
      `<item><title>Archive</title><guid isPermaLink="false">ep-archive</guid>
       <pubDate>Mon, 01 Jan 1990 00:00:00 +0000</pubDate>
       <enclosure url="https://cdn.example/archive.mp3" type="audio/mpeg" length="1"/></item></channel>`,
    );
    const written = await drainThenOneTick(episodes, older);
    expect(written.some((id) => id.includes("ep-archive"))).toBe(true);
  });

  it("walks the whole feed again when the boundary episode is gone", async () => {
    const episodes = RECENT_ID_RING_SIZE * 2;
    // Same episodes, different identities: nothing to anchor to, and
    // nothing in the ring either, so the whole feed is offered again up to
    // one tick's budget rather than a token amount of it.
    const reidentified = feedXml(episodes, "regen");
    const written = await drainThenOneTick(episodes, reidentified);
    expect(written).toHaveLength(Math.min(episodes, MAX_EPISODES_PER_TICK));
    expect(written.every((id) => id.includes("regen"))).toBe(true);
  });

  it("settles a rolling window rather than re-walking it every tick", async () => {
    // The shape most likely to be long and least likely to be append-only:
    // a host publishing a fixed recent window drops its oldest as it adds
    // its newest. Every tick sees fewer episodes standing before the
    // boundary than the drain recorded, and reading that as a change would
    // full-walk forever, which is the defect this exists to fix.
    const episodes = RECENT_ID_RING_SIZE * 2;
    // Feeds are written newest first, so the oldest item is the last one
    // in the document. Dropping it from a feed one longer than the drained
    // one leaves the same length with one new at the top and one gone from
    // the bottom, which is what a rolling window looks like on the wire.
    const longer = feedXml(episodes + 1);
    const lastItemAt = longer.lastIndexOf("<item>");
    const rolled =
      longer.slice(0, lastItemAt) +
      longer.slice(longer.indexOf("</item>", lastItemAt) + "</item>".length);
    const written = await drainThenOneTick(episodes, rolled);
    // One new episode arrived and one old one left. Only the new one is
    // written; nothing before the boundary is offered again.
    expect(written).toHaveLength(1);
  });

  it("settles once the feed is drained rather than rewriting its back catalog", async () => {
    // The ring remembers the last RECENT_ID_RING_SIZE episodes and the
    // backfill cursor is cleared when a drain completes, so the next tick
    // walks the whole feed with only the tail remembered. On a feed longer
    // than the ring that offers everything older than the tail again, every
    // tick, forever: a settled subscription reporting hundreds of writes an
    // hour and a host asked to serve a feed nobody needed.
    const episodes = RECENT_ID_RING_SIZE * 2;
    const { perTick } = await drain(episodes, 6);

    const afterDrain = perTick.slice(
      perTick.findIndex((n, i) => i > 0 && n < MAX_EPISODES_PER_TICK) + 1,
    );
    expect(afterDrain[0] ?? 0).toBe(0);
  });
});
