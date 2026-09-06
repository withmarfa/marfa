import { coerceNullProperties } from "@withmarfa/shared";
import type { Edge, Item, Metadata } from "@withmarfa/shared";
import type { OutboxEntry } from "../types.js";
import type { OutboxLayer } from "./outbox.js";
import type { ServerStateLayer } from "./server-state.js";

/**
 * What this client sees: server state with its own queued mutations
 * replayed over the top.
 *
 * Three layers rather than one, and this is the third. Nothing writes a
 * "local" copy of a row: a mutation's outbox entry *is* the pending edit,
 * so an inbound change to a different field lands in server state and this
 * recomputes over it, and a pending local edit cannot be hidden by it. It
 * also settles what rolling a row back means — the outbox entry leaves, and
 * the row falls back to what the server holds, with nothing to undo.
 *
 * The replay walks the queue in sequence order, which is the order the
 * person made the edits in.
 */
export interface VisibleLayer {
  getItem(id: string): Promise<Item | undefined>;
  listItems(filters?: { type?: string }): Promise<Item[]>;
  getEdge(id: string): Promise<Edge | undefined>;
  listEdges(): Promise<Edge[]>;
  /** The metadata layer as held. Nothing queues a metadata write yet, so
   *  this is server state unmodified rather than a replay. */
  getMetadata(itemId: string): Promise<Metadata | undefined>;
}

/**
 * The item a create stands for before the server has seen it.
 *
 * `version` and `schema_version` are zero because neither exists yet: the
 * server stamps both, and a client that guessed would produce a row that
 * compares wrongly against the first event to arrive. `source` is empty for
 * the same reason — it comes from the credential, at the server.
 */
function ghostItem(entry: OutboxEntry): Item {
  const payload = entry.payload as {
    id: string;
    type: string;
    properties?: Record<string, unknown>;
    timestamp?: string;
    tier?: Item["tier"];
    source_id?: string;
    state?: Item["state"];
  };
  return {
    id: payload.id,
    type: payload.type,
    state: payload.state ?? "active",
    properties: payload.properties ?? {},
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    timestamp: payload.timestamp ?? entry.createdAt,
    source: "",
    version: 0,
    schema_version: 0,
    ...(payload.tier === undefined ? {} : { tier: payload.tier }),
    ...(payload.source_id === undefined
      ? {}
      : { source_id: payload.source_id }),
  };
}

function ghostEdge(entry: OutboxEntry): Edge {
  const payload = entry.payload as {
    id: string;
    edge_type: string;
    source_id: string;
    target_id: string;
    properties?: Record<string, unknown>;
  };
  return {
    id: payload.id,
    edge_type: payload.edge_type,
    source_id: payload.source_id,
    target_id: payload.target_id,
    properties: payload.properties ?? {},
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    version: 0,
  };
}

function applyItemMutation(
  held: Item | undefined,
  entry: OutboxEntry,
  spaceId: string | null,
): Item | undefined {
  switch (entry.kind) {
    case "item.create":
      return ghostItem(entry);
    case "item.update": {
      if (held === undefined) return undefined;
      const patch = (entry.payload.properties ?? {}) as Record<string, unknown>;
      return {
        ...held,
        // Through the server's own coercion rather than a plain merge,
        // because this row is a prediction of the one the update will
        // produce and the door reads a null on an optional field as
        // "unset". Kept as a stored null it showed a value that was never
        // written, with nothing to say so: the write is accepted, nothing
        // errors, and on a quiet space nothing overwrites the projection.
        //
        // The shared function rather than the rule spelled out again. A
        // restated copy is free to drift the moment the field-requiredness
        // it reads from changes, and it would drift silently — which is the
        // same failure from the other side.
        properties: {
          ...held.properties,
          ...coerceNullProperties(held.type, patch, spaceId),
        },
        updated_at: entry.updatedAt,
      };
    }
    case "item.delete":
      return undefined;
    default:
      return held;
  }
}

function applyEdgeMutation(
  held: Edge | undefined,
  entry: OutboxEntry,
): Edge | undefined {
  switch (entry.kind) {
    case "edge.create":
      return ghostEdge(entry);
    case "edge.update": {
      if (held === undefined) return undefined;
      const patch = (entry.payload.properties ?? {}) as Record<string, unknown>;
      return {
        ...held,
        properties: { ...held.properties, ...patch },
        updated_at: entry.updatedAt,
      };
    }
    case "edge.delete":
      return undefined;
    default:
      return held;
  }
}

/**
 * @param spaceId The space to resolve types under, in the registry's own
 * sentinel — `null` on a server with no spaces. A type registered by one
 * space declares its own required fields, so a space-blind projection would
 * classify another space's field and coerce the wrong nulls.
 */
export function createVisibleLayer(
  server: ServerStateLayer,
  outbox: OutboxLayer,
  spaceId: string | null,
): VisibleLayer {
  const replayItem = async (
    id: string,
    base: Item | undefined,
  ): Promise<Item | undefined> => {
    let held = base;
    for (const entry of await outbox.listForTarget(id)) {
      if (entry.targetKind !== "item") continue;
      held = applyItemMutation(held, entry, spaceId);
    }
    return held;
  };

  return {
    getItem: async (id) => replayItem(id, await server.items.get(id)),

    listItems: async (filters) => {
      const held = new Map<string, Item>();
      for (const item of await server.items.list(filters)) {
        held.set(item.id, item);
      }
      // Every queued item mutation, not only those for rows already held:
      // a create's row exists nowhere else, so filtering to known ids would
      // hide exactly the writes this client has not sent.
      for (const entry of await outbox.list()) {
        if (entry.targetKind !== "item") continue;
        const next = applyItemMutation(
          held.get(entry.targetId),
          entry,
          spaceId,
        );
        if (next === undefined) held.delete(entry.targetId);
        else if (filters?.type === undefined || next.type === filters.type) {
          held.set(entry.targetId, next);
        }
      }
      return [...held.values()];
    },

    getEdge: async (id) => {
      let held = await server.edges.get(id);
      for (const entry of await outbox.listForTarget(id)) {
        if (entry.targetKind !== "edge") continue;
        held = applyEdgeMutation(held, entry);
      }
      return held;
    },

    listEdges: async () => {
      const held = new Map<string, Edge>();
      for (const edge of await server.edges.list()) held.set(edge.id, edge);
      for (const entry of await outbox.list()) {
        if (entry.targetKind !== "edge") continue;
        const next = applyEdgeMutation(held.get(entry.targetId), entry);
        if (next === undefined) held.delete(entry.targetId);
        else held.set(entry.targetId, next);
      }
      return [...held.values()];
    },

    getMetadata: async (itemId) => server.metadata.get(itemId),
  };
}
