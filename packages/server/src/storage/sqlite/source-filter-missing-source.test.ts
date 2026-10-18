/**
 * A row stored without a source reads as the source `unknown` (`rowToItem`),
 * so the source filter decides it as `unknown` in SQL and in JavaScript
 * alike. Otherwise a device told `listed: true` for a row would hold it as
 * part of a listing that never shows it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";
import { sourceFilterIncludesItem } from "../filter-sql.js";

type Storage = Awaited<ReturnType<typeof createSqliteStorage>>;

const NOW = "2026-01-01T00:00:00.000Z";
let directory: string;
let storage: Storage;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marfa-missing-source-"));
  storage = await createSqliteStorage(join(directory, "test.db"));
  for (const [id, source] of [
    ["sourceless", null],
    ["shown", "shown"],
    ["target", "shown"],
  ] as const) {
    await storage.__sqliteRun(
      `INSERT INTO items (id, type, source, state, tier, properties, created_at, updated_at, occurred_at, version)
       VALUES (?, 'core.note', ?, 'active', 'library', jsonb('{"title":"zebra"}'), ?, ?, ?, 1)`,
      [id, source, NOW, NOW, NOW],
    );
    await storage.search.index(id, { title: "zebra" }, "core.note");
  }
  await storage.__sqliteRun(
    `INSERT INTO edges (id, source_id, target_id, edge_type, created_at, updated_at)
     VALUES ('edge-1', 'sourceless', 'target', 'about', ?, ?)`,
    [NOW, NOW],
  );
});

afterEach(async () => {
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
const naming = (source: string) => ({
  types: ["core.note"],
  sources: [source],
});

describe("a row stored without a source", () => {
  it("reads as the source unknown", async () => {
    expect((await storage.items.get("sourceless"))?.source).toBe("unknown");
  });

  it("is listed, searched and counted under a filter naming unknown, as the JavaScript twin answers", async () => {
    const filter = naming("unknown");
    const row = await storage.items.get("sourceless");
    expect(row && sourceFilterIncludesItem(filter, row)).toBe(true);
    expect(
      ids((await storage.items.list({ source_filter: filter })).data),
    ).toEqual(["sourceless"]);
    const found = await storage.search.search("zebra", {
      source_filter: filter,
    });
    expect(ids(found.map((hit) => hit.item))).toEqual(["sourceless"]);
    expect(
      (await storage.edges.list({ source_filter: filter })).data.map(
        (edge) => edge.id,
      ),
    ).toEqual(["edge-1"]);
  });

  it("is left out under a filter naming another source, as the JavaScript twin answers", async () => {
    const filter = naming("shown");
    const row = await storage.items.get("sourceless");
    expect(row && sourceFilterIncludesItem(filter, row)).toBe(false);
    expect(
      ids((await storage.items.list({ source_filter: filter })).data),
    ).toEqual(["shown", "target"]);
    expect((await storage.edges.list({ source_filter: filter })).data).toEqual(
      [],
    );
  });

  it("decides a backref term by the same reading", async () => {
    const term = { filter: "backref[about] exists" };
    expect(
      ids(
        (
          await storage.items.list({
            ...term,
            source_filter: naming("unknown"),
          })
        ).data,
      ),
    ).toEqual([]);
    expect(
      ids(
        (
          await storage.items.list({
            ...term,
            allowed_types: ["*"],
            readable_sources: { allowed: ["*"], excluded: [] },
          })
        ).data,
      ),
    ).toEqual(["target"]);
    expect(
      ids(
        (
          await storage.items.list({
            ...term,
            allowed_types: ["*"],
            readable_sources: { allowed: ["*"], excluded: [] },
            source_filter: naming("shown"),
          })
        ).data,
      ),
    ).toEqual([]);
  });
});
