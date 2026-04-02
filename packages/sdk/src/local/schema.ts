import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Local client SQLite schema — mirrors the server tables that Electric syncs.

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    state: text("state").notNull().default("new"),
    properties: text("properties").notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    timestamp: text("timestamp").notNull(),
    source: text("source"),
    source_id: text("source_id"),
    origin: text("origin"),
    version: integer("version").notNull().default(1),
    schema_version: integer("schema_version"),
    device_id: text("device_id"),
    parent_id: text("parent_id"),
    thread_id: text("thread_id"),
    capture_latitude: real("capture_latitude"),
    capture_longitude: real("capture_longitude"),
  },
  (table) => [
    index("idx_local_items_type").on(table.type),
    index("idx_local_items_state").on(table.state),
    index("idx_local_items_thread_id").on(table.thread_id),
    index("idx_local_items_created_at").on(table.created_at),
    uniqueIndex("idx_local_items_source_dedup")
      .on(table.source, table.source_id)
      .where(sql`source IS NOT NULL`),
  ],
);

export const metadata = sqliteTable("metadata", {
  item_id: text("item_id").primaryKey(),
  tags: text("tags").notNull().default("[]"),
  about: text("about").notNull().default("[]"),
});

// Client-only tables

export const syncState = sqliteTable("sync_state", {
  table_name: text("table_name").primaryKey(),
  offset: text("offset").notNull().default("-1"),
  shape_handle: text("shape_handle"),
  updated_at: text("updated_at").notNull(),
});

export const mutationQueue = sqliteTable(
  "mutation_queue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    operation: text("operation").notNull(),
    entity_type: text("entity_type").notNull(),
    entity_id: text("entity_id").notNull(),
    payload: text("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [index("idx_mutation_queue_status").on(table.status)],
);
