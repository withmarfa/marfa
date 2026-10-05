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
import { REFUSAL_TEXT } from "../openapi.js";

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
      "Only items in this lifecycle state. Leave it out for `active` items only, as on `GET /items`. There is no `any`: to act on several states, queue one action per state.",
    ),
    source: z
      .string()
      .optional()
      .describe("Only items stamped with this source."),
    tier: TierEnum.optional().describe("Only items in this tier."),
    tags: z
      .array(z.string())
      .optional()
      .describe("Only items that carry all of these tags."),
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
    filter: z
      .string()
      .optional()
      .describe(
        "A filter expression, in the grammar `filter` takes on `GET /items`.",
      ),
  })
  .describe(
    "Which items a bulk action applies to. Each field narrows the match as the same filter does on `GET /items`.",
  )
  .openapi("BulkActionFilter");

/** The same shape as the request takes it: absent means "every item". */
export const BulkActionFilterSchema = BulkActionFilterShape.optional();

const BulkActionBaseSchema = z.object({
  filter: BulkActionFilterSchema,
  dry_run: z.boolean().optional(),
  max_items: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "The most items the action may match. Defaults to 10,000. A value above 50,000 counts as 50,000.",
    ),
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
    id: z.string().describe("The ID of the item."),
    code: z.string().describe(REFUSAL_TEXT.code),
    message: z.string().describe(REFUSAL_TEXT.message),
    details: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(REFUSAL_TEXT.details),
  })
  .describe("An item a bulk action left unchanged, and why.")
  .openapi("BulkActionError");

export type BulkActionErrorEntry = z.infer<typeof BulkActionErrorEntrySchema>;

const BULK_ACTION_TEXT = "The action, such as `purge`.";

export const BulkActionResultSchema = z
  .object({
    action: z.string().describe(BULK_ACTION_TEXT),
    matched: z.number().int().describe("How many items the action matched."),
    succeeded: z
      .number()
      .int()
      .describe("How many items the action changed. `0` on a dry run."),
    errored: z
      .number()
      .int()
      .describe(
        "How many matched items the action left unchanged. `0` on a dry run.",
      ),
    dry_run: z
      .boolean()
      .describe("`true` if this was a dry run, which changed nothing."),
    ids: z
      .array(z.string())
      .optional()
      .describe(
        "On a dry run, the ID of every matched item. On a job, the IDs of the items it changed, if it changed from 1 to 100 of them; absent otherwise.",
      ),
    errors: z
      .array(BulkActionErrorEntrySchema)
      .optional()
      .describe(
        "On a job, the first 100 items it left unchanged, each with its error. Absent otherwise.",
      ),
    // Not a strict orphan count: what a blob is still referenced by is the
    // `blob-orphans` housekeeping job's answer, on its own schedule.
    blob_hashes_referenced: z
      .number()
      .int()
      .optional()
      .describe(
        "On a purge job, how many distinct blobs the purged items referenced, whether or not anything still references them. Absent otherwise.",
      ),
  })
  .describe("What a bulk action did, or for a dry run, what it matched.")
  .openapi("BulkActionResult");

export type BulkActionResult = z.infer<typeof BulkActionResultSchema>;

export const BulkActionJobStatusSchema = z
  .enum(["queued", "in_progress", "completed", "failed", "canceled"])
  .describe(
    "Where a bulk-action job is. `queued`: waiting to run. `in_progress`: running. `completed`: it reached every matched item. `failed`: it stopped early, and `error` says why. `canceled`: it was canceled before it finished.",
  )
  .openapi("BulkActionJobStatus");

export const BulkActionJobSchema = z
  .object({
    id: z.string().describe("Unique identifier for the job."),
    action: z.string().describe(BULK_ACTION_TEXT),
    status: BulkActionJobStatusSchema.describe("Where the job is."),
    matched: z
      .number()
      .int()
      .describe("How many items the job acts on, fixed when Marfa queued it."),
    processed: z
      .number()
      .int()
      .describe(
        "How many of the matched items the job has reached so far, changed or not.",
      ),
    succeeded: z
      .number()
      .int()
      .describe("How many items the job has changed so far."),
    errored: z
      .number()
      .int()
      .describe("How many items the job has left unchanged so far."),
    started_at: z
      .string()
      .optional()
      .describe("When the job started running, in UTC. Absent until then."),
    finished_at: z
      .string()
      .optional()
      .describe(
        "When the job completed, failed or was canceled, in UTC. Absent until then.",
      ),
    error: z
      .string()
      .optional()
      .describe(
        "Why the job failed, for a person to read. Present only when `status` is `failed`.",
      ),
    result: BulkActionResultSchema.optional().describe(
      "What the job did. Present once `status` is `completed` or `failed`.",
    ),
  })
  .describe("A bulk action Marfa runs in the background, with its progress.")
  .openapi("BulkActionJob");

export type BulkActionJob = z.infer<typeof BulkActionJobSchema>;

/** This module's part of `DESCRIBED_ONLY_BY_REFERENCE` in `_schemas.ts`. */
export const BULK_ACTION_SCHEMAS_DESCRIBED_BY_REFERENCE: Readonly<
  Record<string, z.ZodType>
> = {
  BulkActionJobStatus: BulkActionJobStatusSchema,
  BulkActionResult: BulkActionResultSchema,
};
