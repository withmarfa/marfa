/**
 * The bulk_action job queue's wire shapes, declared once.
 *
 * The route answers them and the queue stores them, so they live here
 * rather than in either: a copy in the route would be a second description
 * of one shape, and the document would carry both.
 */
import { z } from "@hono/zod-openapi";
import {
  ItemStateEnum,
  TagSchema,
  TierEnum,
  WrittenPropertiesSchema,
} from "../routes/_schemas.js";
import type { DeclaresKeys } from "../routes/_unknown-body-keys.js";

/**
 * The bulk-action match set, and the only declaration of it.
 *
 * Filter fields carry the same semantics as the `GET /items` query. One
 * JSON object so bulk_action callers don't have to shove a filter
 * expression through query-string encoding.
 *
 * Declared here rather than in the route, so the queue and the door read
 * one shape: a second declaration in the route file is what let `dry_run`
 * and a lifecycle state drift out of step with the copy the document is
 * generated from.
 */
export const BulkActionFilterShape = z
  .object({
    type: z
      .string()
      .optional()
      .describe(
        "Restrict to one type, subtypes included. A type the credential cannot read, with nothing readable under it, is refused `403 type_not_permitted`; one it can read and not write matches nothing. A type nothing registers is accepted.",
      ),
    // The two doors agree structurally rather than by two literals: this
    // filter's `state` goes straight to the same item query `GET /items` uses
    // and neither sets the widening flag, so one default serves both. That
    // matters here more than on a read door, because `dry_run` enumerates
    // what the caller is about to write to and a caller checks it against a
    // listing.
    state: ItemStateEnum.optional().describe(
      "Filter by lifecycle state. Omitting it applies the same default as `GET /items`: the active state alone, so an unnarrowed action does not reach rows the caller has archived or deleted. There is no `any` sentinel on this door: these four states are the whole structured vocabulary it accepts, and a write across states is one job per state.",
    ),
    source: z.string().optional(),
    tier: TierEnum.optional(),
    tags: z.array(z.string()).optional(),
    occurred_after: z
      .string()
      .optional()
      .describe(
        "Lower bound on the item's own time (`occurred_at`, falling back to `created_at`) strictly after this. Exclusive, as every bound but `updated_after` is.",
      ),
    occurred_before: z
      .string()
      .optional()
      .describe(
        "Upper bound on the same expression, strictly before this. Exclusive, matching its lower twin.",
      ),
    /** Full filter-SQL DSL string, same grammar as GET /items?filter=. */
    filter: z.string().optional(),
  })
  .openapi("BulkActionFilter");

/** The same shape as the request takes it: absent means "every item". */
export const BulkActionFilterSchema = BulkActionFilterShape.optional();

const BulkActionBaseSchema = z.object({
  filter: BulkActionFilterSchema,
  dry_run: z.boolean().optional(),
  max_items: z.number().int().positive().optional(),
  enable_fanout: z.boolean().optional(),
});

export const BulkActionInputSchema = z.discriminatedUnion("action", [
  BulkActionBaseSchema.extend({
    action: z.literal("transition"),
    state: z.enum(["active", "archived", "trashed"]),
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("purge"),
    confirm: z.literal("PURGE").optional(),
    expected_ids: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        "The ids a dry run of this purge returned. Where given, the purge takes only rows that are both in this list and matched by the filter now: a row the filter has come to match since is left untouched, and a listed id the filter no longer matches is not purged. `matched` counts what the purge will take, and `max_items` caps that rather than what the filter reaches. An empty list is refused, since it names nothing to purge. Taken by `purge` alone.",
      ),
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("update_tags"),
    add: z.array(TagSchema).optional(),
    remove: z.array(z.string()).optional(),
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("update_tier"),
    tier: TierEnum,
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("update_properties"),
    patch: WrittenPropertiesSchema,
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("update_occurred_at"),
    occurred_at: z.string(),
  }),
]);

export type BulkActionInput = z.infer<typeof BulkActionInputSchema>;

/**
 * The request shape each `action` selects, keyed by the action name.
 *
 * Read off the union's own options rather than restated, for the reason
 * the filter above is declared once: a variant added to the union is in
 * this map the moment it is added, so the body-field refusal covers it
 * with no second edit and cannot fall behind.
 *
 * Declared over the union's own `action` so the refusal can index it
 * without a not-found branch — and a not-found branch here could only
 * ever be a silent skip, which is the failure this map serves a refusal
 * against.
 */
export const BULK_ACTION_SHAPES: Record<
  BulkActionInput["action"],
  DeclaresKeys
> = Object.fromEntries(
  BulkActionInputSchema.options.map((option) => [
    option.shape.action.value,
    option,
  ]),
) as Record<string, DeclaresKeys>;

export const BulkActionErrorEntrySchema = z
  .object({
    id: z.string(),
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("BulkActionError");

export type BulkActionErrorEntry = z.infer<typeof BulkActionErrorEntrySchema>;

export const BulkActionResultSchema = z
  .object({
    action: z.string(),
    matched: z.number().int(),
    succeeded: z.number().int(),
    errored: z.number().int(),
    dry_run: z.boolean(),
    ids: z.array(z.string()).optional(),
    errors: z.array(BulkActionErrorEntrySchema).optional(),
    /** Unique blob hashes referenced by the items that were purged. Not a
     *  strict orphan count: what a blob is still referenced by is the
     *  `blob-orphans` housekeeping job's answer, on its own schedule.
     *  Omitted for non-purge actions. */
    blob_hashes_referenced: z.number().int().optional(),
  })
  .openapi("BulkActionResult");

export type BulkActionResult = z.infer<typeof BulkActionResultSchema>;

export const BulkActionJobStatusSchema = z
  .enum(["queued", "in_progress", "completed", "failed", "canceled"])
  .openapi("BulkActionJobStatus");

export const BulkActionJobSchema = z
  .object({
    id: z.string(),
    action: z.string(),
    status: BulkActionJobStatusSchema,
    matched: z.number().int(),
    processed: z.number().int(),
    succeeded: z.number().int(),
    errored: z.number().int(),
    started_at: z.string().optional(),
    finished_at: z.string().optional(),
    error: z.string().optional(),
    result: BulkActionResultSchema.optional(),
  })
  .openapi("BulkActionJob");

export type BulkActionJob = z.infer<typeof BulkActionJobSchema>;
