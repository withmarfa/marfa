import { generateId } from "@withmarfa/shared";
import type { Edge, Item } from "@withmarfa/shared";
import type { OutboxLayer } from "./outbox.js";
import type { ServerStateLayer } from "./server-state.js";
import type { VisibleLayer } from "./visible.js";

export interface CreateItemMutation {
  type: string;
  properties: Record<string, unknown>;
  /** Minted here when the caller does not name one. A client names its own
   *  rows so the row is on screen before the server has seen it, and so a
   *  create whose response was lost can be resent as a repeat rather than
   *  as a second row. */
  id?: string;
  tier?: Item["tier"];
  timestamp?: string;
  source_id?: string;
}

export interface CreateEdgeMutation {
  source_id: string;
  target_id: string;
  edge_type: string;
  properties?: Record<string, unknown>;
  id?: string;
}

/**
 * The writes an app makes.
 *
 * Each one lands as a single queued mutation inside one transaction, so a
 * write is never visible without being queued and never queued without
 * being visible — there is only one row, and it is the queue's.
 */
export interface MutationLayer {
  createItem(input: CreateItemMutation): Promise<Item>;
  updateItem(id: string, properties: Record<string, unknown>): Promise<Item>;
  deleteItem(id: string): Promise<void>;
  createEdge(input: CreateEdgeMutation): Promise<Edge>;
  updateEdge(id: string, properties: Record<string, unknown>): Promise<Edge>;
  deleteEdge(id: string): Promise<void>;
}

export interface MutationDeps {
  server: ServerStateLayer;
  outbox: OutboxLayer;
  visible: VisibleLayer;
  now: () => string;
}

function missing(kind: string, id: string): Error {
  return new Error(
    `@withmarfa/sdk/local: no ${kind} ${id} in this store, so there is nothing to change`,
  );
}

export function createMutationLayer(deps: MutationDeps): MutationLayer {
  const { server, outbox, visible, now } = deps;

  return {
    createItem: async (input) => {
      const id = input.id ?? generateId();
      const at = now();
      const payload: Record<string, unknown> = {
        id,
        type: input.type,
        properties: input.properties,
        ...(input.tier === undefined ? {} : { tier: input.tier }),
        ...(input.timestamp === undefined
          ? {}
          : { timestamp: input.timestamp }),
        ...(input.source_id === undefined
          ? {}
          : { source_id: input.source_id }),
      };
      await outbox.enqueue({
        id: generateId(),
        kind: "item.create",
        targetKind: "item",
        targetId: id,
        payload,
        baseVersion: null,
        idempotencyKey: generateId(),
        now: at,
      });
      const created = await visible.getItem(id);
      if (created === undefined) throw missing("item", id);
      return created;
    },

    updateItem: async (id, properties) => {
      const held = await visible.getItem(id);
      if (held === undefined) throw missing("item", id);
      // The version the row was read at, from server state. Null while the
      // row's own create is still queued: there is no server version to
      // name yet, and the drain resolves one from the create's response.
      const known = await server.items.get(id);
      await outbox.enqueue({
        id: generateId(),
        kind: "item.update",
        targetKind: "item",
        targetId: id,
        // Only what changed. An update carrying the whole property bag
        // turns every field into a candidate for conflict.
        payload: { properties, ...(known ? { type: known.type } : {}) },
        baseVersion: known?.version ?? null,
        idempotencyKey: generateId(),
        now: now(),
      });
      const updated = await visible.getItem(id);
      if (updated === undefined) throw missing("item", id);
      return updated;
    },

    deleteItem: async (id) => {
      const held = await visible.getItem(id);
      if (held === undefined) throw missing("item", id);
      await outbox.enqueue({
        id: generateId(),
        kind: "item.delete",
        targetKind: "item",
        targetId: id,
        payload: {},
        baseVersion: null,
        idempotencyKey: generateId(),
        now: now(),
      });
    },

    createEdge: async (input) => {
      const id = input.id ?? generateId();
      await outbox.enqueue({
        id: generateId(),
        kind: "edge.create",
        targetKind: "edge",
        targetId: id,
        // Both endpoints, so the edge waits behind either one's unsent
        // create. An edge sent against a row the server does not have is
        // refused, and the person loses a relationship they made.
        dependsOn: [input.source_id, input.target_id],
        payload: {
          id,
          edge_type: input.edge_type,
          source_id: input.source_id,
          target_id: input.target_id,
          properties: input.properties ?? {},
        },
        baseVersion: null,
        idempotencyKey: generateId(),
        now: now(),
      });
      const created = await visible.getEdge(id);
      if (created === undefined) throw missing("edge", id);
      return created;
    },

    updateEdge: async (id, properties) => {
      const held = await visible.getEdge(id);
      if (held === undefined) throw missing("edge", id);
      const known = await server.edges.get(id);
      await outbox.enqueue({
        id: generateId(),
        kind: "edge.update",
        targetKind: "edge",
        targetId: id,
        dependsOn: [held.source_id, held.target_id],
        payload: { properties },
        baseVersion: known?.version ?? null,
        idempotencyKey: generateId(),
        now: now(),
      });
      const updated = await visible.getEdge(id);
      if (updated === undefined) throw missing("edge", id);
      return updated;
    },

    deleteEdge: async (id) => {
      const held = await visible.getEdge(id);
      if (held === undefined) throw missing("edge", id);
      await outbox.enqueue({
        id: generateId(),
        kind: "edge.delete",
        targetKind: "edge",
        targetId: id,
        dependsOn: [held.source_id, held.target_id],
        payload: {},
        baseVersion: null,
        idempotencyKey: generateId(),
        now: now(),
      });
    },
  };
}
