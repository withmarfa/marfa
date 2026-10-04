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
 *
 * **A type's replacement is the one door two permissions open.** The key
 * that registered a type evolves it with `metadata.types:write`, within what
 * {@link changesNeedingSchemaWrite} allows, and `schema.write` still opens
 * every replacement. Naming a parent is a reach of its own
 * ({@link requireParentReach}).
 */
import { ErrorCode, MarfaError, TYPE_REGISTRY } from "@withmarfa/shared";
import type { TypeSchema } from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import {
  holdsMetadataPermission,
  holdsPermission,
  requireEdgePermission,
  requireMetadataPermission,
  requirePermission,
  requireTypeAccess,
  standingPermission,
  standingRule,
} from "../middleware/auth.js";
import { changesNeedingSchemaWrite } from "./_type-evolution.js";

/** Asked of every caller of a door that replaces or deletes a type or an
 *  edge type, before the request is read. */
export const changesSchema = standingPermission("schema.write");

/** Asked of every caller of the type replacement door: `schema.write`, or
 *  else the scope that registers types. What the replacement changes is
 *  asked once it is read ({@link requireTypeReplacement}). */
export const replacesType = standingRule(
  "schema.write or metadata.types:write",
  (c) => {
    admitTypeReplacement(c);
  },
);

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

/** A registration takes the metadata scope; a delete takes `schema.write`; a
 *  type's replacement takes either, as {@link admitTypeReplacement} says. */
export type SchemaDoor = "register" | "change" | "replace";

/** Admit a key to the type replacement door on `schema.write`, or on the
 *  types scope when it holds no `schema.write`. A key holding neither is
 *  told the permission that opens every replacement. */
function admitTypeReplacement(c: Context<AppEnv>): void {
  if (
    !holdsPermission(c, "schema.write") &&
    holdsMetadataPermission(c, "types", "write")
  ) {
    requireSchemaRegistration(c, "types");
    return;
  }
  requirePermission(c, "schema.write");
}

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
  else if (door === "replace" && registry === "types") admitTypeReplacement(c);
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

/**
 * Admit the replacement of the type `stored` for `next`, or refuse it `403`.
 *
 * A key holding `schema.write` may make any replacement. A key admitted on
 * `metadata.types:write` alone may make those
 * {@link changesNeedingSchemaWrite} leaves free, and is otherwise refused
 * `forbidden` naming the members that need `schema.write`. A parent the
 * replacement changes is held to the key's reach on top of that, whichever
 * permission admitted it.
 */
export function requireTypeReplacement(
  c: Context<AppEnv>,
  stored: TypeSchema,
  next: TypeSchema,
): void {
  admitTypeReplacement(c);
  if (!holdsPermission(c, "schema.write")) {
    const changes = changesNeedingSchemaWrite(stored, next);
    if (changes.length > 0) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        `Changing ${changes.join(", ")} requires schema.write. A credential holding metadata.types:write alone may add fields, remove the type's own fields, and change its label, description, display hints and version.`,
        { required_scope: "schema.write", changes },
      );
    }
  }
  if (next.parent !== undefined && next.parent !== stored.parent) {
    requireParentReach(c, next.parent);
  }
}

/**
 * Whether an identifier names a type this instance treats as locked.
 *
 * Reads the live registry rather than a set compiled from the shipped arrays,
 * because the platform vocabulary is seeded data now: an instance can hold a
 * type the running build never shipped, and locking has to follow what the
 * instance actually has. `TYPE_REGISTRY` is the platform map — a runtime
 * registration lives in the runtime overlay and never appears in it — so
 * membership is exactly the "shipped, not yours to edit" question.
 *
 * The lock spans core, connector and system alike. A connector type is
 * no more mutable than a core one.
 */
export function isLockedPlatformType(id: string): boolean {
  return TYPE_REGISTRY.has(id);
}

/**
 * Admit naming `parent` for a type, or refuse it `403 type_not_permitted`
 * naming the parent.
 *
 * **Write, not read, on the parent.** A type that names a parent stops the
 * parent being deleted (`409 type_has_subtypes`), which changes what the
 * parent's owner can do, and a read grant does not let a key do that. A
 * platform-shipped parent is exempt: no key can delete one, and connectors
 * subtype them. The check does not ask whether the parent exists, so a key
 * is not told by this door which identifiers are held.
 */
export function requireParentReach(c: Context<AppEnv>, parent: string): void {
  if (isLockedPlatformType(parent)) return;
  requireTypeAccess(c, parent, "write");
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
