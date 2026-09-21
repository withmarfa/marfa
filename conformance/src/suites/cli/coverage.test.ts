import { describe, it, expect, beforeAll } from "vitest";
import { requireApiUrl } from "../../utils/setup.js";
import { Cli, requireBinary } from "./harness.js";

/**
 * Every operation the running server publishes is reached by a command, and
 * every command the binary names for one exists. The binary's own table is
 * the one source: this reads it from the binary rather than holding a copy,
 * and holds it against the document the server serves rather than the one
 * in the tree, so a door the server has grown is red here whichever half
 * moved first.
 *
 * One command is reached by nothing in this suite but its help: `types
 * prune`, which needs a drifted platform type that a fresh server does not
 * have and a client cannot make.
 */

interface Row {
  operation_id: string;
  command: string;
}

let cli: Cli;
let published: string[];
let rows: Row[];

beforeAll(async () => {
  const apiUrl = requireApiUrl();
  cli = new Cli(requireBinary(), apiUrl, undefined);
  const document = (await fetch(`${apiUrl}/openapi.json`).then((r) =>
    r.json(),
  )) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  published = [];
  for (const methods of Object.values(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      if (operation.operationId !== undefined)
        published.push(operation.operationId);
    }
  }
  rows = await cli.json<Row[]>(["operations"]);
});

describe("every published operation is reached", () => {
  it("finds the document and the table, so an empty pass cannot be a missing input", () => {
    expect(published.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("names a command for every published operation", () => {
    const known = new Set(rows.map((row) => row.operation_id));
    const missing = published.filter((id) => !known.has(id));
    expect(missing, "published operations the binary does not reach").toEqual(
      [],
    );
    for (const row of rows) {
      expect(row.command, `${row.operation_id} names no command`).toMatch(/\S/);
    }
  });

  it("names nothing the server no longer publishes", () => {
    const served = new Set(published);
    const stale = rows
      .filter((row) => !served.has(row.operation_id))
      .map((row) => row.operation_id);
    expect(
      stale,
      "entries for operations the server no longer publishes",
    ).toEqual([]);
  });

  it("answers --help for every command it names, so the table cannot advertise a command that does not exist", async () => {
    for (const row of rows) {
      const outcome = await cli.run([...row.command.split(" "), "--help"]);
      expect(
        outcome.code,
        `marfa ${row.command} --help exited ${String(outcome.code)}: ${outcome.stderr.slice(0, 200)}`,
      ).toBe(0);
      expect(outcome.stdout).toContain("Usage:");
    }
  });
});
