/**
 * Write the types a fresh server lists, as the core carries them: the item
 * types and the edge types Marfa ships, in the shape `GET /types` and
 * `GET /edge-types` answer them, and the field types a type may declare, so a
 * working copy that has never reached a server holds the catalog it would have
 * read from one that has just started.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FIELD_TYPES,
  listEdgeTypes,
  listTypes,
} from "../packages/shared/src/index.js";
import { resolveRoles } from "../packages/server/src/storage/policy.js";

const resolve = (id: string) => listTypes().find((schema) => schema.id === id);

const types = listTypes()
  .map((schema) => {
    const roles = resolveRoles(schema.id, resolve);
    return roles ? { ...schema, roles } : schema;
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
    { types, edge_types: edgeTypes, field_types: FIELD_TYPES },
    null,
    1,
  )}\n`,
);
