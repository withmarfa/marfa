/**
 * Shape definitions for the three families the sync-client subscribes
 * to. The sync proxy on the Myme server handles permission filtering
 * and tenant scoping; the client doesn't need to thread permissions
 * into shape `where` clauses.
 *
 * Each family ↔ Postgres table is fixed. Adding new families requires
 * coordinated server + client changes (the proxy validates the family
 * param against the same closed set).
 */

export const SHAPE_FAMILIES = ["items", "edges", "metadata"] as const;
export type ShapeFamily = (typeof SHAPE_FAMILIES)[number];

export interface ShapeDescriptor {
  family: ShapeFamily;
  /** Local PGlite table that receives the replicated rows. */
  table: string;
  /** Primary key column(s) — always `['id']` except metadata. */
  primaryKey: string[];
  /** Stable string used as `shapeKey` so resumption survives restart. */
  shapeKey: string;
}

export const SHAPE_DESCRIPTORS: Record<ShapeFamily, ShapeDescriptor> = {
  items: {
    family: "items",
    table: "items",
    primaryKey: ["id"],
    shapeKey: "myme.items",
  },
  edges: {
    family: "edges",
    table: "edges",
    primaryKey: ["id"],
    shapeKey: "myme.edges",
  },
  metadata: {
    family: "metadata",
    table: "metadata",
    // Metadata uses item_id as its key; one row per item.
    primaryKey: ["item_id"],
    shapeKey: "myme.metadata",
  },
};

/**
 * Build the URL for a shape family's request to the sync proxy.
 * The proxy's path layout is `/sync/shapes/:family`; we don't pass
 * additional params here — the proxy derives `where` and `params` from
 * the API key's permissions on its end.
 */
export function shapeUrl(syncBaseUrl: string, family: ShapeFamily): string {
  return `${syncBaseUrl.replace(/\/+$/, "")}/shapes/${family}`;
}
