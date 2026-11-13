/**
 * The rows of the contract's catalogues, read from where the server keeps
 * them: the shipped type and edge type definitions in `@withmarfa/types`, and
 * the permission list, the event names in the webhook vocabulary and the
 * stream's frame schema in `openapi.json`, the document the server is held to. Like the repository's other generators, this reads
 * files by path; nothing under `src/suites/` may.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    label: schema.label,
    reverseLabel: schema.reverse_label ?? schema.label,
    ...(schema.reverse_name === undefined
      ? {}
      : { reverseName: schema.reverse_name }),
    cardinality: schema.cardinality,
    cascadeOnDelete: schema.cascade_on_delete,
    sourceTypes: schema.source_type_constraints,
    targetTypes: schema.target_type_constraints,
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
