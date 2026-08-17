/**
 * Readwise Reader bidirectional handlers.
 *
 * Two triggers over one cursor:
 *
 * - SCHEDULE (hourly, inbound): drains `GET /api/v3/list/` from the
 *   stored `updatedAfter` watermark, page by page. Documents that are
 *   children of another document, or that sit in the feed, are skipped
 *   unless configured in. The rest upsert as `readwise.document`
 *   mirrors, with the mapping recorded on the cursor.
 *
 * - ITEM-EVENT (outbound): a `readwise.document` mutation in Marfa
 *   becomes a save, an update or a delete upstream.
 *
 * Three properties of the v3 API shape most of what follows, and none
 * of them is documented. They were established by probing a live
 * account before this was written:
 *
 *   - **Re-saving a known URL is inert.** `POST /save/` on a URL Reader
 *     already holds returns 200 with the existing id and changes
 *     nothing at all. So adopting an existing document is a two-step
 *     move: save to learn the id, then update to carry the fields.
 *
 *   - **`PATCH /update/` returns only `{id, url}`.** The updated
 *     document does not come back, so the echo hash cannot be taken
 *     from the write response. It is taken from a read-back, which also
 *     catches the silent coercion below.
 *
 *   - **A location Reader will not accept is coerced, not refused.**
 *     Saving with `location: "shortlist"` returns 201 and stores `new`.
 *     Writes therefore send a location only when Reader accepts it, and
 *     what actually landed is read back rather than assumed.
 */
import {
  registerScheduleHandler,
  registerItemEventHandler,
  type ConnectionContext,
  type ScheduleMessage,
  type ItemEventMessage,
  type HandlerResult,
  type CreateItemInput,
  type ItemResource,
} from "@withmarfa/runtime-sdk";
import {
  CHILD_CATEGORIES,
  DEFAULT_TARGET_TYPE,
  DELETE_PATH,
  FABRICATED_URL_PREFIX,
  LIST_PATH,
  MAX_PAGES_PER_SWEEP,
  PAGE_SIZE,
  SAVE_PATH,
  UPDATE_PATH,
  UPDATED_AFTER_INITIAL,
  WRITABLE_LOCATIONS,
} from "./manifest.js";

const CURSOR_KEY = "main";

/** A document as Reader's list endpoint returns it. */
interface ReaderDocument {
  id: string;
  url?: string | null;
  source_url?: string | null;
  title?: string | null;
  author?: string | null;
  summary?: string | null;
  category?: string | null;
  location?: string | null;
  site_name?: string | null;
  source?: string | null;
  word_count?: number | null;
  reading_time?: string | null;
  listening_time?: string | null;
  reading_progress?: number | null;
  published_date?: string | null;
  image_url?: string | null;
  notes?: string | null;
  tags?: unknown;
  parent_id?: string | null;
  saved_at?: string | null;
  updated_at?: string | null;
  last_moved_at?: string | null;
  first_opened_at?: string | null;
  last_opened_at?: string | null;
}

interface ListResponse {
  /**
   * Documents remaining from this cursor onward — not a stable total.
   * It decrements page by page, so it is a progress signal and nothing
   * else. Reading it as a library size is wrong on every page but the
   * first.
   */
  count?: number;
  nextPageCursor?: string | null;
  results?: ReaderDocument[];
}

interface ReaderCursor {
  /** ISO watermark handed to `updatedAfter` on the next full sweep. */
  updated_after: string;
  /**
   * Page cursor when a sweep parked mid-drain. The watermark does not
   * advance while this is set: a sweep that stopped halfway has not
   * seen everything changed since the watermark, and moving it would
   * skip the remainder permanently.
   */
  page_cursor: string | null;
  /** Reader document id → Marfa item id. */
  doc_mappings: Record<string, string>;
  /** ISO timestamp of the last completed sweep. Diagnostic only. */
  last_inbound_at: string | null;
}

interface ReaderConfig {
  include_feed: boolean;
}

function defaultCursor(): ReaderCursor {
  return {
    updated_after: UPDATED_AFTER_INITIAL,
    page_cursor: null,
    doc_mappings: {},
    last_inbound_at: null,
  };
}

function findExternalIdFor(
  cursor: ReaderCursor,
  marfa_id: string,
): string | null {
  for (const [ext, m] of Object.entries(cursor.doc_mappings)) {
    if (m === marfa_id) return ext;
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Field normalization
// ---------------------------------------------------------------------------

/**
 * Reader reads tags back as an object keyed by tag name and takes a
 * plain list on write, so the two shapes have to be reconciled
 * somewhere. Absent tags arrive as `null` on some documents and `{}` on
 * others, and the whole field is undocumented, so this accepts every
 * shape it might reasonably take and normalizes to a sorted list of
 * names. Sorted because the list feeds the echo hash, and a hash that
 * depends on key order would report a change nobody made.
 */
export function normalizeTags(raw: unknown): string[] {
  const names: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? Object.values(raw)
      : [];
  const out = names
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (typeof entry === "object" && entry !== null) {
        const name = (entry as { name?: unknown }).name;
        if (typeof name === "string") return name;
      }
      return null;
    })
    .filter((n): n is string => n !== null && n.length > 0);
  return [...new Set(out)].sort();
}

/**
 * Reader stores an empty string in `image_url` where a document has no
 * image, and the type declares that field a URL. Passing the empty
 * value through fails validation on the write rather than on the field
 * that is actually absent, so an empty string is treated as unset.
 */
function definedUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function definedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function definedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** A URL this integration fabricated for a document that had none. */
function isFabricatedUrl(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(FABRICATED_URL_PREFIX);
}

function fabricatedUrlFor(marfa_id: string): string {
  return `${FABRICATED_URL_PREFIX}${marfa_id}`;
}

// ---------------------------------------------------------------------------
// Hashing — echo suppression
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Content hash over the fields a round-trip can touch, computed from an
 * upstream document. Both directions call this on a document Reader
 * returned, never on one this code composed, so a field Reader rewrote
 * on the way in is hashed as Reader stores it.
 */
export async function contentHashForDocument(
  doc: ReaderDocument,
): Promise<string> {
  const canonical = JSON.stringify({
    title: doc.title ?? "",
    author: doc.author ?? "",
    summary: doc.summary ?? "",
    category: doc.category ?? "",
    location: doc.location ?? "",
    notes: doc.notes ?? "",
    published_date: doc.published_date ?? "",
    image_url: doc.image_url ?? "",
    tags: normalizeTags(doc.tags),
  });
  return (await sha256Hex(canonical)).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type ConfigResolution =
  | { ok: true; config: ReaderConfig }
  | { ok: false; error: unknown };

async function resolveConnectionConfig(
  ctx: ConnectionContext,
): Promise<ConfigResolution> {
  let connection: ItemResource | null;
  try {
    connection = await ctx.marfa.getItem(ctx.connection_id);
  } catch (err) {
    return { ok: false, error: err };
  }
  const props = connection?.properties as
    | { configuration?: Record<string, unknown> }
    | undefined;
  const cfg = props?.configuration ?? {};
  return {
    ok: true,
    config: { include_feed: cfg.include_feed === true },
  };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Whether a document is one this integration mirrors. Reader's list
 * endpoint returns the whole library in one stream — articles, the
 * highlights taken from them, the notes on those highlights, and every
 * unread feed item — so the filter is what separates a reading library
 * from a subscription firehose.
 */
export function isInScope(doc: ReaderDocument, config: ReaderConfig): boolean {
  if (typeof doc.parent_id === "string" && doc.parent_id.length > 0) {
    return false;
  }
  if (typeof doc.category === "string" && CHILD_CATEGORIES.has(doc.category)) {
    return false;
  }
  if (doc.location === "feed" && !config.include_feed) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Inbound — schedule handler
// ---------------------------------------------------------------------------

export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  void message;
  const resolved = await resolveConnectionConfig(ctx);
  if (!resolved.ok) {
    return reportFailure(
      ctx,
      "connection configuration lookup failed",
      resolved.error,
      true,
    );
  }
  const config = resolved.config;

  const cursor: ReaderCursor =
    ((await ctx.cursor.read(CURSOR_KEY)) as ReaderCursor | null) ??
    defaultCursor();

  // A parked sweep resumes from its page cursor against the watermark it
  // started under. Restarting from the watermark would re-walk pages
  // already applied; advancing the watermark would skip the rest.
  const sweepStartedAt = new Date().toISOString();
  let pageCursor = cursor.page_cursor;
  let pages = 0;
  let seen = 0;
  let upserted = 0;
  let skippedScope = 0;
  let skippedEcho = 0;
  let parked = false;
  let throttled = false;

  while (pages < MAX_PAGES_PER_SWEEP) {
    const params = new URLSearchParams({
      updatedAfter: cursor.updated_after,
      limit: String(PAGE_SIZE),
    });
    if (pageCursor !== null) params.set("pageCursor", pageCursor);

    let response: Response;
    try {
      response = await ctx.marfa.proxyRequest(
        "GET",
        `${LIST_PATH}?${params.toString()}`,
      );
    } catch (err) {
      return reportFailure(ctx, "reader /list fetch failed", err, true);
    }

    // Reader throttles the list bucket at twenty requests a minute and
    // answers with a Retry-After in whole seconds. Parking is the right
    // response rather than a queue retry: the retry would come back
    // inside the same window and spend the budget the next tick needs.
    if (response.status === 429) {
      throttled = true;
      parked = true;
      break;
    }
    if (!response.ok) {
      return reportFailure(
        ctx,
        `reader /list returned ${String(response.status)}`,
        null,
        response.status >= 500,
      );
    }

    let payload: ListResponse;
    try {
      const raw: unknown = await response.json();
      payload = raw as ListResponse;
    } catch (err) {
      return reportFailure(ctx, "reader /list parse failed", err, true);
    }

    for (const doc of payload.results ?? []) {
      seen += 1;
      if (!isInScope(doc, config)) {
        skippedScope += 1;
        continue;
      }

      const hash = await contentHashForDocument(doc);
      if (await ctx.echo.shouldSkipReactive(doc.id, hash)) {
        skippedEcho += 1;
        continue;
      }

      const mappedMarfaId = cursor.doc_mappings[doc.id];
      try {
        if (mappedMarfaId !== undefined) {
          await ctx.marfa.updateItem(mappedMarfaId, buildItemInput(doc));
        } else {
          const created = await ctx.marfa.createItem({
            ...buildItemInput(doc),
            source_id: doc.id,
          });
          cursor.doc_mappings[doc.id] = created.id;
        }
        upserted += 1;
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `readwise reader: failed to upsert marfa item for document ${doc.id}`,
          detail: { error: errorMessage(err) },
        });
      }
    }

    pages += 1;
    pageCursor = payload.nextPageCursor ?? null;
    if (pageCursor === null) break;
    if (pages >= MAX_PAGES_PER_SWEEP) parked = true;
  }

  cursor.page_cursor = parked ? pageCursor : null;
  // The watermark only moves when a sweep reached the end of the stream.
  if (!parked) {
    cursor.updated_after = sweepStartedAt;
    cursor.last_inbound_at = sweepStartedAt;
  }
  await ctx.cursor.write(CURSOR_KEY, cursor);

  await ctx.activity.emit({
    severity: "info",
    summary: `readwise reader inbound: upserted=${String(upserted)} out_of_scope=${String(skippedScope)} echo_skipped=${String(skippedEcho)}${parked ? " (parked)" : ""}`,
    detail: {
      documents_seen: seen,
      upserted,
      skipped_out_of_scope: skippedScope,
      skipped_echo: skippedEcho,
      pages_drained: pages,
      parked,
      throttled,
      include_feed: config.include_feed,
    },
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Outbound — item-event handler
// ---------------------------------------------------------------------------

export async function handleItemEvent(
  ctx: ConnectionContext,
  message: ItemEventMessage,
): Promise<HandlerResult> {
  // The bridge already drops self-events; check anyway, because the cost
  // of being wrong here is an unbounded write loop against someone's
  // library.
  if (
    ctx.cycle?.originating_connection_id === ctx.connection_id ||
    message.cycle.originating_connection_id === ctx.connection_id
  ) {
    return { ok: true };
  }

  const cursor: ReaderCursor =
    ((await ctx.cursor.read(CURSOR_KEY)) as ReaderCursor | null) ??
    defaultCursor();

  const item = await ctx.marfa.getItem(message.item_id);
  if (item === null) {
    return deleteUpstreamIfMapped(ctx, cursor, message.item_id);
  }

  // The item-event trigger delivers every item event in the space, not
  // just this type's, so the gate is the handler's job.
  if (item.type !== DEFAULT_TARGET_TYPE) return { ok: true };

  const externalId = findExternalIdFor(cursor, item.id);

  if (externalId !== null && (await ctx.echo.inLagWindow(externalId))) {
    return { ok: false, retry: true, reason: "in_lag_window" };
  }

  if (item.state === "trashed") {
    return deleteUpstream(ctx, cursor, externalId);
  }

  if (externalId !== null) {
    return updateUpstream(ctx, cursor, item, externalId);
  }

  return createUpstream(ctx, cursor, item);
}

/**
 * Create the document upstream. Reader deduplicates on URL, which is
 * the whole idempotency rail here: a redelivered event saves the same
 * URL and lands on the same document instead of a duplicate.
 *
 * A 200 means Reader already held that URL. Because a re-save changes
 * nothing, the document is adopted and then explicitly updated so the
 * item's fields actually reach it.
 */
async function createUpstream(
  ctx: ConnectionContext,
  cursor: ReaderCursor,
  item: ItemResource,
): Promise<HandlerResult> {
  const props = item.properties ?? {};
  const sourceUrl = definedUrl(props.source_url) ?? fabricatedUrlFor(item.id);
  const body: Record<string, unknown> = { url: sourceUrl };

  // A fabricated URL points at nothing by design, so Reader has to be
  // given something to show or it will try to fetch a host that cannot
  // resolve and store an empty document.
  //
  // `should_clean_html` is deliberately not sent. Setting it false makes
  // Reader refuse the save unless BOTH `author` and `title` are present:
  //
  //   400 "The fields 'author' and 'title' are required when you don't
  //        use should_clean_html"
  //
  // An author is optional on a Reader document and on this type, so
  // suppressing the cleaner would reject the ordinary case of somebody
  // writing a document in Marfa and not naming an author. Letting Reader
  // clean a placeholder body costs nothing.
  if (isFabricatedUrl(sourceUrl)) {
    body.html = renderPlaceholderHtml(props);
  }
  applyWritableFields(body, props);

  const resp = await ctx.marfa.proxyRequest("POST", SAVE_PATH, body);
  if (!resp.ok) {
    return reportOutboundFailure(ctx, "save", "(new)", resp);
  }

  const savedRaw: unknown = await resp.json();
  const saved = savedRaw as { id?: string };
  const newId = saved.id;
  if (typeof newId !== "string" || newId.length === 0) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: `readwise reader outbound: save returned no document id for marfa item ${item.id}`,
      detail: { status: resp.status },
    });
    return { ok: true };
  }

  cursor.doc_mappings[newId] = item.id;
  await ctx.cursor.write(CURSOR_KEY, cursor);

  // 201 carried the fields; 200 means the document already existed and
  // the save was inert, so the fields still have to be pushed.
  if (resp.status === 200) {
    return updateUpstream(ctx, cursor, item, newId, "adopted");
  }

  await trackFromReadBack(ctx, newId);
  await ctx.activity.emit({
    severity: "info",
    summary: `readwise reader outbound: created document ${newId} from marfa item ${item.id}`,
  });
  return { ok: true };
}

/**
 * Push the item's fields onto a document already known upstream.
 *
 * A 404 means the document is gone — deleted in Reader since the
 * mapping was recorded, and Reader's deletes are permanent. The mapping
 * is dropped and the document recreated in the same run rather than
 * left dangling until someone notices.
 */
async function updateUpstream(
  ctx: ConnectionContext,
  cursor: ReaderCursor,
  item: ItemResource,
  externalId: string,
  mode: "updated" | "adopted" = "updated",
): Promise<HandlerResult> {
  const body: Record<string, unknown> = {};
  applyWritableFields(body, item.properties ?? {});

  const resp = await ctx.marfa.proxyRequest(
    "PATCH",
    `${UPDATE_PATH}${encodeURIComponent(externalId)}/`,
    body,
  );

  if (resp.status === 404) {
    Reflect.deleteProperty(cursor.doc_mappings, externalId);
    await ctx.cursor.write(CURSOR_KEY, cursor);
    if (mode === "adopted") {
      // Adopting and then failing to find the same document means
      // something removed it mid-run. Recreating would loop.
      await ctx.activity.emit({
        severity: "action_required",
        summary: `readwise reader outbound: adopted document ${externalId} vanished before it could be updated`,
        detail: { marfa_item_id: item.id },
      });
      return { ok: true };
    }
    return createUpstream(ctx, cursor, item);
  }

  if (!resp.ok) {
    return reportOutboundFailure(ctx, "update", externalId, resp);
  }

  await trackFromReadBack(ctx, externalId);
  await ctx.activity.emit({
    severity: "info",
    summary: `readwise reader outbound: ${mode} document ${externalId} from marfa item ${item.id}`,
  });
  return { ok: true };
}

async function deleteUpstream(
  ctx: ConnectionContext,
  cursor: ReaderCursor,
  externalId: string | null,
): Promise<HandlerResult> {
  if (externalId === null) return { ok: true };
  const resp = await ctx.marfa.proxyRequest(
    "DELETE",
    `${DELETE_PATH}${encodeURIComponent(externalId)}/`,
  );
  // A document already gone is the state this was asking for.
  if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
    return reportOutboundFailure(ctx, "delete", externalId, resp);
  }
  Reflect.deleteProperty(cursor.doc_mappings, externalId);
  await ctx.cursor.write(CURSOR_KEY, cursor);
  await ctx.activity.emit({
    severity: "info",
    summary: `readwise reader outbound: deleted document ${externalId}`,
  });
  return { ok: true };
}

async function deleteUpstreamIfMapped(
  ctx: ConnectionContext,
  cursor: ReaderCursor,
  marfa_id: string,
): Promise<HandlerResult> {
  return deleteUpstream(ctx, cursor, findExternalIdFor(cursor, marfa_id));
}

/**
 * Record what actually landed upstream, by reading the document back.
 *
 * The write response carries only `{id, url}`, and Reader silently
 * rewrites a location it will not accept, so the only honest source for
 * the echo hash is the stored document. Without this the next inbound
 * sweep sees a hash it does not recognize and writes the item again,
 * which is the loop echo suppression exists to stop.
 *
 * A failed read-back is not fatal: it costs one redundant inbound
 * update, not correctness.
 */
async function trackFromReadBack(
  ctx: ConnectionContext,
  externalId: string,
): Promise<void> {
  try {
    const resp = await ctx.marfa.proxyRequest(
      "GET",
      `${LIST_PATH}?id=${encodeURIComponent(externalId)}`,
    );
    if (!resp.ok) return;
    const raw: unknown = await resp.json();
    const payload = raw as ListResponse;
    const doc = payload.results?.[0];
    if (doc === undefined) return;
    await ctx.echo.trackOutboundWrite(
      externalId,
      await contentHashForDocument(doc),
    );
  } catch {
    // Read-back is an optimization on top of a completed write. Failing
    // it must not fail the run that already succeeded upstream.
  }
}

// ---------------------------------------------------------------------------
// Field translation
// ---------------------------------------------------------------------------

function buildItemInput(doc: ReaderDocument): CreateItemInput {
  const props: Record<string, unknown> = {
    title: doc.title ?? "",
  };
  const assign = (key: string, value: unknown): void => {
    if (value !== undefined) props[key] = value;
  };

  assign("author", definedString(doc.author));
  assign("summary", definedString(doc.summary));
  assign("category", definedString(doc.category));
  assign("location", definedString(doc.location));
  assign("reader_url", definedUrl(doc.url));
  assign("site_name", definedString(doc.site_name));
  assign("readwise_source", definedString(doc.source));
  assign("word_count", definedNumber(doc.word_count));
  assign("reading_time", definedString(doc.reading_time));
  assign("listening_time", definedString(doc.listening_time));
  assign("reading_progress", definedNumber(doc.reading_progress));
  assign("published_date", definedString(doc.published_date));
  assign("image_url", definedUrl(doc.image_url));
  assign("notes", definedString(doc.notes));
  assign("saved_at", definedString(doc.saved_at));
  assign("updated", definedString(doc.updated_at));
  assign("last_moved_at", definedString(doc.last_moved_at));
  assign("first_opened_at", definedString(doc.first_opened_at));
  assign("last_opened_at", definedString(doc.last_opened_at));

  // A document this integration pushed upstream carries a URL that only
  // exists to satisfy Reader's dedupe. Writing it back onto the item
  // would put a deliberately unresolvable address in front of the person
  // who created it.
  const sourceUrl = definedUrl(doc.source_url);
  if (sourceUrl !== undefined && !isFabricatedUrl(sourceUrl)) {
    props.source_url = sourceUrl;
  }

  const tags = normalizeTags(doc.tags);
  if (tags.length > 0) props.tags = tags;

  return { type: DEFAULT_TARGET_TYPE, properties: props };
}

/**
 * Copy the fields Reader will accept on a save or an update.
 *
 * `location` is only sent when Reader can honor it, because a value it
 * cannot is stored as something else without complaint. `tags` are only
 * sent when the item carries some, because a tag write replaces the
 * whole set and an absent field would silently strip tags applied in
 * Reader.
 */
function applyWritableFields(
  body: Record<string, unknown>,
  props: Record<string, unknown>,
): void {
  const assign = (key: string, value: unknown): void => {
    if (value !== undefined) body[key] = value;
  };

  assign("title", definedString(props.title));
  assign("author", definedString(props.author));
  assign("summary", definedString(props.summary));
  assign("category", definedString(props.category));
  assign("notes", definedString(props.notes));
  assign("published_date", definedString(props.published_date));
  assign("image_url", definedUrl(props.image_url));

  const location = definedString(props.location);
  if (location !== undefined && WRITABLE_LOCATIONS.has(location)) {
    body.location = location;
  }

  const tags = props.tags;
  if (Array.isArray(tags)) {
    const names = tags.filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    if (names.length > 0) body.tags = names;
  }
}

/**
 * Body for a document that has no source to fetch. Reader stores what it
 * is given here instead of trying to retrieve the fabricated URL.
 */
function renderPlaceholderHtml(props: Record<string, unknown>): string {
  const escape = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const title = definedString(props.title) ?? "Untitled";
  const summary = definedString(props.summary);
  const notes = definedString(props.notes);
  const parts = [`<h1>${escape(title)}</h1>`];
  if (summary !== undefined) parts.push(`<p>${escape(summary)}</p>`);
  if (notes !== undefined) parts.push(`<p>${escape(notes)}</p>`);
  return `<article>${parts.join("")}</article>`;
}

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

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

async function reportOutboundFailure(
  ctx: ConnectionContext,
  action: string,
  externalId: string,
  resp: Response,
): Promise<HandlerResult> {
  let body = "";
  try {
    body = await resp.text();
  } catch {
    // Body may already have been consumed; the status is the signal.
  }
  // A 429 on a write is worth retrying — unlike the inbound sweep, an
  // outbound event carries a single user edit and has nowhere to resume
  // from if it is dropped.
  const retry = resp.status >= 500 || resp.status === 429;
  await ctx.activity.emit({
    severity: retry ? "info" : "action_required",
    summary: `readwise reader outbound ${action}: upstream returned ${String(resp.status)} (document ${externalId})`,
    detail: { status: resp.status, body: body.slice(0, 500) },
  });
  return retry
    ? { ok: false, retry: true, reason: `upstream ${String(resp.status)}` }
    : { ok: true };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
  registerItemEventHandler(handleItemEvent);
}

export const __internals = {
  defaultCursor,
  findExternalIdFor,
  buildItemInput,
  applyWritableFields,
  contentHashForDocument,
  normalizeTags,
  isInScope,
  isFabricatedUrl,
  fabricatedUrlFor,
  renderPlaceholderHtml,
};
