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
      data: Array<{ item: { id: string } }>;
    }>(["search", title]);
    expect(found.data.map((hit) => hit.item.id)).toContain(created.item.id);

    const listed = await c.cli.json<{ data: Array<{ id: string }> }>([
      "items",
      "list",
      "--tag",
      "beta",
      "--type",
      "core.note",
    ]);
    expect(listed.data.map((row) => row.id)).toContain(created.item.id);
    // The tag filter reached the wire: the tag just taken off finds nothing.
    const untaggedList = await c.cli.json<{ data: Array<{ id: string }> }>([
      "items",
      "list",
      "--tag",
      "alpha",
      "--type",
      "core.note",
    ]);
    expect(untaggedList.data.map((row) => row.id)).not.toContain(
      created.item.id,
    );

    // The history holds the state before the update: one snapshot, at
    // version 1, without the property the update added.
    const versions = await c.cli.json<{
      data: Array<{ version: number; properties: Record<string, unknown> }>;
    }>(["items", "versions", created.item.id]);
    expect(versions.data.map((row) => row.version)).toEqual([1]);
    expect(versions.data[0]!.properties.status).toBeUndefined();

    // A second update leaves a second snapshot, and the history pages: one
    // at a time, the cursor the first page answers reaches the second.
    await c.cli.json([
      "items",
      "update",
      created.item.id,
      "--version",
      "2",
      "--prop",
      "status=later",
    ]);
    const first = await c.cli.json<{
      data: Array<{ version: number; type: string }>;
      next_cursor: string | null;
    }>(["items", "versions", created.item.id, "--limit", "1"]);
    expect(first.data.map((row) => [row.version, row.type])).toEqual([
      [1, "core.note"],
    ]);
    expect(first.next_cursor).not.toBeNull();
    const second = await c.cli.json<{
      data: Array<{ version: number }>;
      next_cursor: string | null;
    }>([
      "items",
      "versions",
      created.item.id,
      "--limit",
      "1",
      "--cursor",
      first.next_cursor!,
    ]);
    expect(second.data.map((row) => row.version)).toEqual([2]);
    expect(second.next_cursor).toBeNull();

    // Grouped by type, the answer is a count per type id; grouped by
    // state it would be per state, so the key is what proves the flag.
    const stats = await c.cli.json<Record<string, number>>([
      "items",
      "stats",
      "--by",
      "type",
    ]);
    expect(stats["core.note"]).toBeGreaterThanOrEqual(1);
    const byState = await c.cli.json<Record<string, number>>([
      "items",
      "stats",
      "--by",
      "state",
    ]);
    expect(byState.active).toBeGreaterThanOrEqual(1);
    expect(byState["core.note"]).toBeUndefined();
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
    // because it inherited the operator-minted key's whole set. A trashed
    // row could be restored above; a purged one cannot, which is what
    // tells the purge from a delete that did nothing.
    await c.cli.json(["items", "purge", id]);
    const purged = await c.cli.refused(["items", "restore", id]);
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
