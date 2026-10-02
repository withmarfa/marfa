/**
 * The one guard every door that changes the type or edge-type registry asks.
 *
 * **The permission opens the door; the key's maps say which names behind
 * it.** `metadata.types:write`, `metadata.edge_types:write` and
 * `schema.write` admit a key to a registry, and none of them says whose
 * types it reaches. Without the map, a key confined to its own namespace
 * could replace or force-delete another integration's type, or delete
 * another publisher's edge type, through a door its permission opens. So a
 * door asks both halves together: write on the type identifier in the type
 * map, and write on the edge type's id and reverse name in the edge map,
 * the names a registration claims. `schema-door-census.test.ts` fails on a
 * changing door that does not.
 */
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireEdgePermission,
  requireMetadataPermission,
  requirePermission,
  requireTypeAccess,
  standingPermission,
  standingRule,
} from "../middleware/auth.js";

/** Asked of every caller of a door that replaces or deletes a type or an
 *  edge type, before the request is read. */
export const changesSchema = standingPermission("schema.write");

/** Asked of every caller of the type registration door. */
export const registersType = standingRule("metadata.types:write", (c) => {
  requireSchemaRegistration(c, "types");
});

/** Asked of every caller of the edge-type registration door. */
export const registersEdgeType = standingRule(
  "metadata.edge_types:write",
  (c) => {
    requireSchemaRegistration(c, "edge_types");
  },
);

/** A registration takes the metadata scope; a replacement or a delete takes
 *  `schema.write`. */
export type SchemaDoor = "register" | "change";

/** The permission half for a registration: the registry's metadata scope,
 *  which `registersType` and `registersEdgeType` ask before the request is
 *  read and the whole guard asks again with the names. */
export function requireSchemaRegistration(
  c: Context<AppEnv>,
  registry: "types" | "edge_types",
): void {
  requireMetadataPermission(c, registry, "write");
}

function requireDoorPermission(
  c: Context<AppEnv>,
  registry: "types" | "edge_types",
  door: SchemaDoor,
): void {
  if (door === "register") requireSchemaRegistration(c, registry);
  else requirePermission(c, "schema.write");
}

/** Admit a change to the type `id` names, or refuse it `403`. */
export function requireTypeSchemaWrite(
  c: Context<AppEnv>,
  door: SchemaDoor,
  id: string,
): void {
  requireDoorPermission(c, "types", door);
  requireTypeAccess(c, id, "write");
}

/** Admit a change to the edge type these names belong to, or refuse it
 *  `403`. */
export function requireEdgeTypeSchemaWrite(
  c: Context<AppEnv>,
  door: SchemaDoor,
  names: readonly (string | undefined)[],
): void {
  requireDoorPermission(c, "edge_types", door);
  for (const name of names) {
    if (name !== undefined) requireEdgePermission(c, name, "write");
  }
}
