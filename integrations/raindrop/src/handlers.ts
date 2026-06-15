/**
 * Raindrop inbound handler.
 *
 * Single trigger: SCHEDULE (10-minute REST API sweep).
 *
 * Cursor:
 *   {
 *     last_created_at: string | null,            // ISO timestamp watermark
 *     raindrop_mappings: Record<raindrop_id, marfa_id>,
 *     collection_mappings: Record<collection_id, marfa_id>,
 *     last_collection_sweep_at: string | null,
 *     last_inbound_at: string | null
 *   }
 *
 * Flow:
 *   1. Read cursor (defaults on first run).
 *   2. Collections sweep: GET /rest/v1/collections + GET
 *      /rest/v1/collections/childrens (small data; full sweep every
 *      cycle). Upsert each as `raindrop.collection`; wire parent-of
 *      edges between nested collections.
 *   3. Raindrops sweep: GET /rest/v1/raindrops/0?sort=-created&
 *      perpage=50&nested=true&page=<N>. For each page, break when the
 *      oldest item's `created` is before `cursor.last_created_at`.
 *      Upsert each as `raindrop.raindrop`; wire parent-of edge from
 *      the parent collection (resolved via cursor.collection_mappings).
 *   4. Advance `cursor.last_created_at` to the max `created` seen
 *      this sweep.
 *
 * Read-only on existing data; the manifest's `tombstone_mapping:
 * "ignore"` keeps Raindrop-side deletes out of Marfa trash. The
 * harness asserts only GETs reach Raindrop except CREATEs on the
 * synthetic `Marfa Validation` collection.
 */
import {
  registerScheduleHandler,
  type ConnectionContext,
  type ScheduleMessage,
  type HandlerResult,
  type CreateItemInput,
} from "@withmarfa/runtime-sdk";
import {
  COLLECTIONS_PATH,
  COLLECTION_CHILDREN_PATH,
  ALL_RAINDROPS_PATH,
} from "./manifest.js";

const CURSOR_KEY = "main";
/** Page size for the raindrops sweep — Raindrop's max is 50 per page. */
const RAINDROPS_PERPAGE = 50;
/** Safety brake — Raindrop accounts rarely run deep. */
const MAX_PAGES = 100;

interface RaindropMedia {
  link?: string;
  type?: string;
}

interface RaindropCollectionRest {
  _id?: number;
  /** Sometimes returned as { $id: number } on nested collection refs;
   *  the top-level GET returns a flat `_id`. */
  $id?: number;
  title?: string;
  slug?: string;
  parent?: { $id?: number } | null;
  count?: number;
  cover?: string[] | string | null;
  expanded?: boolean;
  view?: string;
  color?: string;
  public?: boolean;
  created?: string;
  lastUpdate?: string;
}

interface RaindropRest {
  _id: number;
  title?: string;
  excerpt?: string;
  note?: string;
  link?: string;
  domain?: string;
  cover?: string | null;
  type?: string;
  tags?: string[];
  created?: string;
  lastUpdate?: string;
  important?: boolean;
  collection?: { $id?: number };
  collectionId?: number;
  media?: RaindropMedia[];
}

interface CollectionsResponse {
  items?: RaindropCollectionRest[];
}

interface RaindropsListResponse {
  result?: boolean;
  count?: number;
  items?: RaindropRest[];
}

interface RaindropCursor {
  /** ISO timestamp watermark on `created`. Newer than this gets
   *  pulled; anything older was either captured in a previous sweep
   *  or pre-dates the integration's install. */
  last_created_at: string | null;
  /** Raindrop _id (as string) → Marfa item id. */
  raindrop_mappings: Record<string, string>;
  /** Collection _id (as string) → Marfa item id. */
  collection_mappings: Record<string, string>;
  /** Diagnostic. */
  last_collection_sweep_at: string | null;
  /** Diagnostic. */
  last_inbound_at: string | null;
}

function defaultCursor(): RaindropCursor {
  return {
    last_created_at: null,
    raindrop_mappings: {},
    collection_mappings: {},
    last_collection_sweep_at: null,
    last_inbound_at: null,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Field translation
// ---------------------------------------------------------------------------

function buildCollectionInput(c: RaindropCollectionRest): CreateItemInput {
  const props: Record<string, unknown> = {
    title: c.title ?? "(untitled collection)",
  };
  if (c.slug !== undefined && c.slug !== "") props.slug = c.slug;
  const parentId =
    typeof c.parent === "object" && c.parent !== null
      ? c.parent.$id
      : undefined;
  if (typeof parentId === "number") {
    props.parent_id = String(parentId);
  }
  if (typeof c.count === "number") props.count = c.count;
  // Raindrop sometimes ships `cover` as an array of strings, sometimes a
  // single string. Normalize to the first non-empty entry.
  if (Array.isArray(c.cover)) {
    const first = c.cover.find((u) => typeof u === "string" && u.length > 0);
    if (first !== undefined) props.cover = first;
  } else if (typeof c.cover === "string" && c.cover.length > 0) {
    props.cover = c.cover;
  }
  if (typeof c.expanded === "boolean") props.expanded = c.expanded;
  if (typeof c.view === "string" && c.view.length > 0) {
    props.view = c.view;
  }
  if (typeof c.color === "string" && c.color.length > 0) props.color = c.color;
  if (typeof c.public === "boolean") props.public = c.public;
  if (typeof c.created === "string") props.created = c.created;
  if (typeof c.lastUpdate === "string") props.last_update = c.lastUpdate;
  return {
    type: "raindrop.collection",
    properties: props,
  };
}

function buildRaindropInput(r: RaindropRest): CreateItemInput {
  const note = r.note ?? "";
  const props: Record<string, unknown> = {
    title: r.title ?? r.link ?? "(untitled raindrop)",
    url: r.link ?? "",
  };
  if (note !== "") {
    // body mirrors note so the cross-app `core.bookmark.body` is
    // populated; note kept for upstream fidelity.
    props.body = note;
    props.note = note;
  }
  if (typeof r.excerpt === "string" && r.excerpt.length > 0) {
    props.excerpt = r.excerpt;
  }
  if (typeof r.domain === "string" && r.domain.length > 0) {
    props.domain = r.domain;
  }
  if (typeof r.cover === "string" && r.cover.length > 0) props.cover = r.cover;
  if (typeof r.type === "string" && r.type.length > 0) {
    // Raindrop's `type` field collides with Item's first-class column.
    // The schema renames the property to `raindrop_type`.
    props.raindrop_type = r.type;
  }
  if (Array.isArray(r.tags) && r.tags.length > 0) props.tags = r.tags;
  if (typeof r.created === "string") props.created = r.created;
  if (typeof r.lastUpdate === "string") props.last_update = r.lastUpdate;
  if (typeof r.important === "boolean") props.important = r.important;
  const collectionId = r.collection?.$id ?? r.collectionId;
  if (typeof collectionId === "number") {
    props.collection_id = String(collectionId);
  }
  if (Array.isArray(r.media) && r.media.length > 0) {
    props.media = r.media
      .filter(
        (m): m is { link: string; type?: string } =>
          typeof m.link === "string" && m.link.length > 0,
      )
      .map((m) => ({
        link: m.link,
        ...(typeof m.type === "string" ? { type: m.type } : {}),
      }));
  }
  return {
    type: "raindrop.raindrop",
    properties: props,
  };
}

// ---------------------------------------------------------------------------
// Schedule handler
// ---------------------------------------------------------------------------

export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  void message;
  const cursor: RaindropCursor =
    ((await ctx.cursor.read(CURSOR_KEY)) as RaindropCursor | null) ??
    defaultCursor();

  const sweepStartedAt = new Date().toISOString();
  let collectionsUpserted = 0;
  let raindropsUpserted = 0;
  let edgesCreated = 0;

  // -----------------------------------------------------------------------
  // STEP 1 — collections sweep. Full sweep every cycle (cheap; account
  // collection counts are small). Top-level collections come from
  // /collections; nested ones from /collections/childrens.
  // -----------------------------------------------------------------------
  const topLevel = await fetchCollections(ctx, COLLECTIONS_PATH);
  if (!topLevel.ok) return topLevel.failure;
  const nested = await fetchCollections(ctx, COLLECTION_CHILDREN_PATH);
  if (!nested.ok) return nested.failure;
  const allCollections = [...topLevel.items, ...nested.items];

  // First pass — upsert every collection so we have a complete
  // collection_mappings table before wiring parent edges (the parent
  // of any given collection might come later in the list).
  for (const c of allCollections) {
    const id = c._id ?? c.$id;
    if (typeof id !== "number") continue;
    const key = String(id);
    const existing = cursor.collection_mappings[key];
    const input = buildCollectionInput(c);
    try {
      if (existing !== undefined) {
        await ctx.marfa.updateItem(existing, input);
      } else {
        const created = await ctx.marfa.createItem({
          ...input,
          source_id: key,
        });
        cursor.collection_mappings[key] = created.id;
      }
      collectionsUpserted += 1;
    } catch (err) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: `raindrop: failed to upsert collection ${key}`,
        detail: { error: errorMessage(err) },
      });
    }
  }

  // Second pass — wire parent-of edges from parent collection to
  // child collection. We only do this on first sight (no idempotency
  // check possible at the substrate level today without a list edges
  // call; the substrate handles 409 / no-op gracefully).
  for (const c of allCollections) {
    const id = c._id ?? c.$id;
    if (typeof id !== "number") continue;
    const parentId =
      typeof c.parent === "object" && c.parent !== null
        ? c.parent.$id
        : undefined;
    if (typeof parentId !== "number") continue;
    const childMarfa = cursor.collection_mappings[String(id)];
    const parentMarfa = cursor.collection_mappings[String(parentId)];
    if (childMarfa === undefined || parentMarfa === undefined) continue;
    try {
      await ctx.marfa.createEdge({
        source_id: parentMarfa,
        target_id: childMarfa,
        edge_type: "parent-of",
      });
      edgesCreated += 1;
    } catch {
      // 409 / already-exists is the expected outcome on second sweep;
      // swallow silently to avoid action_required noise.
    }
  }

  cursor.last_collection_sweep_at = sweepStartedAt;

  // -----------------------------------------------------------------------
  // STEP 2 — raindrops sweep. Paginate through /raindrops/0 sorted by
  // -created. Break when we hit anything older than the watermark.
  // -----------------------------------------------------------------------
  const watermark = cursor.last_created_at;
  let highestSeen: string | null = null;
  let breakReason: "watermark" | "empty" | "max_pages" = "max_pages";

  pageLoop: for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams();
    params.set("sort", "-created");
    params.set("perpage", String(RAINDROPS_PERPAGE));
    params.set("nested", "true");
    params.set("page", String(page));
    const path = `${ALL_RAINDROPS_PATH}?${params.toString()}`;

    let response: Response;
    try {
      response = await ctx.marfa.proxyRequest("GET", path);
    } catch (err) {
      return reportFailure(ctx, "raindrop /raindrops fetch failed", err, true);
    }

    if (!response.ok) {
      return reportFailure(
        ctx,
        `raindrop /raindrops returned ${String(response.status)}`,
        null,
        response.status >= 500,
      );
    }

    let payload: RaindropsListResponse;
    try {
      const raw: unknown = await response.json();
      payload = raw as RaindropsListResponse;
    } catch (err) {
      return reportFailure(ctx, "raindrop /raindrops parse failed", err, true);
    }

    const items = payload.items ?? [];
    if (items.length === 0) {
      breakReason = "empty";
      break;
    }

    for (const r of items) {
      const created = r.created ?? "";
      if (watermark !== null && created !== "" && created <= watermark) {
        // Anything sorted -created from this point is older than the
        // watermark — done.
        breakReason = "watermark";
        break pageLoop;
      }
      if (highestSeen === null || created > highestSeen) {
        highestSeen = created;
      }

      const key = String(r._id);
      const existing = cursor.raindrop_mappings[key];
      const input = buildRaindropInput(r);
      let raindropMarfaId: string;
      try {
        if (existing !== undefined) {
          await ctx.marfa.updateItem(existing, input);
          raindropMarfaId = existing;
        } else {
          const createdItem = await ctx.marfa.createItem({
            ...input,
            source_id: key,
          });
          raindropMarfaId = createdItem.id;
          cursor.raindrop_mappings[key] = raindropMarfaId;
          // Edge to the parent collection on first write.
          const collectionId = r.collection?.$id ?? r.collectionId;
          if (typeof collectionId === "number") {
            const parentMarfa =
              cursor.collection_mappings[String(collectionId)];
            if (parentMarfa !== undefined) {
              try {
                await ctx.marfa.createEdge({
                  source_id: parentMarfa,
                  target_id: raindropMarfaId,
                  edge_type: "parent-of",
                });
                edgesCreated += 1;
              } catch {
                // 409 / already-exists is expected on retries.
              }
            }
          }
        }
        raindropsUpserted += 1;
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `raindrop: failed to upsert raindrop ${key}`,
          detail: { error: errorMessage(err) },
        });
      }
    }

    if (items.length < RAINDROPS_PERPAGE) {
      // Last page; no more raindrops to fetch.
      breakReason = "empty";
      break;
    }
  }

  if (highestSeen !== null) {
    cursor.last_created_at = highestSeen;
  } else {
    // First run with zero raindrops — stamp `now` so we don't
    // re-scan from epoch on subsequent runs. No-op when already set.
    cursor.last_created_at ??= sweepStartedAt;
  }
  cursor.last_inbound_at = sweepStartedAt;
  await ctx.cursor.write(CURSOR_KEY, cursor);

  await ctx.activity.emit({
    severity: "info",
    summary: `raindrop inbound: collections_upserted=${String(collectionsUpserted)} raindrops_upserted=${String(raindropsUpserted)} edges_created=${String(edgesCreated)} break_reason=${breakReason} (no destructive operations performed against pre-existing data)`,
    detail: {
      collections_upserted: collectionsUpserted,
      raindrops_upserted: raindropsUpserted,
      edges_created: edgesCreated,
      break_reason: breakReason,
      last_created_at_post: cursor.last_created_at,
    },
  });

  return { ok: true };
}

interface CollectionsFetchOk {
  ok: true;
  items: RaindropCollectionRest[];
}

interface CollectionsFetchFail {
  ok: false;
  failure: HandlerResult;
}

async function fetchCollections(
  ctx: ConnectionContext,
  path: string,
): Promise<CollectionsFetchOk | CollectionsFetchFail> {
  let response: Response;
  try {
    response = await ctx.marfa.proxyRequest("GET", path);
  } catch (err) {
    return {
      ok: false,
      failure: await reportFailure(
        ctx,
        `raindrop ${path} fetch failed`,
        err,
        true,
      ),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      failure: await reportFailure(
        ctx,
        `raindrop ${path} returned ${String(response.status)}`,
        null,
        response.status >= 500,
      ),
    };
  }
  try {
    const raw: unknown = await response.json();
    const payload = raw as CollectionsResponse;
    return { ok: true, items: payload.items ?? [] };
  } catch (err) {
    return {
      ok: false,
      failure: await reportFailure(
        ctx,
        `raindrop ${path} parse failed`,
        err,
        true,
      ),
    };
  }
}

async function reportFailure(
  ctx: ConnectionContext,
  summary: string,
  err: unknown,
  retry: boolean,
): Promise<HandlerResult> {
  await ctx.activity.emit({
    severity: retry ? "info" : "action_required",
    summary,
    detail: { error: errorMessage(err) },
  });
  return retry
    ? { ok: false, retry: true, reason: summary }
    : { ok: false, retry: false, reason: summary };
}

export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
}

// Test-only exports.
export const __internals = {
  defaultCursor,
  buildCollectionInput,
  buildRaindropInput,
};
