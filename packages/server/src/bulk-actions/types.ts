/**
 * Server-internal types for the bulk_action substrate.
 *
 * Mirrors the public SDK shapes in `@withmarfa/sdk` (`BulkActionInput`,
 * `BulkActionResult`, `BulkActionJob`) so the server can carry them
 * without depending on the SDK package. Wire-shape compatibility is
 * enforced by the openapi-freshness CI gate.
 */
import { z } from "@hono/zod-openapi";
import { ItemStateEnum } from "../routes/_schemas.js";
import type { DeclaresKeys } from "../routes/_unknown-query-keys.js";

/**
 * The bulk-action match set, and the only declaration of it.
 *
 * Filter fields carry the same semantics as the `GET /items` query. One
 * JSON object so bulk_action callers don't have to shove a filter
 * expression through query-string encoding.
 *
 * `POST /items/bulk-actions` used to declare this shape a second time in
 * its own route file, field for field, with nothing holding the two in
 * step: the openapi-freshness gate compares the generated specification
 * against the routes, so it watched the route copy and not this one. Two
 * renames and a missing lifecycle state later, the route imports this
 * instead. Keeping the declaration here rather than in the route is what
 * lets the substrate hold the shape without depending on the published
 * client package, which is why the copy existed at all.
 */
export const BulkActionFilterShape = z.object({
  type: z.string().optional(),
  // The default was discoverable only by reading the handler, which is the
  // shape that made anyone ask whether the two doors agreed. They do: this
  // filter's `state` goes straight to the same item query `GET /items` uses,
  // and neither door sets the widening flag, so an omitted value excludes
  // trashed rows on both. Said here so the answer no longer needs the source.
  state: ItemStateEnum.optional().describe(
    "Filter by lifecycle state. Omitting it applies the same default as `GET /items`: trashed rows are excluded. There is no `any` sentinel on this door — these four states are the whole structured vocabulary it accepts.",
  ),
  source: z.string().optional(),
  tier: z.enum(["library", "feed"]).optional(),
  tags: z.array(z.string()).optional(),
  occurred_after: z
    .string()
    .optional()
    .describe(
      "Lower bound on the item's own time — `occurred_at`, falling back to `created_at` — strictly after this. Exclusive, as every bound but `updated_after` is.",
    ),
  occurred_before: z
    .string()
    .optional()
    .describe(
      "Upper bound on the same expression, strictly before this. Exclusive, matching its lower twin.",
    ),
  /** Full filter-SQL DSL string, same grammar as GET /items?filter=. */
  filter: z.string().optional(),
});

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
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("update_tags"),
    add: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional(),
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("update_tier"),
    tier: z.enum(["library", "feed"]),
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("update_properties"),
    patch: z.record(z.string(), z.unknown()),
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

export const BulkActionErrorEntrySchema = z.object({
  id: z.string(),
  code: z.string(),
  message: z.string(),
});

export type BulkActionErrorEntry = z.infer<typeof BulkActionErrorEntrySchema>;

export const BulkActionResultSchema = z.object({
  action: z.string(),
  matched: z.number().int(),
  succeeded: z.number().int(),
  errored: z.number().int(),
  dry_run: z.boolean(),
  ids: z.array(z.string()).optional(),
  errors: z.array(BulkActionErrorEntrySchema).optional(),
  blob_hashes_referenced: z.number().int().optional(),
});

export type BulkActionResult = z.infer<typeof BulkActionResultSchema>;

export const BulkActionJobStatusSchema = z.enum([
  "queued",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);

export const BulkActionJobSchema = z.object({
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
});

export type BulkActionJob = z.infer<typeof BulkActionJobSchema>;
