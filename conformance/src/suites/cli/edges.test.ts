import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackItem } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

/** Link and unlink: an edge between two notes, read from both ends. */

let c: CliContext;

beforeAll(async () => {
  c = await cliContext("edges");
});

afterAll(async () => {
  await cleanup(c.ctx);
});

async function note(title: string): Promise<string> {
  const created = await c.cli.json<ItemEnvelope>([
    "items",
    "create",
    "--type",
    "core.note",
    "--properties",
    JSON.stringify({ title, body: "b" }),
  ]);
  trackItem(c.ctx, created.item.id);
  return created.item.id;
}

interface Edge {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  version: number;
  properties: Record<string, unknown>;
}

function rows(answer: unknown): Edge[] {
  const page = answer as { data: Edge[] };
  expect(Array.isArray(page.data)).toBe(true);
  return page.data;
}

describe("edges from the terminal", () => {
  it("links two notes, reads the edge from both ends, changes it, and unlinks", async () => {
    const a = await note(unique("cli-edge-a"));
    const b = await note(unique("cli-edge-b"));

    const created = await c.cli.json<{ edge: Edge }>([
      "edges",
      "create",
      "--source",
      a,
      "--target",
      b,
      "--type",
      "references",
      "--properties",
      JSON.stringify({ weight: 1 }),
    ]);
    const edge = created.edge;
    expect(edge.source_id).toBe(a);
    expect(edge.target_id).toBe(b);
    expect(edge.edge_type).toBe("references");

    const outbound = rows(await c.cli.json(["items", "edges", a]));
    expect(outbound.map((row) => row.id)).toContain(edge.id);
    const inbound = rows(await c.cli.json(["items", "backrefs", b]));
    expect(inbound.map((row) => row.id)).toContain(edge.id);

    const read = await c.cli.json<{ edge: Edge }>(["edges", "get", edge.id]);
    expect(read.edge.id).toBe(edge.id);

    const updated = await c.cli.json<{ edge: Edge }>([
      "edges",
      "update",
      edge.id,
      "--properties",
      JSON.stringify({ weight: 2 }),
      "--version",
      String(edge.version),
    ]);
    expect(updated.edge.properties.weight).toBe(2);
    expect(updated.edge.version).toBe(edge.version + 1);

    const listed = rows(
      await c.cli.json(["edges", "list", "--type", "references"]),
    );
    expect(listed.map((row) => row.id)).toContain(edge.id);

    await c.cli.json(["edges", "delete", edge.id]);
    const after = rows(await c.cli.json(["items", "edges", a]));
    expect(after.map((row) => row.id)).not.toContain(edge.id);
    const gone = await c.cli.refused(["edges", "get", edge.id]);
    expect(gone.envelope.error.code).toBe("not_found");
  });

  it("writes many edges from stdin, each entry with its own outcome", async () => {
    const a = await note(unique("cli-edge-bulk-a"));
    const b = await note(unique("cli-edge-bulk-b"));
    const c2 = await note(unique("cli-edge-bulk-c"));
    const written = await c.cli.json<{
      counts: { created: number; errored: number };
      results: Array<{ index: number; outcome: string; id?: string }>;
    }>(["edges", "bulk", "--file", "-"], {
      stdin: JSON.stringify({
        edges: [
          { source_id: a, target_id: b, edge_type: "references" },
          { source_id: a, target_id: c2, edge_type: "references" },
        ],
      }),
    });
    expect(written.counts.created).toBe(2);
    expect(written.results.map((row) => row.outcome)).toEqual([
      "created",
      "created",
    ]);
    const outbound = rows(await c.cli.json(["items", "edges", a]));
    expect(outbound.map((row) => row.target_id).sort()).toEqual([b, c2].sort());
    for (const row of written.results) {
      await c.cli.json(["edges", "delete", row.id!]);
    }
  });

  it("refuses a self-loop with the server's own code", async () => {
    const a = await note(unique("cli-edge-loop"));
    const refused = await c.cli.refused([
      "edges",
      "create",
      "--source",
      a,
      "--target",
      a,
      "--type",
      "references",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.envelope.error.server?.code).toBe("edge_cycle");
  });
});
