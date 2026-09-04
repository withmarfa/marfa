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
  /**
   * Refuse a write the type forbids, before anything is queued.
   *
   * A hook rather than a direct call so the store keeps no opinion about
   * where the type graph comes from — and so a caller that has a reason to
   * queue an unvalidated write has somewhere to say so, rather than
   * reaching around the mutation layer entirely.
   */
  refuse: (type: string, properties: Record<string, unknown>) => void;
}

function missing(kind: string, id: string): Error {
  return new Error(
    `@withmarfa/sdk/local: no ${kind} ${id} in this store, so there is nothing to change`,
  );
}

export function createMutationLayer(deps: MutationDeps): MutationLayer {
  const { server, outbox, visible, now, refuse } = deps;

  return {
    createItem: async (input) => {
      // Before the id is minted and before anything is written. A refusal
      // that arrives after the row exists locally has already put a ghost
      // on screen that has to be taken away again.
      refuse(input.type, input.properties);
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
      // Validated as the merged row rather than as the patch, which is
      // what the server does on this door too: an update carries only what
      // changed, so validating the patch alone would fail every required
      // field the edit did not touch and refuse writes the server accepts.
      //
      // A shallow merge is the whole of it, because the reading of a null
      // is already inside the validator both sides call: on an optional
      // field a null means "leave unset" and validates, so nothing has to
      // be coerced here to keep this from being stricter than the server.
      // That direction is the one that must never be wrong — a local
      // validator stricter than the server refuses work a person would
      // have kept.
      refuse(held.type, { ...held.properties, ...properties });
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
