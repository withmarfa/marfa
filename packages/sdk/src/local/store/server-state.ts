import { eq, inArray } from "drizzle-orm";
import type { Edge, Item, Metadata } from "@withmarfa/shared";
import type { Executor } from "./executor.js";
import { serverEdges, serverItems, serverMetadata } from "./schema.js";

/**
 * Drop the fields the server works out as an item goes out rather than
 * storing.
 *
 * `orphaned` answers whether the integration that wrote the item still has
 * a live connection, computed from the space's connections at the moment of
 * the read. Persisting it would let one read's answer outlive the fact it
 * described, and the stream never carries the field at all, so nothing
 * would ever correct it.
 */
export function stripDerived(item: Item): Item {
  if (item.orphaned === undefined) return item;
  const stored = { ...item };
  delete stored.orphaned;
  return stored;
}

export interface ServerItemLayer {
  get(id: string): Promise<Item | undefined>;
  list(filters?: { type?: string }): Promise<Item[]>;
  put(item: Item): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface ServerEdgeLayer {
  get(id: string): Promise<Edge | undefined>;
  list(): Promise<Edge[]>;
  put(edge: Edge): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The metadata layer is separate because its writer is separate. An item
 *  event carries no tags and no extensions, so an engine that folded the
 *  two together would erase them on every ordinary edit. */
export interface ServerMetadataLayer {
  get(itemId: string): Promise<Metadata | undefined>;
  put(metadata: Metadata): Promise<void>;
  remove(itemId: string): Promise<void>;
}

export interface ServerStateLayer {
  items: ServerItemLayer;
  edges: ServerEdgeLayer;
  metadata: ServerMetadataLayer;
}

export function createServerStateLayer(exec: Executor): ServerStateLayer {
  return {
    items: {
      get: async (id) => {
        const rows = await exec
          .select({ payload: serverItems.payload })
          .from(serverItems)
          .where(eq(serverItems.id, id));
        const payload = rows[0]?.payload;
        return payload === undefined
          ? undefined
          : (JSON.parse(payload) as Item);
      },
      list: async (filters) => {
        const query = exec
          .select({ payload: serverItems.payload })
          .from(serverItems);
        const rows = await (filters?.type === undefined
          ? query
          : query.where(eq(serverItems.type, filters.type)));
        return rows.map((row) => JSON.parse(row.payload) as Item);
      },
      put: async (item) => {
        const stored = stripDerived(item);
        await exec
          .insert(serverItems)
          .values({
            id: stored.id,
            type: stored.type,
            version: stored.version,
            state: stored.state,
            spaceId: stored.space_id ?? null,
            updatedAt: stored.updated_at,
            payload: JSON.stringify(stored),
          })
          .onConflictDoUpdate({
            target: serverItems.id,
            set: {
              type: stored.type,
              version: stored.version,
              state: stored.state,
              spaceId: stored.space_id ?? null,
              updatedAt: stored.updated_at,
              payload: JSON.stringify(stored),
            },
          });
      },
      remove: async (id) => {
        await exec.delete(serverItems).where(eq(serverItems.id, id));
        await exec.delete(serverMetadata).where(eq(serverMetadata.itemId, id));
      },
    },

    edges: {
      get: async (id) => {
        const rows = await exec
          .select({ payload: serverEdges.payload })
          .from(serverEdges)
          .where(eq(serverEdges.id, id));
        const payload = rows[0]?.payload;
        return payload === undefined
          ? undefined
          : (JSON.parse(payload) as Edge);
      },
      list: async () => {
        const rows = await exec
          .select({ payload: serverEdges.payload })
          .from(serverEdges);
        return rows.map((row) => JSON.parse(row.payload) as Edge);
      },
      put: async (edge) => {
        const values = {
          id: edge.id,
          edgeType: edge.edge_type,
          sourceId: edge.source_id,
          targetId: edge.target_id,
          version: edge.version,
          updatedAt: edge.updated_at,
          payload: JSON.stringify(edge),
        };
        await exec
          .insert(serverEdges)
          .values(values)
          .onConflictDoUpdate({ target: serverEdges.id, set: values });
      },
      remove: async (id) => {
        await exec.delete(serverEdges).where(eq(serverEdges.id, id));
      },
    },

    metadata: {
      get: async (itemId) => {
        const rows = await exec
          .select({ payload: serverMetadata.payload })
          .from(serverMetadata)
          .where(eq(serverMetadata.itemId, itemId));
        const payload = rows[0]?.payload;
        return payload === undefined
          ? undefined
          : (JSON.parse(payload) as Metadata);
      },
      put: async (metadata) => {
        const values = {
          itemId: metadata.item_id,
          payload: JSON.stringify(metadata),
        };
        await exec
          .insert(serverMetadata)
          .values(values)
          .onConflictDoUpdate({ target: serverMetadata.itemId, set: values });
      },
      remove: async (itemId) => {
        await exec
          .delete(serverMetadata)
          .where(inArray(serverMetadata.itemId, [itemId]));
      },
    },
  };
}
