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
  ALWAYS_SEARCHED_FIELDS,
  ENTRY_MEMBER_TYPES,
  FIELD_TYPES,
  FORMAT_TO_FIELD_TYPE,
  RESERVED_ITEM_FIELDS,
  RESERVED_ROOTS,
  listEdgeTypes,
  listTypes,
  pluralOf,
} from "../packages/shared/src/index.js";
import { resolveRoles } from "../packages/server/src/storage/policy.js";

const resolve = (id: string) => listTypes().find((schema) => schema.id === id);

const types = listTypes()
  .map((schema) => {
    const roles = resolveRoles(schema.id, resolve);
    const listed = { ...schema, plural: pluralOf(schema) };
    return roles ? { ...listed, roles } : listed;
  })
  .sort((a, b) => a.id.localeCompare(b.id));

const edgeTypes = listEdgeTypes()
  .map((schema) => ({ ...schema, shipped: true }))
  .sort((a, b) => a.id.localeCompare(b.id));

writeFileSync(
  fileURLToPath(
    new URL("../core/marfa-core/src/builtin_catalog.json", import.meta.url),
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
