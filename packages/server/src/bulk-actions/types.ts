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
export const BulkActionFilterSchema = z
  .object({
    type: z.string().optional(),
    state: ItemStateEnum.optional(),
    source: z.string().optional(),
    tier: z.enum(["library", "feed"]).optional(),
    tags: z.array(z.string()).optional(),
    timestamp_after: z.string().optional(),
    timestamp_before: z.string().optional(),
    /** Full filter-SQL DSL string, same grammar as GET /items?filter=. */
    filter: z.string().optional(),
  })
  .optional();

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
    action: z.literal("update_timestamp"),
    timestamp: z.string(),
  }),
]);

export type BulkActionInput = z.infer<typeof BulkActionInputSchema>;

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
