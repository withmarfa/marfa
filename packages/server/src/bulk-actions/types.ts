/**
 * T-218: server-internal types for the bulk_action substrate.
 *
 * Mirrors the public SDK shapes in `@withmarfa/sdk` (`BulkActionInput`,
 * `BulkActionResult`, `BulkActionJob`) so the server can carry them
 * without depending on the SDK package. Wire-shape compatibility is
 * enforced by the openapi-freshness CI gate.
 */
import { z } from "@hono/zod-openapi";

export const BulkActionFilterSchema = z
  .object({
    type: z.string().optional(),
    state: z.enum(["active", "archived", "trashed"]).optional(),
    source: z.string().optional(),
    tier: z.enum(["library", "feed"]).optional(),
    tags: z.array(z.string()).optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    filter: z.string().optional(),
  })
  .optional();

const BulkActionBaseSchema = z.object({
  filter: BulkActionFilterSchema,
  dry_run: z.boolean().optional(),
  max_items: z.number().int().positive().optional(),
  emit_events: z.boolean().optional(),
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
