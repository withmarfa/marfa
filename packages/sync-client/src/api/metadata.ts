/**
 * Metadata + extensions API. Reads come from PGlite (the metadata
 * table is populated by Electric); writes apply optimistically and
 * queue for drain.
 *
 * Internally `metadata.tags` is a JSON-encoded string array;
 * `metadata.extensions` is a JSON-encoded `{ [namespace]: data }`
 * map. Server uses the same shape — Electric replicates the rows
 * verbatim.
 */

import type { Metadata } from "@mymehq/shared";
import type { PGliteWithSync } from "../storage/pglite.js";
import type { MutationQueue } from "../queue/queue.js";
import type { DrainLoop } from "../queue/drain.js";
import type { SyncEventEmitter } from "../events/emitter.js";

export interface MetadataApiOptions {
  pg: PGliteWithSync;
  queue: MutationQueue;
  drain: DrainLoop;
  emitter: SyncEventEmitter;
}

interface MetadataRow {
  item_id: string;
  tags: string;
  extensions: string;
}

function rowToMetadata(row: MetadataRow): Metadata {
  let tags: string[] = [];
  let extensions: Record<string, Record<string, unknown>> = {};
  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    /* defensive */
  }
  try {
    extensions = JSON.parse(row.extensions) as Record<
      string,
      Record<string, unknown>
    >;
  } catch {
    /* defensive */
  }
  return {
    item_id: row.item_id,
    tags,
    extensions,
  };
}

export class MetadataApi {
  constructor(private readonly options: MetadataApiOptions) {}

  async get(itemId: string): Promise<Metadata> {
    const r = await this.options.pg.query<MetadataRow>(
      `SELECT * FROM metadata WHERE item_id = $1 LIMIT 1`,
      [itemId],
    );
    const row = r.rows[0];
    if (row) return rowToMetadata(row);
    return { item_id: itemId, tags: [], extensions: {} };
  }

  async set(itemId: string, input: { tags?: string[] }): Promise<Metadata> {
    const tags = input.tags ?? [];
    await this.options.pg.query(
      `INSERT INTO metadata (item_id, tags, extensions)
       VALUES ($1, $2, '{}')
       ON CONFLICT (item_id) DO UPDATE SET tags = EXCLUDED.tags`,
      [itemId, JSON.stringify(tags)],
    );
    await this.enqueue("setMetadata", { itemId, tags }, itemId);
    return this.get(itemId);
  }

  async merge(itemId: string, input: { tags?: string[] }): Promise<Metadata> {
    const existing = await this.get(itemId);
    const merged = input.tags
      ? Array.from(new Set([...existing.tags, ...input.tags]))
      : existing.tags;
    await this.options.pg.query(
      `INSERT INTO metadata (item_id, tags, extensions)
       VALUES ($1, $2, '{}')
       ON CONFLICT (item_id) DO UPDATE SET tags = EXCLUDED.tags`,
      [itemId, JSON.stringify(merged)],
    );
    await this.enqueue("mergeMetadata", { itemId, tags: input.tags }, itemId);
    return this.get(itemId);
  }

  async addTags(itemId: string, tags: string[]): Promise<Metadata> {
    return this.merge(itemId, { tags });
  }

  async removeTag(itemId: string, tag: string): Promise<void> {
    const existing = await this.get(itemId);
    const next = existing.tags.filter((t) => t !== tag);
    await this.options.pg.query(
      `INSERT INTO metadata (item_id, tags, extensions)
       VALUES ($1, $2, '{}')
       ON CONFLICT (item_id) DO UPDATE SET tags = EXCLUDED.tags`,
      [itemId, JSON.stringify(next)],
    );
    await this.enqueue("removeTag", { itemId, tag }, itemId);
  }

  async getExtensions(
    itemId: string,
    namespace?: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    const meta = await this.get(itemId);
    if (namespace) {
      const data = meta.extensions[namespace];
      return data ? { [namespace]: data } : {};
    }
    return meta.extensions;
  }

  async setExtension(
    itemId: string,
    namespace: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, Record<string, unknown>>> {
    const existing = await this.get(itemId);
    const nextExt = { ...existing.extensions, [namespace]: data };
    await this.options.pg.query(
      `INSERT INTO metadata (item_id, tags, extensions)
       VALUES ($1, '[]', $2)
       ON CONFLICT (item_id) DO UPDATE SET extensions = EXCLUDED.extensions`,
      [itemId, JSON.stringify(nextExt)],
    );
    await this.enqueue(
      "setExtension",
      { itemId, namespace, data },
      itemId,
    );
    return nextExt;
  }

  async deleteExtension(itemId: string, namespace: string): Promise<void> {
    const existing = await this.get(itemId);
    const nextExt = { ...existing.extensions };
    delete nextExt[namespace];
    await this.options.pg.query(
      `INSERT INTO metadata (item_id, tags, extensions)
       VALUES ($1, '[]', $2)
       ON CONFLICT (item_id) DO UPDATE SET extensions = EXCLUDED.extensions`,
      [itemId, JSON.stringify(nextExt)],
    );
    await this.enqueue("deleteExtension", { itemId, namespace }, itemId);
  }

  private async enqueue(
    kind:
      | "setMetadata"
      | "mergeMetadata"
      | "removeTag"
      | "setExtension"
      | "deleteExtension",
    payload:
      | { itemId: string; tags?: string[] }
      | { itemId: string; tag: string }
      | { itemId: string; namespace: string; data: Record<string, unknown> }
      | { itemId: string; namespace: string },
    targetId: string,
  ): Promise<void> {
    let envelope:
      | { kind: "setMetadata"; payload: { itemId: string; tags?: string[] } }
      | { kind: "mergeMetadata"; payload: { itemId: string; tags?: string[] } }
      | { kind: "removeTag"; payload: { itemId: string; tag: string } }
      | {
          kind: "setExtension";
          payload: {
            itemId: string;
            namespace: string;
            data: Record<string, unknown>;
          };
        }
      | {
          kind: "deleteExtension";
          payload: { itemId: string; namespace: string };
        };
    switch (kind) {
      case "setMetadata":
        envelope = {
          kind: "setMetadata",
          payload: payload as { itemId: string; tags?: string[] },
        };
        break;
      case "mergeMetadata":
        envelope = {
          kind: "mergeMetadata",
          payload: payload as { itemId: string; tags?: string[] },
        };
        break;
      case "removeTag":
        envelope = {
          kind: "removeTag",
          payload: payload as { itemId: string; tag: string },
        };
        break;
      case "setExtension":
        envelope = {
          kind: "setExtension",
          payload: payload as {
            itemId: string;
            namespace: string;
            data: Record<string, unknown>;
          },
        };
        break;
      case "deleteExtension":
        envelope = {
          kind: "deleteExtension",
          payload: payload as { itemId: string; namespace: string },
        };
        break;
    }
    const writeId = await this.options.queue.enqueue(envelope, { targetId });
    this.options.emitter.emit("mutation.queued", {
      id: writeId,
      kind,
      enqueuedAt: new Date(),
    });
    this.options.drain.wake();
  }
}
