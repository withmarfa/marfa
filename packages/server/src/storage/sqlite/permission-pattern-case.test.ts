/**
 * A permission pattern matches types the way the permission check does: by
 * name, case-sensitively. Every query that applies a permission map has to
 * agree, or an item can be found by one door and refused by another.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";

type Storage = Awaited<ReturnType<typeof createSqliteStorage>>;

const NOW = "2026-01-01T00:00:00.000Z";
let directory: string;
let storage: Storage;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marfa-pattern-case-"));
  storage = await createSqliteStorage(join(directory, "test.db"));
  for (const [id, type] of [
    ["child", "probe.root.child"],
    ["other", "probe.other"],
  ] as const) {
    await storage.__sqliteRun(
      `INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, version)
       VALUES (?, ?, 'active', 'library', jsonb('{"title":"zebra"}'), ?, ?, ?, 1)`,
      [id, type, NOW, NOW, NOW],
    );
    await storage.search.index(id, { title: "zebra" }, "core.note");
    await storage.__sqliteRun(
      `INSERT INTO metadata (item_id, tags, extensions) VALUES (?, '["tagged"]', '{}')`,
      [id],
    );
  }
  await storage.__sqliteRun(
    `INSERT INTO edges (id, source_id, target_id, edge_type, created_at, updated_at)
     VALUES ('edge-1', 'child', 'other', 'about', ?, ?)`,
    [NOW, NOW],
  );
});

afterEach(async () => {
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

describe("a permission pattern written in another case", () => {
  it("finds nothing through search, and the exact case still finds the item", async () => {
    const found = await storage.search.search("zebra", {
      allowed_types: ["probe.root.*"],
    });
    expect(ids(found.map((row) => row.item))).toEqual(["child"]);
    expect(
      await storage.search.search("zebra", {
        allowed_types: ["probe.Root.*"],
      }),
    ).toEqual([]);
  });

  it("finds nothing through a listing, and the exact case still lists the item", async () => {
    expect(
      ids((await storage.items.list({ allowed_types: ["probe.root.*"] })).data),
    ).toEqual(["child"]);
    expect(
      (await storage.items.list({ allowed_types: ["probe.Root.*"] })).data,
    ).toEqual([]);
  });

  it("counts no tags, and the exact case still counts them", async () => {
    expect(
      await storage.metadata.listTags({ allowedTypes: ["probe.root.*"] }),
    ).toEqual([{ tag: "tagged", count: 1 }]);
    expect(
      await storage.metadata.listTags({ allowedTypes: ["probe.Root.*"] }),
    ).toEqual([]);
  });

  it("reads no inbound edge from a source it may not read, and the exact case reads it", async () => {
    const filter = { filter: 'backref[about] eq "child"' };
    const readable = (allowed: string) => ({
      allowed_types: ["*"],
      readable_sources: { allowed: [allowed], excluded: [] },
    });
    expect(
      ids(
        (await storage.items.list({ ...filter, ...readable("probe.root.*") }))
          .data,
      ),
    ).toEqual(["other"]);
    expect(
      (await storage.items.list({ ...filter, ...readable("probe.Root.*") }))
        .data,
    ).toEqual([]);
  });
});
