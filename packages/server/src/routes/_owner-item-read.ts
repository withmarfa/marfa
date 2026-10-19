import type { Context, MiddlewareHandler } from "hono";
import type { Edge, Item, Metadata } from "@withmarfa/shared";
import {
  getTypeFilter,
  requireAuth,
  mayReadType,
  standingRule,
  type AppEnv,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { edgeKindReadable } from "./_edge-visibility.js";
import { readableMetadata } from "./_extension-reach.js";
import { mayReadBlob } from "./_blob-reach.js";
import { withCascadeMarks } from "./_cascade-marks.js";

/** Only these two browser reads admit owner authority, never private transport. */
function isOwnerItemRead(c: Context<AppEnv>): boolean {
  return (
    c.req.method === "GET" &&
    ["/items/stats", "/export"].includes(c.req.path.replace(/\/$/, "")) &&
    c.get("authority")?.kind === "owner" &&
    c.req.header("authorization") === undefined &&
    !c.get("apiKey")
  );
}

export const ownerItemReadSecurity: Record<string, string[]>[] = [
  { bearerAuth: [] },
  { ownerSession: [] },
];

export const readsOwnerItems: MiddlewareHandler<AppEnv> = standingRule(
  "reads some type, or owner browser session",
  (c) => {
    if (!isOwnerItemRead(c)) getTypeFilter(c);
  },
);

/** Explicit read capabilities, without projecting the owner into an API key. */
export function ownerItemRead(c: Context<AppEnv>) {
  const owner = isOwnerItemRead(c);
  const key = owner ? undefined : requireAuth(c);
  const reads = key ? (type: string) => mayReadType(key, type) : () => true;
  const permissions =
    c.get("authType") === "oauth"
      ? (c.get("oauthGrant")?.scopes ?? [])
      : (key?.permissions ?? []);
  return {
    owner,
    reads,
    types: key ? getTypeFilter(c) : { allowed: undefined, excluded: [] },
    edge: (edge: Edge) => (key ? edgeKindReadable(key, edge) : true),
    metadata: (metadata: Metadata) =>
      key ? readableMetadata(metadata, key) : metadata,
    cascade: (storage: Storage, rows: Item[]) =>
      withCascadeMarks(storage, key ?? reads, rows),
    blob: (storage: Storage, hash: string) =>
      key
        ? mayReadBlob(key, storage, hash, permissions)
        : Promise.resolve(true),
  };
}
export type OwnerItemRead = ReturnType<typeof ownerItemRead>;
