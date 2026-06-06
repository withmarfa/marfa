/**
 * Readwise inbound handler.
 *
 * One trigger: SCHEDULE (hourly Export-API sweep).
 *
 * Cursor:
 *   {
 *     updated_after: string,                                  // ISO timestamp
 *     book_mappings: Record<readwise_user_book_id, marfa_id>,
 *     highlight_mappings: Record<readwise_highlight_id, marfa_id>,
 *     last_inbound_at: string | null
 *   }
 *
 * Flow:
 *   1. Read cursor; default `updated_after` to the far-past sentinel
 *      so the first run pulls everything.
 *   2. Call `GET /api/v2/export/?updatedAfter=<iso>` via
 *      `ctx.marfa.proxyRequest`. Substrate stamps
 *      `Authorization: Token <key>` (set via `auth_scheme: "Token"` on
 *      the credential at install time).
 *   3. Iterate `payload.results` (books). For each book:
 *      - Upsert as `readwise.book` (source_id = user_book_id).
 *      - For each highlight in the book:
 *        - Upsert as `readwise.highlight` with `book_id` set to the
 *          readwise user_book_id for cross-traversal without edge lookup.
 *        - Record a `parent-of` edge from the book's marfa_id to the
 *          highlight's marfa_id (idempotent — the substrate dedupes).
 *   4. Follow `nextPageCursor` until exhausted.
 *   5. Persist the new `updated_after` (use `now` so the next sweep
 *      narrows to changes since this poll started).
 *   6. Emit a `system.activity` summary line including the
 *      non-destructive assertion the brief requires.
 *
 * Read-only constraint: this handler issues only GET requests against
 * Readwise. No DELETE, no PUT, no POST against the live account. The
 * harness asserts the same.
 */
import {
  registerScheduleHandler,
  type ConnectionContext,
  type ScheduleMessage,
  type HandlerResult,
  type CreateItemInput,
} from "@withmarfa/runtime-sdk";
import { EXPORT_PATH, UPDATED_AFTER_INITIAL } from "./manifest.js";

const CURSOR_KEY = "main";

interface ReadwiseHighlightRest {
  id: number;
  is_deleted?: boolean;
  text?: string;
  note?: string | null;
  location?: number;
  location_type?: string;
  color?: string;
  tags?: { name?: string }[] | string[];
  highlighted_at?: string | null;
  created_at?: string;
  updated_at?: string;
  url?: string;
}

interface ReadwiseBookRest {
  user_book_id: number;
  is_deleted?: boolean;
  title?: string;
  author?: string;
  readable_title?: string;
  source?: string;
  source_url?: string;
  cover_image_url?: string;
  category?: string;
  num_highlights?: number;
  updated?: string;
  last_highlight_at?: string | null;
  book_tags?: { name?: string }[];
  highlights?: ReadwiseHighlightRest[];
}

interface ExportResponse {
  count?: number;
  nextPageCursor?: string | null;
  results?: ReadwiseBookRest[];
}

interface ReadwiseCursor {
  /** ISO timestamp watermark; sent as `updatedAfter` on every poll. */
  updated_after: string;
  /** readwise user_book_id (as string) → Marfa item id. */
  book_mappings: Record<string, string>;
  /** readwise highlight id (as string) → Marfa item id. */
  highlight_mappings: Record<string, string>;
  last_inbound_at: string | null;
}

function defaultCursor(): ReadwiseCursor {
  return {
    updated_after: UPDATED_AFTER_INITIAL,
    book_mappings: {},
    highlight_mappings: {},
    last_inbound_at: null,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Field translation
// ---------------------------------------------------------------------------

function buildBookInput(book: ReadwiseBookRest): CreateItemInput {
  const props: Record<string, unknown> = {
    title: book.title ?? book.readable_title ?? "(untitled)",
  };
  if (book.author !== undefined && book.author !== "") {
    props.author = book.author;
  }
  if (book.category !== undefined) {
    props.category = book.category;
  }
  if (book.source !== undefined && book.source !== "") {
    // Readwise's `source` field collides with the items table's
    // first-class `source` column; the type schema renames the
    // property to `readwise_source` so the data round-trips cleanly.
    props.readwise_source = book.source;
  }
  if (book.source_url !== undefined && book.source_url !== "") {
    props.source_url = book.source_url;
  }
  if (book.cover_image_url !== undefined && book.cover_image_url !== "") {
    props.cover_image_url = book.cover_image_url;
  }
  if (typeof book.num_highlights === "number") {
    props.num_highlights = book.num_highlights;
  }
  if (book.updated !== undefined) {
    props.updated = book.updated;
  }
  return {
    type: "readwise.book",
    properties: props,
  };
}

function buildHighlightInput(
  highlight: ReadwiseHighlightRest,
  parentUserBookId: number,
): CreateItemInput {
  const props: Record<string, unknown> = {
    text: highlight.text ?? "",
    book_id: String(parentUserBookId),
  };
  if (
    highlight.note !== undefined &&
    highlight.note !== null &&
    highlight.note !== ""
  ) {
    props.note = highlight.note;
  }
  if (typeof highlight.location === "number") {
    props.location = highlight.location;
  }
  if (highlight.location_type !== undefined) {
    props.location_type = highlight.location_type;
  }
  if (highlight.color !== undefined && highlight.color !== "") {
    props.color = highlight.color;
  }
  const normalisedTags = normaliseTags(highlight.tags);
  if (normalisedTags.length > 0) {
    props.tags = normalisedTags;
  }
  if (
    highlight.highlighted_at !== undefined &&
    highlight.highlighted_at !== null
  ) {
    props.highlighted_at = highlight.highlighted_at;
  }
  if (highlight.updated_at !== undefined) {
    props.updated = highlight.updated_at;
  }
  if (highlight.url !== undefined && highlight.url !== "") {
    props.url = highlight.url;
  }
  return {
    type: "readwise.highlight",
    properties: props,
  };
}

function normaliseTags(
  tags: { name?: string }[] | string[] | undefined,
): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t === "string") {
      if (t.length > 0) out.push(t);
    } else if (
      typeof t === "object" &&
      typeof t.name === "string" &&
      t.name.length > 0
    ) {
      out.push(t.name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schedule handler
// ---------------------------------------------------------------------------

export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  void message;
  const cursor: ReadwiseCursor =
    ((await ctx.cursor.read(CURSOR_KEY)) as ReadwiseCursor | null) ??
    defaultCursor();

  const sweepStartedAt = new Date().toISOString();
  let booksUpserted = 0;
  let highlightsUpserted = 0;
  let edgesCreated = 0;
  let pageCursor: string | null = null;
  let pagesFetched = 0;
  const MAX_PAGES = 50; // safety brake; Readwise rarely paginates much

  do {
    const params = new URLSearchParams();
    params.set("updatedAfter", cursor.updated_after);
    if (pageCursor !== null) params.set("pageCursor", pageCursor);
    const path = `${EXPORT_PATH}?${params.toString()}`;

    let response: Response;
    try {
      response = await ctx.marfa.proxyRequest("GET", path);
    } catch (err) {
      return reportFailure(ctx, "readwise /export fetch failed", err, true);
    }

    if (!response.ok) {
      return reportFailure(
        ctx,
        `readwise /export returned ${String(response.status)}`,
        null,
        response.status >= 500,
      );
    }

    let payload: ExportResponse;
    try {
      const raw: unknown = await response.json();
      payload = raw as ExportResponse;
    } catch (err) {
      return reportFailure(ctx, "readwise /export parse failed", err, true);
    }

    for (const book of payload.results ?? []) {
      if (book.is_deleted === true) {
        // Read-only constraint: tombstone_mapping is `ignore` — Readwise
        // deletes are never propagated into Marfa trash.
        continue;
      }
      const bookKey = String(book.user_book_id);
      const existingBookMarfaId = cursor.book_mappings[bookKey];
      let bookMarfaId: string;

      const bookInput = buildBookInput(book);
      try {
        if (existingBookMarfaId !== undefined) {
          await ctx.marfa.updateItem(existingBookMarfaId, bookInput);
          bookMarfaId = existingBookMarfaId;
        } else {
          const created = await ctx.marfa.createItem({
            ...bookInput,
            source_id: bookKey,
          });
          bookMarfaId = created.id;
          cursor.book_mappings[bookKey] = bookMarfaId;
        }
        booksUpserted += 1;
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `readwise: failed to upsert book ${bookKey}`,
          detail: { error: errorMessage(err) },
        });
        continue;
      }

      for (const highlight of book.highlights ?? []) {
        if (highlight.is_deleted === true) continue;
        const highlightKey = String(highlight.id);
        const existingHighlight = cursor.highlight_mappings[highlightKey];
        const highlightInput = buildHighlightInput(
          highlight,
          book.user_book_id,
        );
        let highlightMarfaId: string;
        try {
          if (existingHighlight !== undefined) {
            await ctx.marfa.updateItem(existingHighlight, highlightInput);
            highlightMarfaId = existingHighlight;
          } else {
            const created = await ctx.marfa.createItem({
              ...highlightInput,
              source_id: highlightKey,
            });
            highlightMarfaId = created.id;
            cursor.highlight_mappings[highlightKey] = highlightMarfaId;
            // Only create the edge on first write — on updates it already
            // exists and the SDK would 409/no-op anyway.
            try {
              await ctx.marfa.createEdge({
                source_id: bookMarfaId,
                target_id: highlightMarfaId,
                edge_type: "parent-of",
              });
              edgesCreated += 1;
            } catch (err) {
              await ctx.activity.emit({
                severity: "action_required",
                summary: `readwise: failed to create parent-of edge ${bookMarfaId} → ${highlightMarfaId}`,
                detail: { error: errorMessage(err) },
              });
            }
          }
          highlightsUpserted += 1;
        } catch (err) {
          await ctx.activity.emit({
            severity: "action_required",
            summary: `readwise: failed to upsert highlight ${highlightKey}`,
            detail: { error: errorMessage(err) },
          });
        }
      }
    }

    pageCursor =
      typeof payload.nextPageCursor === "string" &&
      payload.nextPageCursor.length > 0
        ? payload.nextPageCursor
        : null;
    pagesFetched += 1;
  } while (pageCursor !== null && pagesFetched < MAX_PAGES);

  cursor.updated_after = sweepStartedAt;
  cursor.last_inbound_at = sweepStartedAt;
  await ctx.cursor.write(CURSOR_KEY, cursor);

  await ctx.activity.emit({
    severity: "info",
    summary: `readwise inbound: books_upserted=${String(booksUpserted)} highlights_upserted=${String(highlightsUpserted)} edges_created=${String(edgesCreated)} pages=${String(pagesFetched)} (no destructive operations performed against the live Readwise account)`,
    detail: {
      books_upserted: booksUpserted,
      highlights_upserted: highlightsUpserted,
      edges_created: edgesCreated,
      pages_fetched: pagesFetched,
      updated_after_post: cursor.updated_after,
    },
  });

  return { ok: true };
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
  buildBookInput,
  buildHighlightInput,
  normaliseTags,
};
