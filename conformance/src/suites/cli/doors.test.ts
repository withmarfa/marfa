import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  cleanup,
  trackEdgeType,
  trackItem,
  trackType,
} from "../../utils/setup.js";
import { cliContext, once, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

/**
 * The remaining doors, each driven once so the map is more than a table:
 * types and edge types, metadata and extensions, occurrences, the bulk
 * doors and their jobs, and the event stream.
 */

let c: CliContext;

beforeAll(async () => {
  c = await cliContext("doors");
});

afterAll(async () => {
  await cleanup(c.ctx);
});

async function note(title: string, body = "b"): Promise<string> {
  const created = await c.cli.json<ItemEnvelope>([
    "items",
    "create",
    "--type",
    "core.note",
    "--properties",
    JSON.stringify({ title, body }),
  ]);
  trackItem(c.ctx, created.item.id);
  return created.item.id;
}

describe("types and edge types", () => {
  it("lists the shipped types, reads one, and registers, changes and removes one of its own", async () => {
    const listed = await c.cli.json<unknown>(["types", "list"]);
    const ids = JSON.stringify(listed);
    expect(ids).toContain("core.note");
    const read = await c.cli.json<{ id: string }>([
      "types",
      "get",
      "core.note",
    ]);
    expect(read.id).toBe("core.note");

    const id = `user.${unique("clitype").replace(/-/g, "")}`;
    const definition = {
      id,
      description: "A type registered from the terminal.",
      fields: { title: { type: "string", description: "The title." } },
      required: ["title"],
    };
    const registered = await c.cli.json<{ type: { id: string } }>([
      "types",
      "register",
      "--body",
      JSON.stringify(definition),
    ]);
    trackType(c.ctx, id);
    expect(registered.type.id).toBe(id);
    const updated = await c.cli.json<{ type: { id: string } }>([
      "types",
      "update",
      id,
      "--body",
      JSON.stringify({
        ...definition,
        description: "Changed from the terminal.",
      }),
    ]);
    expect(updated.type.id).toBe(id);
    await c.cli.json(["types", "delete", id, "--force"]);
    const gone = await c.cli.refused(["types", "get", id]);
    expect(gone.envelope.error.code).toBe("not_found");
  });

  it("lists the shipped edge types and registers and removes one of its own", async () => {
    const listed = await c.cli.json<unknown>(["edge-types", "list"]);
    expect(JSON.stringify(listed)).toContain("references");
    const id = unique("cli-edge-type");
    const registered = await c.cli.json<{ edge_type: { id: string } }>([
      "edge-types",
      "register",
      "--body",
      JSON.stringify({
        id,
        cardinality: "many-to-many",
        label: "From the terminal",
      }),
    ]);
    trackEdgeType(c.ctx, id);
    expect(registered.edge_type.id).toBe(id);
    await c.cli.json(["edge-types", "delete", id]);
  });
});

describe("metadata and extensions", () => {
  it("replaces and merges tags, lists the tags in use, and writes and removes a namespace", async () => {
    const id = await note(unique("cli-metadata"));
    const replaced = await c.cli.json<{ metadata: { tags: string[] } }>([
      "metadata",
      "replace",
      id,
      "--tag",
      "one",
      "--tag",
      "two",
    ]);
    expect(replaced.metadata.tags.sort()).toEqual(["one", "two"]);
    const merged = await c.cli.json<{ metadata: { tags: string[] } }>([
      "metadata",
      "merge",
      id,
      "--tag",
      "three",
    ]);
    expect(merged.metadata.tags.sort()).toEqual(["one", "three", "two"]);
    const read = await c.cli.json<{ metadata: { tags: string[] } }>([
      "metadata",
      "get",
      id,
    ]);
    expect(read.metadata.tags.sort()).toEqual(["one", "three", "two"]);
    const inUse = await c.cli.json<unknown>(["metadata", "tags"]);
    expect(JSON.stringify(inUse)).toContain("three");

    const written = await c.cli.json<unknown>([
      "extensions",
      "write",
      id,
      "app.cursor",
      "--body",
      JSON.stringify({ at: 3 }),
    ]);
    expect(written).toBeDefined();
    const listed = await c.cli.json<unknown>(["extensions", "list", id]);
    expect(JSON.stringify(listed)).toContain("app.cursor");
    const got = await c.cli.json<unknown>([
      "extensions",
      "get",
      id,
      "app.cursor",
    ]);
    expect(JSON.stringify(got)).toContain("3");
    await c.cli.json(["extensions", "delete", id, "app.cursor"]);
    const after = await c.cli.json<unknown>(["extensions", "list", id]);
    expect(JSON.stringify(after)).not.toContain("app.cursor");
  });
});

describe("occurrences and the bulk doors", () => {
  it("answers an occurrence window", async () => {
    const answer = await c.cli.json<unknown>([
      "items",
      "occurrences",
      "--from",
      "2026-01-01T00:00:00Z",
      "--to",
      "2026-12-31T00:00:00Z",
    ]);
    expect(answer).toBeDefined();
  });

  it("upserts many items from stdin, reads many by id, and runs a bulk action to its job", async () => {
    const a = unique("cli-bulk-a");
    const b = unique("cli-bulk-b");
    const upserted = await c.cli.json<{
      counts: { created: number };
      results: Array<{ outcome: string; id: string }>;
    }>(["items", "bulk", "--file", "-"], {
      stdin: JSON.stringify([
        {
          type: "core.note",
          source_id: a,
          properties: { title: a, body: "b" },
        },
        {
          type: "core.note",
          source_id: b,
          properties: { title: b, body: "b" },
        },
      ]),
    });
    expect(upserted.counts.created).toBe(2);
    const ids = upserted.results.map((row) => row.id);
    for (const id of ids) trackItem(c.ctx, id);

    const read = await c.cli.json<unknown>(["items", "bulk-get", ...ids]);
    expect(JSON.stringify(read)).toContain(ids[0]!);
    expect(JSON.stringify(read)).toContain(ids[1]!);

    const dry = await c.cli.json<{ matched?: number; status?: string }>([
      "items",
      "bulk-action",
      "tags",
      "--add",
      "swept",
      "--source",
      c.ctx.source,
      "--dry-run",
    ]);
    expect(dry).toBeDefined();

    const job = await c.cli.json<{ id: string; status: string }>([
      "items",
      "bulk-action",
      "tags",
      "--add",
      "swept",
      "--source",
      c.ctx.source,
    ]);
    expect(job.id).toBeTruthy();
    const read_job = await c.cli.json<{ id: string; status: string }>([
      "items",
      "bulk-action",
      "job",
      job.id,
    ]);
    expect(read_job.id).toBe(job.id);
    // A finished job answers its final state to a cancel rather than refusing.
    const cancelled = await c.cli.json<{ id: string }>([
      "items",
      "bulk-action",
      "cancel",
      job.id,
    ]);
    expect(cancelled.id).toBe(job.id);
  });
});

describe("the event stream", () => {
  it("delivers a write made while the stream is open, one frame per line", async () => {
    const stream = c.cli.hold(["events", "--type", "core.note", "--for", "6"]);
    let stdout = "";
    stream.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    // The stream announces its cursor first; the write goes out once it has.
    const opened = Date.now();
    while (!stdout.includes("stream_cursor") && Date.now() - opened < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(stdout, "the stream did not open with its cursor").toContain(
      "stream_cursor",
    );
    const id = await note(unique("cli-event"));
    await once(stream, "close");
    const frames = stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            data: { item?: { id: string } };
          },
      );
    const created = frames.find(
      (frame) => frame.event === "item.created" && frame.data.item?.id === id,
    );
    expect(
      created,
      `the write was not delivered; frames: ${stdout.slice(0, 500)}`,
    ).toBeDefined();
  });
});
