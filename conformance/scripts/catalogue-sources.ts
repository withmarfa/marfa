/**
 * The rows of the contract's catalogues, read from where the server keeps
 * them: the shipped type and edge type definitions in the rules crate's
 * `builtin_catalog.json`, and the permission list, the event names in the
 * webhook vocabulary and the stream's frame schema in `openapi.json`, the
 * document the server is held to. Like the repository's other generators, this
 * reads files by path; nothing under `src/suites/` may.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
const CATALOG = fileURLToPath(
  new URL("../../core/marfa-rules/src/builtin_catalog.json", import.meta.url),
);

/** What the rows below take from a shipped type in the catalog. */
export interface TypeSchema {
  id: string;
  parent?: string;
  description?: string;
  fields: Record<string, { required?: boolean }>;
}

/** What the rows below take from a shipped edge type in the catalog. */
export interface EdgeTypeSchema {
  id: string;
  label: string;
  reverse_label?: string;
  reverse_name?: string;
  cardinality: string;
  cascade_on_delete: string;
  from_type_constraints: string[];
  to_type_constraints: string[];
}

/** The shipped types and edge types, in the order the catalog lists them. */
export function shippedCatalog(): {
  types: TypeSchema[];
  edgeTypes: EdgeTypeSchema[];
} {
  const catalog = JSON.parse(readFileSync(CATALOG, "utf8")) as {
    types?: TypeSchema[];
    edge_types?: EdgeTypeSchema[];
  };
  if (!catalog.types?.length || !catalog.edge_types?.length) {
    throw new Error("builtin_catalog.json lists no shipped type or edge type");
  }
  return { types: catalog.types, edgeTypes: catalog.edge_types };
}

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
  const all = shippedCatalog().types;
  const shipped = new Map(all.map((schema) => [schema.id, schema]));
  const system = all.filter((schema) => schema.id.startsWith("system."));
  const core = all.filter((schema) => !schema.id.startsWith("system."));
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
  return [...rows(core, "core"), ...rows(system, "system")];
}

export function edgeTypeRows(): EdgeTypeRow[] {
  return shippedCatalog().edgeTypes.map((schema) => ({
    id: schema.id,
    label: schema.label,
    reverseLabel: schema.reverse_label ?? schema.label,
    ...(schema.reverse_name === undefined
      ? {}
      : { reverseName: schema.reverse_name }),
    cardinality: schema.cardinality,
    cascadeOnDelete: schema.cascade_on_delete,
    fromTypes: schema.from_type_constraints,
    toTypes: schema.to_type_constraints,
  }));
}

/** The permissions a credential can hold, as `openapi.json` lists them, in order. */
export function permissionNames(): string[] {
  const names = openApi().components.schemas["Permission"]?.enum ?? [];
  if (names.length === 0) {
    throw new Error("openapi.json lists no permission");
  }
  return names;
}

interface FrameSchema {
  enum?: string[];
  properties?: { event_type?: { enum?: string[]; const?: string } };
}

interface OpenApi {
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: {
          content?: Record<
            string,
            {
              schema?: {
                properties?: { events?: { items?: { enum?: string[] } } };
              };
            }
          >;
        };
      }
    >
  >;
  components: {
    schemas: Record<string, FrameSchema & { oneOf?: { $ref: string }[] }>;
  };
}

function openApi(): OpenApi {
  return JSON.parse(readFileSync(OPENAPI, "utf8")) as OpenApi;
}

/** The events a webhook may name, as `POST /webhooks` documents them, in order. */
export function webhookEvents(): string[] {
  const events =
    openApi().paths["/webhooks"]?.["post"]?.requestBody?.content?.[
      "application/json"
    ]?.schema?.properties?.events?.items?.enum ?? [];
  if (events.length === 0) {
    throw new Error("openapi.json names no event POST /webhooks takes");
  }
  return events;
}

/** Every `event:` a stream sends, from the frame schema `GET /events` documents. */
export function eventTypeRows(): EventTypeRow[] {
  const document = openApi();
  const events = webhookEvents();
  const { schemas } = document.components;
  const frames = schemas["EventStreamFrame"]?.oneOf ?? [];
  const names = frames.flatMap(({ $ref }) => {
    const event = schemas[$ref.split("/").pop() ?? ""]?.properties?.event_type;
    return event?.enum ?? (event?.const === undefined ? [] : [event.const]);
  });
  const webhook: ReadonlySet<string> = new Set(events);
  const missing = [...webhook].filter((name) => !names.includes(name));
  if (names.length === 0 || missing.length > 0) {
    throw new Error(
      `the stream's frame schema in openapi.json does not name ${JSON.stringify(missing.length > 0 ? missing : "any event")}`,
    );
  }
  // The events a webhook may name come first, in the document's order, then the
  // frames only a stream sends, in the schema's.
  const ordered = [...events, ...names.filter((name) => !webhook.has(name))];
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
