/**
 * Write the types a fresh server lists, as the core carries them: the item
 * types and the edge types Marfa ships, in the shape `GET /types` and
 * `GET /edge-types` answer them, the field types a type may declare, the
 * kinds a member of a list's entries may take, the kind each format of a
 * string turns into, the names
 * a field cannot take, the names a thumbnail cannot take and the roots a type
 * cannot sit under, so a working copy that has never reached a server holds
 * the catalog it would have read from one that has just started.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ALL_EDGE_TYPES,
  ALL_SYSTEM_TYPES,
  ALL_TYPES,
  ALWAYS_SEARCHED_FIELDS,
  ENTRY_MEMBER_TYPES,
  FIELD_TYPES,
  FORMAT_TO_FIELD_TYPE,
  RESERVED_ITEM_FIELDS,
  SHIPPED_TABLES,
  labelFromName,
  pluralFromLabel,
  type TypeRole,
} from "../packages/types/src/index.js";

/**
 * The first segments no type may take: the five namespace tiers, the root of
 * each permission and scope family, and the one word the glossary bans.
 */
const RESERVED_ROOTS = [
  "core",
  "system",
  "app",
  "user",
  "marfa",
  "schema",
  "keys",
  "items",
  "webhooks",
  "config",
  "audit",
  "grants",
  "instance",
  "connectors",
  "blobs",
  "content",
  "metadata",
  "edge",
  "profile",
  "space",
];

const shipped = [...ALL_TYPES, ...ALL_SYSTEM_TYPES];
const byId = new Map(shipped.map((schema) => [schema.id, schema]));

/** The plural a type is listed with: its own, or the one its label makes. */
function pluralOf(schema: { id: string; label?: string; plural?: string }) {
  const named = (value: string | undefined) =>
    value === undefined || value === "" ? undefined : value;
  return (
    named(schema.plural) ??
    pluralFromLabel(
      named(schema.label) ??
        labelFromName(schema.id.split(".").at(-1) ?? schema.id),
    )
  );
}

/** The roles a type declares and every ancestor declares, sorted; absent when none. */
function resolveRoles(id: string) {
  const roles = new Set<TypeRole>();
  for (
    let type = byId.get(id);
    type !== undefined;
    type = type.parent === undefined ? undefined : byId.get(type.parent)
  ) {
    for (const role of type.roles ?? []) roles.add(role);
  }
  return roles.size > 0 ? [...roles].sort() : undefined;
}

/** Edge types where an edge can close a cycle over more than one edge. */
const ACYCLIC_EDGE_TYPES = new Set(["parent-of", "supersedes"]);
/** The edge type whose source must not itself be a valid target. */
const FLAT_EDGE_TYPE = "in-collection";

const types = shipped
  .map((schema) => {
    const roles = resolveRoles(schema.id);
    const tables = SHIPPED_TABLES[schema.id];
    // Written after `fields`, where the registry keeps them.
    const declared = tables
      ? (Object.fromEntries(
          Object.entries(schema).flatMap(([key, value]) =>
            key === "fields"
              ? [
                  [key, value],
                  ["tables", tables],
                ]
              : [[key, value]],
          ),
        ) as typeof schema & { tables: typeof tables })
      : schema;
    const listed = { ...declared, plural: pluralOf(schema) };
    return roles ? { ...listed, roles } : listed;
  })
  .sort((a, b) => a.id.localeCompare(b.id));

const edgeTypes = ALL_EDGE_TYPES.map((schema) => ({
  ...schema,
  shipped: true,
  acyclic: ACYCLIC_EDGE_TYPES.has(schema.id),
  flat: schema.id === FLAT_EDGE_TYPE,
})).sort((a, b) => a.id.localeCompare(b.id));

writeFileSync(
  fileURLToPath(
    new URL("../core/marfa-rules/src/builtin_catalog.json", import.meta.url),
  ),
  `${JSON.stringify(
    {
      types,
      edge_types: edgeTypes,
      field_types: FIELD_TYPES,
      entry_member_types: ENTRY_MEMBER_TYPES,
      format_field_types: FORMAT_TO_FIELD_TYPE,
      reserved_type_roots: [...RESERVED_ROOTS].sort(),
      reserved_field_names: [...RESERVED_ITEM_FIELDS].sort(),
      searched_field_names: [...ALWAYS_SEARCHED_FIELDS].sort(),
    },
    null,
    1,
  )}\n`,
);
