import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  cleanup,
  trackEdgeType,
  trackItem,
  trackType,
} from "../../utils/setup.js";
import { cliContext, once, releaseHeld, unique } from "./harness.js";
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
  releaseHeld();
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
    const updated = await c.cli.json<{
      type: { id: string; description: string };
    }>([
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
    expect(updated.type.description).toBe("Changed from the terminal.");
    const reread = await c.cli.json<{ description: string }>([
      "types",
      "get",
      id,
    ]);
    expect(reread.description).toBe("Changed from the terminal.");
    // With an item of the type still standing, the delete is refused with
    // the server's own code, and `--force` is what carries it through.
    const standing = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      id,
      "--properties",
      JSON.stringify({ title: unique("cli-typed") }),
    ]);
    trackItem(c.ctx, standing.item.id);
    const inUse = await c.cli.refused(["types", "delete", id]);
    expect(inUse.envelope.error.server?.code).toBe("type_in_use");
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
    const before = await c.cli.json<unknown>(["edge-types", "list"]);
    expect(JSON.stringify(before)).toContain(id);
    await c.cli.json(["edge-types", "delete", id]);
    const after = await c.cli.json<unknown>(["edge-types", "list"]);
    expect(JSON.stringify(after)).not.toContain(id);
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

    const written = await c.cli.json<{
      extensions: Record<string, Record<string, unknown>>;
    }>([
      "extensions",
      "write",
      id,
      "app.cursor",
      "--body",
      JSON.stringify({ at: 3 }),
    ]);
    expect(written.extensions["app.cursor"]).toEqual({ at: 3 });
    const listed = await c.cli.json<{
      extensions: Record<string, Record<string, unknown>>;
    }>(["extensions", "list", id]);
    expect(listed.extensions["app.cursor"]).toEqual({ at: 3 });
    const got = await c.cli.json<Record<string, unknown>>([
      "extensions",
      "get",
      id,
      "app.cursor",
    ]);
    expect(JSON.stringify(got)).toContain('"at":3');
    await c.cli.json(["extensions", "delete", id, "app.cursor"]);
    const after = await c.cli.json<unknown>(["extensions", "list", id]);
    expect(JSON.stringify(after)).not.toContain("app.cursor");
  });
});

describe("occurrences and the bulk doors", () => {
  it("answers an occurrence window with the event inside it and not the one outside", async () => {
    const inside = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.event",
      "--properties",
      JSON.stringify({
        title: unique("cli-occurrence-in"),
        starts_at: "2026-06-15T10:00:00Z",
        ends_at: "2026-06-15T11:00:00Z",
      }),
    ]);
    trackItem(c.ctx, inside.item.id);
    const outside = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.event",
      "--properties",
      JSON.stringify({
        title: unique("cli-occurrence-out"),
        starts_at: "2027-06-15T10:00:00Z",
        ends_at: "2027-06-15T11:00:00Z",
      }),
    ]);
    trackItem(c.ctx, outside.item.id);
    const answer = await c.cli.json<{
      data: Array<{ starts_at: string; item: { id: string } }>;
    }>([
      "items",
      "occurrences",
      "--from",
      "2026-06-01T00:00:00Z",
      "--to",
      "2026-07-01T00:00:00Z",
    ]);
    const ids = answer.data.map((row) => row.item.id);
    expect(ids).toContain(inside.item.id);
    expect(ids).not.toContain(outside.item.id);
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

    const dry = await c.cli.json<{
      matched: number;
      dry_run: boolean;
      ids: string[];
    }>([
      "items",
      "bulk-action",
      "tags",
      "--add",
      "swept",
      "--source",
      c.ctx.source,
      "--dry-run",
    ]);
    expect(dry.dry_run).toBe(true);
    expect(dry.matched).toBeGreaterThanOrEqual(2);
    expect(dry.ids).toEqual(expect.arrayContaining(ids));

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
    // The job runs on its own; its state is read until it has finished,
    // and the effect is read off an item it matched.
    let read_job = { id: job.id, status: job.status };
    const started = Date.now();
    while (
      !["completed", "failed", "canceled"].includes(read_job.status) &&
      Date.now() - started < 20_000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      read_job = await c.cli.json<{ id: string; status: string }>([
        "items",
        "bulk-action",
        "job",
        job.id,
      ]);
    }
    expect(read_job.id).toBe(job.id);
    expect(read_job.status).toBe("completed");
    const swept = await c.cli.json<{ metadata: { tags: string[] } }>([
      "metadata",
      "get",
      ids[0]!,
    ]);
    expect(swept.metadata.tags).toContain("swept");
    // A finished job answers its final state to a cancel rather than
    // refusing, and the state it answers is the one just read.
    const canceled = await c.cli.json<{ id: string; status: string }>([
      "items",
      "bulk-action",
      "cancel",
      job.id,
    ]);
    expect(canceled.id).toBe(job.id);
    expect(canceled.status).toBe("completed");
  });
});

describe("links and tombstones", () => {
  it("finds an item by its link and its natural key, and remembers a purge's tombstone longer", async () => {
    const type = `user.${unique("clilinked").replace(/-/g, "")}`;
    const registered = await c.cli.json<{
      type: { id: string; link_field?: string };
    }>([
      "types",
      "register",
      "--body",
      JSON.stringify({
        id: type,
        fields: { vendor_id: { type: "string" } },
        link_field: "vendor_id",
      }),
    ]);
    trackType(c.ctx, type);
    expect(registered.type.link_field).toBe("vendor_id");

    const link = unique("cli-link");
    const key = unique("cli-key");
    const created = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      type,
      "--source-id",
      key,
      "--properties",
      JSON.stringify({ vendor_id: link }),
    ]);
    trackItem(c.ctx, created.item.id);
    const byLink = await c.cli.json<{ data: Array<{ id: string }> }>([
      "items",
      "lookup",
      "--type",
      type,
      "--link",
      link,
    ]);
    expect(byLink.data.map((row) => row.id)).toEqual([created.item.id]);
    const byKey = await c.cli.json<{ data: Array<{ id: string }> }>([
      "items",
      "lookup",
      "--type",
      type,
      "--source",
      c.ctx.source,
      "--source-id",
      key,
    ]);
    expect(byKey.data.map((row) => row.id)).toEqual([created.item.id]);

    await c.cli.json(["items", "delete", created.item.id]);
    await c.cli.json(["items", "purge", created.item.id]);
    const purged = await c.cli.json<{
      data: unknown[];
      tombstones: Array<{ key: string; purged_at: string }>;
    }>(["items", "lookup", "--type", type, "--link", link]);
    expect(purged.data).toEqual([]);
    const [tombstone] = purged.tombstones;
    expect(tombstone?.key).toBe(link);
    const later = new Date(
      Date.parse(tombstone?.purged_at ?? "") + 3_600_000,
    ).toISOString();
    const moved = await c.cli.json<{
      tombstones: Array<{ remembered_until: string }>;
    }>([
      "items",
      "tombstones",
      "--type",
      type,
      "--link",
      link,
      "--until",
      later,
    ]);
    expect(moved.tombstones[0]?.remembered_until).toBe(later);
  });
});

describe("the event stream", () => {
  it("delivers a write made while the stream is open, one frame per line", async () => {
    const stream = c.cli.hold(["events", "--type", "core.note", "--for", "6"]);
    let stdout = "";
    let stderr = "";
    stream.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    stream.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
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
    // A write of another type, made while the stream is open, is what the
    // type filter has to keep out.
    const other = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.bookmark",
      "--properties",
      JSON.stringify({
        title: unique("cli-event-other"),
        url: "https://example.com/",
      }),
    ]);
    trackItem(c.ctx, other.item.id);
    const code = await once(stream, "close");
    expect(code, stderr).toBe(0);
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
    expect(
      frames.find((frame) => frame.data.item?.id === other.item.id),
      "a write of another type came through the type filter",
    ).toBeUndefined();
  });
});
