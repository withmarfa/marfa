import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackItem } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

/**
 * An agent with a key creates a note, reads it, changes it, tags it, finds
 * it, and takes it through its lifecycle, all from the terminal.
 */

let c: CliContext;

beforeAll(async () => {
  c = await cliContext("items");
});

afterAll(async () => {
  await cleanup(c.ctx);
});

describe("items from the terminal", () => {
  it("creates, reads, updates under the version read, tags, finds and lists a note", async () => {
    const title = unique("cli-note");
    const created = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--prop",
      `title=${title}`,
      "--prop",
      "body=written from the terminal",
      "--tag",
      "cli",
    ]);
    trackItem(c.ctx, created.item.id);
    expect(created.item.type).toBe("core.note");
    expect(created.item.version).toBe(1);
    expect(created.item.properties.title).toBe(title);
    expect(created.metadata?.tags).toEqual(["cli"]);

    const read = await c.cli.json<ItemEnvelope>([
      "items",
      "get",
      created.item.id,
    ]);
    expect(read.item.id).toBe(created.item.id);
    expect(read.item.properties.body).toBe("written from the terminal");

    const updated = await c.cli.json<ItemEnvelope>([
      "items",
      "update",
      created.item.id,
      "--version",
      "1",
      "--prop",
      "status=done",
    ]);
    expect(updated.item.version).toBe(2);
    expect(updated.item.properties.status).toBe("done");
    expect(updated.item.properties.title).toBe(title);

    // The version is required, and a stale one is the server's refusal
    // carried through: exit 1, the server's own code beside the binary's.
    const stale = await c.cli.refused([
      "items",
      "update",
      created.item.id,
      "--version",
      "1",
      "--prop",
      "status=again",
    ]);
    expect(stale.code).toBe(1);
    expect(stale.envelope.exit).toBe(1);
    expect(stale.envelope.error.code).toBe("conflict");
    expect(stale.envelope.error.server?.status).toBe(409);
    expect(stale.envelope.error.server?.code).toBe("version_conflict");

    const tagged = await c.cli.json<{ metadata: { tags: string[] } }>([
      "items",
      "tag",
      created.item.id,
      "alpha",
      "beta",
    ]);
    expect(tagged.metadata.tags.sort()).toEqual(["alpha", "beta", "cli"]);
    const untagged = await c.cli.json<{ metadata: { tags: string[] } }>([
      "items",
      "untag",
      created.item.id,
      "alpha",
    ]);
    expect(untagged.metadata.tags.sort()).toEqual(["beta", "cli"]);

    const found = await c.cli.json<{
      results: Array<{ item: { id: string } }>;
    }>(["search", title]);
    expect(found.results.map((hit) => hit.item.id)).toContain(created.item.id);

    const listed = await c.cli.json<{ data: Array<{ id: string }> }>([
      "items",
      "list",
      "--tag",
      "beta",
      "--type",
      "core.note",
    ]);
    expect(listed.data.map((row) => row.id)).toContain(created.item.id);

    const versions = await c.cli.json<{ versions: unknown[] }>([
      "items",
      "versions",
      created.item.id,
    ]);
    expect(Array.isArray(versions.versions)).toBe(true);

    const stats = await c.cli.json<Record<string, unknown>>([
      "items",
      "stats",
      "--by",
      "type",
    ]);
    expect(stats).toBeTruthy();
  });

  it("takes a note through archive, the bin, restore, and the purge", async () => {
    const created = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: unique("cli-lifecycle"), body: "b" }),
    ]);
    const id = created.item.id;

    const archived = await c.cli.json<ItemEnvelope>([
      "items",
      "transition",
      id,
      "--state",
      "archived",
    ]);
    expect(archived.item.state).toBe("archived");

    await c.cli.json(["items", "delete", id]);
    // A trashed row reads as absent on the direct door, with the server's
    // code carried through.
    const gone = await c.cli.refused(["items", "get", id]);
    expect(gone.envelope.error.code).toBe("not_found");
    expect(gone.envelope.error.server?.code).toBe("item_not_found");

    const restored = await c.cli.json<ItemEnvelope>(["items", "restore", id]);
    expect(restored.item.state).toBe("active");

    await c.cli.json(["items", "delete", id]);
    // The purge is the one destruction; the file's key holds `items.purge`
    // because it inherited the operator-minted key's whole set.
    await c.cli.json(["items", "purge", id]);
    const purged = await c.cli.refused(["items", "get", id]);
    expect(purged.envelope.error.code).toBe("not_found");
  });

  it("refuses a property given both ways before sending anything", async () => {
    const refused = await c.cli.refused([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: "one" }),
      "--prop",
      "title=two",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.envelope.error.code).toBe("invalid");
    expect(refused.envelope.error.server).toBeNull();
  });
});
