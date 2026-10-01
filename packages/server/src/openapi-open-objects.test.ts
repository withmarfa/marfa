/**
 * Every open object in the committed document's `components.schemas` is open
 * on purpose.
 *
 * An open object is a position whose `additionalProperties` takes any value.
 * A generated client types it as a bag of unknowns, so a position with a real
 * shape published this way leaves every client to guess what the server
 * answers. Each one is either given its shape at the route or named below with
 * the reason it stays open, and a new one fails here until it is one or the
 * other.
 *
 * Read from the committed file, which `openapi-committed-spec.test.ts` holds
 * to what the routes produce.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const COMMITTED = new URL("../../../openapi.json", import.meta.url);

/**
 * Each entry matches positions by a pattern over the path `openPositions`
 * reports, and gives the reason they stay open.
 */
const OPEN_ON_PURPOSE: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /^\w+Refusal\.error\.details$/,
    reason: "A refusal's details, which differ by code and by door.",
  },
  {
    pattern: /^(BulkEntryError|BulkActionError)\.details$/,
    reason:
      "The details of the refusal a single write or a bulk-action job row gives, which differ by code.",
  },
  {
    pattern:
      /^(Item|Version|ConflictSnapshot|Edge|FolderDefaults)\.properties$/,
    reason:
      "An item's or an edge's properties, whose shape its type or edge type declares at runtime.",
  },
  {
    pattern: /^(Item|Metadata|ExtensionsResponse)\.extensions\.\*$/,
    reason:
      "One extension namespace's document, whose shape belongs to whoever writes the namespace.",
  },
  {
    pattern: /^ConnectorState\.state$/,
    reason: "A connector's state document, whose shape is the connector's own.",
  },
  {
    pattern: /^ConnectorAgreement\.record$/,
    reason:
      "A connector's own record of a row, whose shape is the connector's.",
  },
  {
    pattern: /^AuditEntry\.details$/,
    reason: "What an audited action records, which differs by action.",
  },
  {
    pattern:
      /^(FieldDefinition|TypeDefinitionInput|TypeDefinitionUpdate|MergePolicy|VersionPolicy)$/,
    reason:
      "Declared, and loose so a key the declaration does not name reaches the type validator, which refuses it with the authoring doors' own codes.",
  },
];

type Schema = Record<string, unknown>;

const isRecord = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Every position under `schemas` whose `additionalProperties` takes any
 * value, as a dotted path: a property by its name, a map's values as `*`.
 */
function openPositions(schemas: Schema): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, path);
      return;
    }
    if (!isRecord(node)) return;
    const extra = node.additionalProperties;
    if (extra === true || (isRecord(extra) && Object.keys(extra).length === 0))
      found.push(path);
    if (isRecord(node.properties)) {
      for (const [name, child] of Object.entries(node.properties))
        walk(child, `${path}.${name}`);
    }
    if (isRecord(extra)) walk(extra, `${path}.*`);
    for (const key of ["items", "allOf", "anyOf", "oneOf"])
      walk(node[key], path);
  };
  for (const [name, schema] of Object.entries(schemas)) walk(schema, name);
  return found;
}

const committedSchemas = (): Schema => {
  const spec: unknown = JSON.parse(readFileSync(COMMITTED, "utf8"));
  const schemas =
    isRecord(spec) && isRecord(spec.components)
      ? spec.components.schemas
      : undefined;
  if (!isRecord(schemas)) throw new Error("openapi.json has no schemas");
  return schemas;
};

const unexplained = (positions: string[]): string[] =>
  positions.filter(
    (path) => !OPEN_ON_PURPOSE.some(({ pattern }) => pattern.test(path)),
  );

describe("open objects in the API document", () => {
  it("are each open on purpose", () => {
    expect(unexplained(openPositions(committedSchemas()))).toEqual([]);
  });

  it("are each still there to be explained", () => {
    const positions = openPositions(committedSchemas());
    const unused = OPEN_ON_PURPOSE.filter(
      ({ pattern }) => !positions.some((path) => pattern.test(path)),
    ).map(({ pattern }) => pattern.source);
    expect(unused).toEqual([]);
  });

  it("finds a position the list does not explain", () => {
    const schemas = {
      ...committedSchemas(),
      Example: {
        type: "object",
        properties: {
          shaped: { type: "object", additionalProperties: {} },
          nested: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
        },
      },
    };
    expect(unexplained(openPositions(schemas))).toEqual([
      "Example.shaped",
      "Example.nested.*",
    ]);
  });

  it("gives a type's fields and an edge type's properties their shape", () => {
    const schemas = committedSchemas();
    const valuesOf = (schema: string, property: string): unknown => {
      const owner = schemas[schema];
      const properties = isRecord(owner) ? owner.properties : undefined;
      const map = isRecord(properties) ? properties[property] : undefined;
      return isRecord(map) ? map.additionalProperties : undefined;
    };
    expect(valuesOf("TypeDefinition", "fields")).toEqual({
      $ref: "#/components/schemas/FieldDefinition",
    });
    expect(valuesOf("EdgeType", "property_schema")).toEqual({
      $ref: "#/components/schemas/EdgePropertyDefinition",
    });
  });
});
