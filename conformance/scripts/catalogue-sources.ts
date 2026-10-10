/**
 * The rows of the contract's catalogues, read from where the server keeps
 * them: the shipped type and edge type definitions in `@withmarfa/types`, the
 * permission list in `@withmarfa/shared`, and the event names in the server's
 * webhook vocabulary and in the stream's frame schema in `openapi.json`,
 * which `pnpm check:statuses` and the OpenAPI freshness check hold to the
 * server. Like the repository's other generators, this reads the server by
 * path; nothing under `src/suites/` may.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PERMISSIONS } from "../../packages/shared/src/scopes.js";
import { WEBHOOK_EVENTS } from "../../packages/server/src/routes/webhooks.js";
import {
  ALL_EDGE_TYPES,
  ALL_SYSTEM_TYPES,
  ALL_TYPES,
  type TypeSchema,
} from "../../packages/types/src/index.js";
import {
  edgeTypesTable,
  eventTypesTable,
  permissionsTable,
  typesTable,
  type Catalogue,
  type EdgeTypeRow,
  type EventTypeRow,
  type TypeRow,
} from "../src/utils/catalogue-tables.js";

const OPENAPI = fileURLToPath(new URL("../../openapi.json", import.meta.url));

/** The required properties of a type, its ancestors' first. */
function requiredOf(
  schema: TypeSchema,
  shipped: ReadonlyMap<string, TypeSchema>,
): string[] {
  const inherited =
    schema.parent === undefined
      ? []
      : requiredOf(
          shipped.get(schema.parent) ??
            (() => {
              throw new Error(
                `${schema.id} names a parent, ${schema.parent}, that does not ship`,
              );
            })(),
          shipped,
        );
  const own = Object.entries(schema.fields)
    .filter(([, field]) => field.required === true)
    .map(([name]) => name);
  return [...new Set([...inherited, ...own])];
}

export function typeRows(): TypeRow[] {
  const shipped = new Map(
    [...ALL_TYPES, ...ALL_SYSTEM_TYPES].map((schema) => [schema.id, schema]),
  );
  const rows = (
    schemas: readonly TypeSchema[],
    family: TypeRow["family"],
  ): TypeRow[] =>
    schemas.map((schema) => ({
      id: schema.id,
      family,
      ...(schema.parent === undefined ? {} : { parent: schema.parent }),
      required: requiredOf(schema, shipped),
      ...(schema.description === undefined
        ? {}
        : { description: schema.description }),
    }));
  return [...rows(ALL_TYPES, "core"), ...rows(ALL_SYSTEM_TYPES, "system")];
}

export function edgeTypeRows(): EdgeTypeRow[] {
  return ALL_EDGE_TYPES.map((schema) => ({
    id: schema.id,
    ...(schema.reverse_name === undefined
      ? {}
      : { reverseName: schema.reverse_name }),
    cardinality: schema.cardinality,
    cascadeOnDelete: schema.cascade_on_delete,
    sourceTypes: schema.source_type_constraints,
    targetTypes: schema.target_type_constraints,
  }));
}

export function permissionNames(): string[] {
  return [...PERMISSIONS];
}

interface FrameSchema {
  properties?: { event_type?: { enum?: string[]; const?: string } };
}

/** Every `event:` a stream sends, from the frame schema `GET /events` documents. */
export function eventTypeRows(): EventTypeRow[] {
  const document = JSON.parse(readFileSync(OPENAPI, "utf8")) as {
    components: {
      schemas: Record<string, FrameSchema & { oneOf?: { $ref: string }[] }>;
    };
  };
  const { schemas } = document.components;
  const frames = schemas["EventStreamFrame"]?.oneOf ?? [];
  const names = frames.flatMap(({ $ref }) => {
    const event = schemas[$ref.split("/").pop() ?? ""]?.properties?.event_type;
    return event?.enum ?? (event?.const === undefined ? [] : [event.const]);
  });
  const webhook: ReadonlySet<string> = new Set(WEBHOOK_EVENTS);
  const missing = [...webhook].filter((name) => !names.includes(name));
  if (names.length === 0 || missing.length > 0) {
    throw new Error(
      `the stream's frame schema in openapi.json does not name ${JSON.stringify(missing.length > 0 ? missing : "any event")}`,
    );
  }
  // The events a webhook may name come first, in the server's order, then the
  // frames only a stream sends, in the schema's.
  const ordered = [
    ...WEBHOOK_EVENTS,
    ...names.filter((name) => !webhook.has(name)),
  ];
  return ordered.map((name) => ({ name, webhook: webhook.has(name) }));
}

/** Each catalogue's table, written from the server's definitions. */
export function catalogueTables(): Record<Catalogue, string> {
  return {
    types: typesTable(typeRows()),
    "edge-types": edgeTypesTable(edgeTypeRows()),
    permissions: permissionsTable(permissionNames()),
    "event-types": eventTypesTable(eventTypeRows()),
  };
}
