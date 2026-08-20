/**
 * Handler-level tests for the Google YouTube (Data API v3) integration.
 *
 * Coverage:
 *   - Cold-start sweep: empty cursor -> channels.list?mine=true resolves
 *     the liked-playlist id; likes, subscriptions, and playlists are
 *     fetched; items + edges asserted; cursor populated.
 *   - Incremental sweep with no new items: watermarks unchanged.
 *   - Batch-of-50 boundary: 75 liked videos -> two videos.list calls.
 *   - materialise_playlists=true smoke: walked playlist authors
 *     playlist parent-of video edges.
 *   - Quota-exceeded path: quotaExceeded -> action_required + ok:true.
 *   - Skip-on-unchanged playlist (etag matches cursor) -> no walk.
 */
import { describe, it, expect } from "vitest";
import {
  createCursorStore,
  createActivitySink,
  createEchoSuppression,
  type ConnectionContext,
  type ConnectionClient,
  type CreateItemInput,
  type ItemResource,
  type ItemState,
  type ScheduleMessage,
  familyOnlyMappingResolver,
} from "@withmarfa/runtime-sdk";
import { handleSchedule } from "./handlers.js";
import { GOOGLE_YOUTUBE_MANIFEST } from "./manifest.js";

interface InMemoryStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

function memStorage(): InMemoryStorage {
  const d = new Map<string, unknown>();
  return {
    get: (k) => Promise.resolve(d.get(k)),
    put: (k, v) => {
      d.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => Promise.resolve(d.delete(k)),
  };
}

interface Route {
  match: (path: string) => boolean;
  respond: (path: string, callCount: number) => Response;
}

interface BuildOpts {
  connectionRecord?: Partial<ItemResource>;
  routes: Route[];
  /** Steer ensureEdge outcomes; default resolves "created". Throw to
   *  simulate a real refusal. */
  edgeResponder?: (input: {
    source_id: string;
    target_id: string;
    edge_type: string;
  }) => Promise<"created" | "exists">;
}

interface BuiltState {
  ctx: ConnectionContext;
  created: CreateItemInput[];
  updated: { id: string; patch: Partial<CreateItemInput> }[];
  edges: { source_id: string; target_id: string; edge_type: string }[];
  emitted: { type: string; properties?: Record<string, unknown> }[];
  proxyCalls: { method: string; path: string }[];
}

const CONNECTION_ID = "conn_youtube_test";

function buildContext(opts: BuildOpts): BuiltState {
  const storage = memStorage();
  const created: CreateItemInput[] = [];
  const updated: { id: string; patch: Partial<CreateItemInput> }[] = [];
  const edges: {
    source_id: string;
    target_id: string;
    edge_type: string;
  }[] = [];
  const emitted: { type: string; properties?: Record<string, unknown> }[] = [];
  const proxyCalls: { method: string; path: string }[] = [];
  const callCountByMatcherIdx = new Map<number, number>();

  const client = {
    createItem: (input: CreateItemInput) => {
      if (input.type === "system.activity") {
        emitted.push({ type: input.type, properties: input.properties });
        return Promise.resolve({ id: "act_x", type: input.type });
      }
      created.push(input);
      return Promise.resolve({
        id: `mit_${String(created.length)}`,
        type: input.type,
      });
    },
    updateItem: (id: string, patch: Partial<CreateItemInput>) => {
      updated.push({ id, patch });
      return Promise.resolve({ id, type: "google.youtube.video" });
    },
    getItem: (id: string) => {
      if (id === CONNECTION_ID) {
        return Promise.resolve(opts.connectionRecord ?? null);
      }
      return Promise.resolve(null);
    },
    transitionItem: (id: string, to: ItemState) =>
      Promise.resolve({ id, type: "google.youtube.video", state: to }),
    proxyRequest: (method: string, path: string) => {
      proxyCalls.push({ method, path });
      for (let i = 0; i < opts.routes.length; i++) {
        const r = opts.routes[i];
        if (r?.match(path)) {
          const c = (callCountByMatcherIdx.get(i) ?? 0) + 1;
          callCountByMatcherIdx.set(i, c);
          return Promise.resolve(r.respond(path, c));
        }
      }
      return Promise.resolve(
        new Response(`no route for ${path}`, { status: 500 }),
      );
    },
    createEdge: (input: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }) => {
      edges.push(input);
      return Promise.resolve({ id: `edg_${String(edges.length)}` });
    },
    ensureEdge: (input: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }) => {
      edges.push(input);
      if (opts.edgeResponder) return opts.edgeResponder(input);
      return Promise.resolve("created" as const);
    },
  } as unknown as ConnectionClient;

  const ctx: ConnectionContext = {
    connection_id: CONNECTION_ID,
    integration_name: GOOGLE_YOUTUBE_MANIFEST.name,
    marfa: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, CONNECTION_ID),
    echo: createEchoSuppression(storage, {
      echo_ttl_seconds: 1,
      lag_window_seconds: 1,
    }),
    mapping: familyOnlyMappingResolver(),
    cycle: null,
  };
  return { ctx, created, updated, edges, emitted, proxyCalls };
}

const SCHEDULE_MSG = (): ScheduleMessage => ({
  kind: "schedule",
  integration_name: GOOGLE_YOUTUBE_MANIFEST.name,
  connection_id: CONNECTION_ID,
  scheduled_for_ms: Date.now(),
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function emptyList(): Response {
  return jsonResponse({ items: [] });
}

// Baseline routes — empty defaults; tests prepend overrides.
function baselineRoutes(): Route[] {
  return [
    {
      match: (p) => p.includes("/channels?") && p.includes("mine=true"),
      respond: () =>
        jsonResponse({
          items: [
            {
              id: "UC_owner",
              etag: "etag-owner",
              snippet: { title: "Connected User Channel" },
              contentDetails: {
                relatedPlaylists: { likes: "LL_owner" },
              },
            },
          ],
        }),
    },
    {
      match: (p) => p.includes("/channels?") && p.includes("id="),
      respond: (path) => {
        const m = /id=([^&]+)/.exec(path);
        const cid = m?.[1] ?? "UC_unknown";
        return jsonResponse({
          items: [
            {
              id: cid,
              etag: `etag-${cid}`,
              snippet: { title: `Channel ${cid}` },
            },
          ],
        });
      },
    },
    {
      match: (p) => p.includes("/playlistItems?"),
      respond: () => emptyList(),
    },
    {
      match: (p) => p.includes("/subscriptions?"),
      respond: () => emptyList(),
    },
    {
      match: (p) => p.includes("/playlists?"),
      respond: () => emptyList(),
    },
    {
      match: (p) => p.includes("/videos?"),
      respond: () => emptyList(),
    },
  ];
}

function withOverrides(...overrides: Route[]): Route[] {
  return [...overrides, ...baselineRoutes()];
}

// ---------------------------------------------------------------------------

describe("google-youtube handleSchedule", () => {
  it("cold-start: resolves liked-playlist id, fetches likes/subs/playlists, populates cursor + edges", async () => {
    const likedPlaylistItems = {
      items: [
        {
          id: "PLI_1",
          snippet: {
            publishedAt: "2026-05-23T12:00:00Z",
            resourceId: { kind: "youtube#video", videoId: "V_abc" },
          },
          contentDetails: { videoId: "V_abc" },
        },
        {
          id: "PLI_2",
          snippet: {
            publishedAt: "2026-05-22T09:00:00Z",
            resourceId: { kind: "youtube#video", videoId: "V_def" },
          },
          contentDetails: { videoId: "V_def" },
        },
      ],
    };
    const videosHydrated = {
      items: [
        {
          id: "V_abc",
          etag: "etag-v-abc",
          snippet: {
            title: "Rust talk",
            description: "Excellent.",
            channelId: "UC_rust",
            channelTitle: "Rust Lang",
            publishedAt: "2026-05-01T00:00:00Z",
            tags: ["rust"],
            thumbnails: { high: { url: "https://i.example/v_abc.jpg" } },
          },
          contentDetails: { duration: "PT12M3S" },
          statistics: { viewCount: "1234", likeCount: "100" },
        },
        {
          id: "V_def",
          etag: "etag-v-def",
          snippet: {
            title: "Pasta tips",
            channelId: "UC_food",
            channelTitle: "Food Channel",
            publishedAt: "2026-05-02T00:00:00Z",
          },
        },
      ],
    };
    const subscriptions = {
      items: [
        {
          id: "SUB_1",
          snippet: {
            title: "Rust Lang",
            resourceId: { kind: "youtube#channel", channelId: "UC_rust" },
          },
          subscriberSnippet: { subscribedAt: "2026-04-01T00:00:00Z" },
        },
      ],
    };
    const playlists = {
      items: [
        {
          id: "PL_user_1",
          etag: "etag-pl-1",
          snippet: {
            title: "Watch Later (custom)",
            channelId: "UC_owner",
            publishedAt: "2026-01-01T00:00:00Z",
          },
          contentDetails: { itemCount: 7 },
          status: { privacyStatus: "private" },
        },
      ],
    };

    const { ctx, created, edges, emitted, proxyCalls } = buildContext({
      routes: withOverrides(
        {
          match: (p) =>
            p.includes("/playlistItems?") && p.includes("playlistId=LL_owner"),
          respond: () => jsonResponse(likedPlaylistItems),
        },
        {
          match: (p) => p.includes("/videos?"),
          respond: () => jsonResponse(videosHydrated),
        },
        {
          // subscriptions.list must NOT carry `order=` — YouTube Data
          // API v3 only accepts `alphabetical|relevance|unread` and
          // rejects everything else (`order=newest` → 400). Matcher
          // asserts the param is absent; a regression that re-adds it
          // falls through to the no-route 500.
          match: (p) => p.includes("/subscriptions?") && !p.includes("order="),
          respond: () => jsonResponse(subscriptions),
        },
        {
          match: (p) => p.includes("/playlists?") && p.includes("mine=true"),
          respond: () => jsonResponse(playlists),
        },
      ),
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });

    expect(proxyCalls[0]?.path).toContain("/channels?");
    expect(proxyCalls[0]?.path).toContain("mine=true");

    const videos = created.filter((c) => c.type === "google.youtube.video");
    expect(videos).toHaveLength(2);
    expect(videos[0]?.properties).toMatchObject({
      video_id: "V_abc",
      title: "Rust talk",
      channel_id: "UC_rust",
      liked_at: "2026-05-23T12:00:00Z",
      duration_iso8601: "PT12M3S",
      view_count: 1234,
      like_count: 100,
      tags: ["rust"],
      thumbnail_url: "https://i.example/v_abc.jpg",
      html_link: "https://www.youtube.com/watch?v=V_abc",
    });

    const channels = created.filter((c) => c.type === "google.youtube.channel");
    const channelIds = channels.map((c) => c.properties?.channel_id);
    expect(new Set(channelIds)).toEqual(
      new Set(["UC_rust", "UC_food", "UC_owner"]),
    );

    const playlistItems = created.filter(
      (c) => c.type === "google.youtube.playlist",
    );
    expect(playlistItems).toHaveLength(1);
    expect(playlistItems[0]?.properties).toMatchObject({
      playlist_id: "PL_user_1",
      title: "Watch Later (custom)",
      item_count: 7,
      privacy_status: "private",
      etag: "etag-pl-1",
    });

    const parentOfs = edges.filter((e) => e.edge_type === "parent-of");
    expect(parentOfs.length).toBeGreaterThanOrEqual(3);

    const cursor = (await ctx.cursor.read("main")) as {
      seeded: boolean;
      liked_playlist_id: string | null;
      latest_liked_at: string | null;
      latest_subscribed_at: string | null;
      playlist_etags: Record<string, string>;
      mappings: {
        videos: Record<string, string>;
        channels: Record<string, string>;
        playlists: Record<string, string>;
      };
    };
    expect(cursor.seeded).toBe(true);
    expect(cursor.liked_playlist_id).toBe("LL_owner");
    expect(cursor.latest_liked_at).toBe("2026-05-23T12:00:00Z");
    expect(cursor.latest_subscribed_at).toBe("2026-04-01T00:00:00Z");
    expect(cursor.playlist_etags.PL_user_1).toBe("etag-pl-1");
    expect(cursor.mappings.videos.V_abc).toBeDefined();
    expect(cursor.mappings.videos.V_def).toBeDefined();
    expect(cursor.mappings.playlists.PL_user_1).toBeDefined();

    const last = emitted.at(-1);
    expect(
      (last?.properties as { summary?: string } | undefined)?.summary ?? "",
    ).toContain("google-youtube inbound");
  });

  it("incremental sweep with no new items: zero upserts, watermarks unchanged", async () => {
    const { ctx, created, edges } = buildContext({
      routes: withOverrides(),
    });
    await ctx.cursor.write("main", {
      seeded: true,
      liked_playlist_id: "LL_owner",
      latest_liked_at: "2030-01-01T00:00:00Z",
      latest_subscribed_at: "2030-01-01T00:00:00Z",
      playlist_etags: {},
      mappings: { videos: {}, channels: {}, playlists: {} },
      last_inbound_at: null,
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });

    const nonActivity = created.filter((c) => c.type !== "system.activity");
    expect(nonActivity).toHaveLength(0);
    expect(edges).toHaveLength(0);

    const cursor = (await ctx.cursor.read("main")) as {
      latest_liked_at: string;
      latest_subscribed_at: string;
    };
    expect(cursor.latest_liked_at).toBe("2030-01-01T00:00:00Z");
    expect(cursor.latest_subscribed_at).toBe("2030-01-01T00:00:00Z");
  });

  it("batch-of-50 boundary: 75 liked videos -> two videos.list calls (50 + 25)", async () => {
    const likedItems = Array.from({ length: 75 }, (_, i) => ({
      id: `PLI_${String(i)}`,
      snippet: {
        publishedAt: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        resourceId: { kind: "youtube#video", videoId: `V_${String(i)}` },
      },
      contentDetails: { videoId: `V_${String(i)}` },
    }));

    const { ctx, proxyCalls } = buildContext({
      routes: withOverrides(
        {
          match: (p) =>
            p.includes("/playlistItems?") && p.includes("playlistId=LL_owner"),
          respond: () => jsonResponse({ items: likedItems }),
        },
        {
          match: (p) => p.includes("/videos?"),
          respond: (path) => {
            const m = /id=([^&]+)/.exec(path);
            const csv = m?.[1] ?? "";
            const ids = decodeURIComponent(csv).split(",");
            return jsonResponse({
              items: ids.map((id) => ({
                id,
                snippet: { title: `Video ${id}`, channelId: "UC_x" },
              })),
            });
          },
        },
      ),
    });

    await handleSchedule(ctx, SCHEDULE_MSG());

    const videosCalls = proxyCalls.filter((c) => c.path.includes("/videos?"));
    expect(videosCalls).toHaveLength(2);
    const csv1 = /id=([^&]+)/.exec(videosCalls[0]?.path ?? "")?.[1] ?? "";
    const csv2 = /id=([^&]+)/.exec(videosCalls[1]?.path ?? "")?.[1] ?? "";
    expect(decodeURIComponent(csv1).split(",")).toHaveLength(50);
    expect(decodeURIComponent(csv2).split(",")).toHaveLength(25);
  });

  it("materialise_playlists=true: walks playlist videos + authors playlist parent-of video edges", async () => {
    const playlists = {
      items: [
        {
          id: "PL_mat",
          etag: "etag-pl-mat",
          snippet: {
            title: "Materialized",
            channelId: "UC_owner",
          },
          contentDetails: { itemCount: 2 },
          status: { privacyStatus: "public" },
        },
      ],
    };
    const playlistItemsMat = {
      items: [
        {
          id: "PLI_m1",
          snippet: {
            publishedAt: "2026-05-22T00:00:00Z",
            resourceId: { kind: "youtube#video", videoId: "V_m1" },
          },
          contentDetails: { videoId: "V_m1" },
        },
        {
          id: "PLI_m2",
          snippet: {
            publishedAt: "2026-05-21T00:00:00Z",
            resourceId: { kind: "youtube#video", videoId: "V_m2" },
          },
          contentDetails: { videoId: "V_m2" },
        },
      ],
    };
    const videos = {
      items: [
        {
          id: "V_m1",
          snippet: { title: "Mat 1", channelId: "UC_owner" },
        },
        {
          id: "V_m2",
          snippet: { title: "Mat 2", channelId: "UC_owner" },
        },
      ],
    };

    const { ctx, created, edges } = buildContext({
      connectionRecord: {
        properties: { configuration: { materialise_playlists: true } },
      },
      routes: withOverrides(
        {
          match: (p) => p.includes("/playlists?") && p.includes("mine=true"),
          respond: () => jsonResponse(playlists),
        },
        {
          match: (p) =>
            p.includes("/playlistItems?") && p.includes("playlistId=PL_mat"),
          respond: () => jsonResponse(playlistItemsMat),
        },
        {
          match: (p) => p.includes("/videos?"),
          respond: () => jsonResponse(videos),
        },
      ),
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });

    const videoItems = created.filter((c) => c.type === "google.youtube.video");
    const titles = videoItems.map((v) => v.properties?.title);
    expect(titles).toEqual(expect.arrayContaining(["Mat 1", "Mat 2"]));

    const playlistIdx = created.findIndex(
      (c) => c.type === "google.youtube.playlist",
    );
    expect(playlistIdx).toBeGreaterThanOrEqual(0);
    const playlistMarfaId = `mit_${String(playlistIdx + 1)}`;
    const playlistEdges = edges.filter(
      (e) => e.source_id === playlistMarfaId && e.edge_type === "parent-of",
    );
    expect(playlistEdges.length).toBeGreaterThanOrEqual(2);
  });

  // One liked video with a channel: the minimal sweep that attempts an edge.
  function oneLikedVideoRoutes(): Route[] {
    return withOverrides(
      {
        match: (p) =>
          p.includes("/playlistItems?") && p.includes("playlistId=LL_owner"),
        respond: () =>
          jsonResponse({
            items: [
              {
                id: "PLI_e1",
                snippet: {
                  publishedAt: "2026-05-23T12:00:00Z",
                  resourceId: { kind: "youtube#video", videoId: "V_edge" },
                },
                contentDetails: { videoId: "V_edge" },
              },
            ],
          }),
      },
      {
        match: (p) => p.includes("/videos?"),
        respond: () =>
          jsonResponse({
            items: [
              {
                id: "V_edge",
                snippet: { title: "Edge case", channelId: "UC_owner" },
              },
            ],
          }),
      },
    );
  }

  it("an already-existing edge is quiet: no action_required, not counted as created", async () => {
    const { ctx, emitted, edges } = buildContext({
      routes: oneLikedVideoRoutes(),
      edgeResponder: () => Promise.resolve("exists"),
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(edges.length).toBeGreaterThan(0);

    const actionRequired = emitted.filter(
      (e) => e.properties?.severity === "action_required",
    );
    expect(actionRequired).toHaveLength(0);

    const summary = emitted.find((e) =>
      ((e.properties?.summary as string | undefined) ?? "").includes(
        "google-youtube inbound",
      ),
    );
    expect(summary?.properties?.severity).toBe("info");
    const detail = summary?.properties?.detail as
      | Record<string, unknown>
      | undefined;
    expect(detail?.edges_created).toBe(0);
    expect(detail?.edges_refused).toBe(0);
  });

  it("a real edge refusal is reported and counted, never swallowed", async () => {
    const { ctx, emitted } = buildContext({
      routes: oneLikedVideoRoutes(),
      edgeResponder: () =>
        Promise.reject(
          new Error(
            'Marfa API 400 Bad Request POST /edges: {"error":{"code":"edge_constraint_violation","message":"Edge \\"parent-of\\" is one-to-many on the target side","details":{"constraint":"cardinality"}}}',
          ),
        ),
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });

    const refusalRows = emitted.filter(
      (e) =>
        e.properties?.severity === "action_required" &&
        ((e.properties.summary as string | undefined) ?? "").includes(
          "failed to create parent-of edge",
        ),
    );
    expect(refusalRows.length).toBeGreaterThan(0);
    const detail = refusalRows[0]?.properties?.detail as
      | Record<string, unknown>
      | undefined;
    expect((detail?.error as string | undefined) ?? "").toContain(
      "one-to-many",
    );

    const summary = emitted.find((e) =>
      ((e.properties?.summary as string | undefined) ?? "").includes(
        "google-youtube inbound",
      ),
    );
    expect(summary?.properties?.severity).toBe("warning");
    const summaryDetail = summary?.properties?.detail as
      | Record<string, unknown>
      | undefined;
    expect(Number(summaryDetail?.edges_refused)).toBeGreaterThan(0);
  });

  it("quota-exceeded: 403 quotaExceeded surfaces as action_required activity + ok:true", async () => {
    const { ctx, emitted } = buildContext({
      routes: [
        {
          match: () => true,
          respond: () =>
            new Response(
              JSON.stringify({
                error: {
                  message:
                    "The request cannot be completed because you have exceeded your quota.",
                  errors: [{ reason: "quotaExceeded" }],
                },
              }),
              { status: 403 },
            ),
        },
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });

    const summaries = emitted.map(
      (e) => (e.properties as { summary?: string } | undefined)?.summary ?? "",
    );
    expect(summaries.some((s) => s.includes("quota"))).toBe(true);
    expect(
      emitted.some(
        (e) =>
          (e.properties as { severity?: string } | undefined)?.severity ===
          "action_required",
      ),
    ).toBe(true);
  });

  it("skip-on-unchanged playlist: etag matches cursor -> no per-playlist video walk", async () => {
    const playlists = {
      items: [
        {
          id: "PL_unchanged",
          etag: "etag-stable",
          snippet: { title: "Same", channelId: "UC_owner" },
          contentDetails: { itemCount: 3 },
          status: { privacyStatus: "public" },
        },
      ],
    };

    const { ctx, proxyCalls } = buildContext({
      connectionRecord: {
        properties: { configuration: { materialise_playlists: true } },
      },
      routes: withOverrides({
        match: (p) => p.includes("/playlists?") && p.includes("mine=true"),
        respond: () => jsonResponse(playlists),
      }),
    });
    await ctx.cursor.write("main", {
      seeded: true,
      liked_playlist_id: "LL_owner",
      latest_liked_at: "2030-01-01T00:00:00Z",
      latest_subscribed_at: "2030-01-01T00:00:00Z",
      playlist_etags: { PL_unchanged: "etag-stable" },
      mappings: {
        videos: {},
        channels: {},
        playlists: { PL_unchanged: "mit_preexisting" },
      },
      last_inbound_at: null,
    });

    await handleSchedule(ctx, SCHEDULE_MSG());

    const walked = proxyCalls.filter((c) =>
      c.path.includes("playlistId=PL_unchanged"),
    );
    expect(walked).toHaveLength(0);
  });
});
