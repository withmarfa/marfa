/**
 * Reusable Zod schemas shared across route files.
 *
 * Lift-out from items.ts / threads.ts / search.ts (Wave 2 PR 2). Wave 1
 * had three separate ItemSchema declarations that drifted from the
 * runtime types and from each other; the response-schema fix-up commits
 * (14dc0ca / a093454) had to repair all three. Wave 2's edges work will
 * grow the Item shape further — extracting now keeps the addition local
 * to a single file rather than a four-way duplication.
 */
import { z } from "@hono/zod-openapi";

export const ItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  properties: z.record(z.string(), z.unknown()),
  state: z.enum(["active", "archived", "trashed"]),
  library: z.boolean(),
  version: z.number(),
  schema_version: z.number().int(),
  thread_id: z.string().nullable(),
  parent_id: z.string().nullable(),
  source: z.string(),
  source_id: z.string().optional(),
  origin: z.enum(["user", "ai", "worker"]),
  device: z.string().optional(),
  capture_latitude: z.number().optional(),
  capture_longitude: z.number().optional(),
  timestamp: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const MetadataSchema = z.object({
  item_id: z.string(),
  tags: z.array(z.string()),
  about: z.array(z.string()),
  extensions: z.record(z.string(), z.unknown()),
});

export const ItemWithMetadataSchema = z.object({
  item: ItemSchema,
  metadata: MetadataSchema,
});
