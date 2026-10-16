/**
 * Every version in the committed document is an integer.
 *
 * A version is a whole number that starts at 0 or 1 and goes up by one. A
 * generated client types a plain number as a float, so a version published as
 * `number` leaves every client to convert it. This walks the whole document,
 * request and response, for each member or parameter named for a version.
 *
 * Read from the committed file, which `openapi-committed-spec.test.ts` holds
 * to what the routes produce.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const COMMITTED = new URL("../../../openapi.json", import.meta.url);

/** A member or parameter that holds one version of an item, edge or type. */
const VERSION_NAME =
  /^(version|schema_version|requested_version|source_version)$/;

interface Position {
  name: string;
  where: string;
  schema: { type?: string; minimum?: number };
}

function versionPositions(node: unknown, path: string[] = []): Position[] {
  if (Array.isArray(node)) {
    return node.flatMap((child, i) =>
      versionPositions(child, [...path, String(i)]),
    );
  }
  if (node === null || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const found: Position[] = [];
  const properties = record.properties;
  if (properties !== null && typeof properties === "object") {
    for (const [name, schema] of Object.entries(properties)) {
      if (VERSION_NAME.test(name) && typeof schema === "object") {
        found.push({
          name,
          where: `${path.join("/")}/properties/${name}`,
          schema: schema as Position["schema"],
        });
      }
    }
  }
  if (
    typeof record.name === "string" &&
    VERSION_NAME.test(record.name) &&
    typeof record.in === "string" &&
    typeof record.schema === "object"
  ) {
    found.push({
      name: record.name,
      where: `${path.join("/")} (${record.in} parameter ${record.name})`,
      schema: record.schema as Position["schema"],
    });
  }
  for (const [key, child] of Object.entries(record)) {
    found.push(...versionPositions(child, [...path, key]));
  }
  return found;
}

describe("the committed API description", () => {
  const document: unknown = JSON.parse(readFileSync(COMMITTED, "utf8"));
  const positions = versionPositions(document).filter(
    (p) => p.schema.type !== "string",
  );

  it("finds the versions it is meant to check", () => {
    const names = new Set(positions.map((p) => p.name));
    expect(positions.length).toBeGreaterThan(15);
    for (const name of [
      "version",
      "schema_version",
      "requested_version",
      "source_version",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("types every version as an integer with a lower bound", () => {
    const wrong = positions
      .filter(
        (p) => p.schema.type !== "integer" || p.schema.minimum === undefined,
      )
      .map((p) => `${p.where}: ${JSON.stringify(p.schema)}`);
    expect(wrong).toEqual([]);
  });
});
