import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteStorage } from "./index.js";
import { itemWrites } from "../item-writes.js";

let storage: Awaited<ReturnType<typeof createSqliteStorage>>;
let dir: string;
let path: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "marfa-search-keys-"));
  path = join(dir, "test.db");
  storage = await createSqliteStorage(path);
});

afterEach(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

const itemId = "019f0000-0000-7000-8000-123456789abc";
const hits = async (query: string) =>
  (await storage.search.search(query, {})).map((hit) => hit.item.id);
const key = async () =>
  storage.__sqliteAll(
    `SELECT CAST(seq AS TEXT) AS seq FROM item_search_keys WHERE item_id = '${itemId}'`,
  );

describe("stable search keys", () => {
  it("matches content and tags without treating item identifiers as content", async () => {
    await itemWrites(storage).create({
      id: itemId,
      type: "core.note",
      properties: { title: "Searchabletitle", body: "searchablebody" },
    });
    await storage.metadata.addTags(itemId, ["searchabletag"]);
    expect(await hits("searchablebody")).toEqual([itemId]);
    expect(await hits("searchabletag")).toEqual([itemId]);
    const title = await storage.search.search("searchabletitle", {});
    expect(title[0]?.snippet_html).toContain("<mark>Searchabletitle</mark>");
    const contentWitness = await itemWrites(storage).create({
      type: "core.note",
      properties: { body: itemId },
    });
    const tagWitness = await itemWrites(storage).create({
      type: "core.note",
      properties: { body: "tagidentifierwitness" },
    });
    await storage.metadata.addTags(tagWitness.id, [itemId]);
    const idHits = await hits(`"${itemId}"`);
    expect(idHits).toEqual(
      expect.arrayContaining([contentWitness.id, tagWitness.id]),
    );
    expect(idHits).not.toContain(itemId);
  });

  it("preserves the explicit key through reindexing, VACUUM and reopen", async () => {
    const item = await itemWrites(storage).create({
      id: itemId,
      type: "core.note",
      properties: { body: "beforevacuum" },
    });
    await storage.metadata.addTags(itemId, ["persistenttag"]);
    const original = await key();
    expect(original).toHaveLength(1);
    await itemWrites(storage).update(itemId, {
      properties: { body: "aftervacuum" },
      version: item.version,
      may_read_type: () => true,
    });
    expect(await key()).toEqual(original);
    expect(await hits("beforevacuum")).toEqual([]);
    expect(await hits("aftervacuum")).toEqual([itemId]);
    expect(await hits("persistenttag")).toEqual([itemId]);
    await storage.__sqliteRun("VACUUM", []);
    await storage.close();
    storage = await createSqliteStorage(path);
    expect(await key()).toEqual(original);
    expect(await hits("aftervacuum")).toEqual([itemId]);
    await storage.metadata.addTags(itemId, ["afterreopen"]);
    expect(await hits("afterreopen")).toEqual([itemId]);
  });

  it("keeps SQLite integer keys exact without a JavaScript number round trip", async () => {
    await itemWrites(storage).create({
      id: itemId,
      type: "core.note",
      properties: { body: "exactinteger" },
    });
    await storage.__sqliteRun("DELETE FROM items_fts", []);
    await storage.__sqliteRun(
      "UPDATE item_search_keys SET seq = 9007199254740993 WHERE item_id = ?",
      [itemId],
    );
    await storage.search.index(itemId, { body: "exactinteger" }, "core.note");
    await storage.metadata.addTags(itemId, ["exacttag"]);
    expect(await hits("exactinteger")).toEqual([itemId]);
    expect(await hits("exacttag")).toEqual([itemId]);
    expect(
      await storage.__sqliteAll(
        "SELECT CAST(rowid AS TEXT) AS seq FROM items_fts",
      ),
    ).toEqual([{ seq: "9007199254740993" }]);
    await storage.search.remove(itemId);
    expect(await key()).toEqual([]);
    expect(await hits("exacttag")).toEqual([]);
  });

  it("rolls back map and index writes with create, reindex, tags, trash, restore and purge", async () => {
    const abort = new Error("roll back search changes");
    await expect(
      storage.runInTransaction(async () => {
        await itemWrites(storage).create({
          id: itemId,
          type: "core.note",
          properties: { body: "rolledbackcreate" },
        });
        expect(await hits("rolledbackcreate")).toEqual([itemId]);
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(await key()).toEqual([]);
    expect(await hits("rolledbackcreate")).toEqual([]);

    const item = await itemWrites(storage).create({
      id: itemId,
      type: "core.note",
      properties: { body: "lifecyclecontent" },
    });
    const original = await key();
    for (const change of [
      () =>
        itemWrites(storage).update(itemId, {
          properties: { body: "rolledbackupdate" },
          version: item.version,
          may_read_type: () => true,
        }),
      () => storage.metadata.addTags(itemId, ["rolledbacktag"]),
      () => itemWrites(storage).delete(itemId),
    ]) {
      await expect(
        storage.runInTransaction(async () => {
          await change();
          throw abort;
        }),
      ).rejects.toBe(abort);
      expect(await key()).toEqual(original);
      expect(await hits("lifecyclecontent")).toEqual([itemId]);
    }
    expect(await hits("rolledbackupdate")).toEqual([]);
    expect(await hits("rolledbacktag")).toEqual([]);
    await storage.runInTransaction(() => itemWrites(storage).delete(itemId));
    expect(await key()).toEqual([]);
    expect(await hits("lifecyclecontent")).toEqual([]);
    await expect(
      storage.runInTransaction(async () => {
        await itemWrites(storage).restore(itemId);
        expect(await hits("lifecyclecontent")).toEqual([itemId]);
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(await key()).toEqual([]);
    expect(await hits("lifecyclecontent")).toEqual([]);
    await storage.runInTransaction(() => itemWrites(storage).restore(itemId));
    expect(await hits("lifecyclecontent")).toEqual([itemId]);
    await storage.runInTransaction(() => itemWrites(storage).delete(itemId));
    await expect(
      storage.runInTransaction(async () => {
        await itemWrites(storage).purge(itemId);
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(await storage.items.getIncludingTrashed(itemId)).not.toBeNull();
    await storage.runInTransaction(() => itemWrites(storage).purge(itemId));
    expect(await key()).toEqual([]);
    expect(await storage.__sqliteAll("SELECT rowid FROM items_fts")).toEqual(
      [],
    );
  });

  it("uses the unique item key and FTS rowid constraints for lookup and tag writes", async () => {
    for (const statement of [
      "SELECT rowid FROM items_fts WHERE rowid = (SELECT seq FROM item_search_keys WHERE item_id = 'fixture')",
      "UPDATE items_fts SET tags = 'fixture' WHERE rowid = (SELECT seq FROM item_search_keys WHERE item_id = 'fixture')",
    ]) {
      const plan = (await storage.__sqliteAll(
        `EXPLAIN QUERY PLAN ${statement}`,
      )) as { detail: string }[];
      expect(
        plan.some(({ detail }) =>
          /SEARCH item_search_keys USING (?:COVERING )?INDEX .*\(item_id=\?\)/.test(
            detail,
          ),
        ),
      ).toBe(true);
      expect(
        plan.some(({ detail }) =>
          /items_fts VIRTUAL TABLE INDEX \d+:.*=/.test(detail),
        ),
      ).toBe(true);
    }
  });

  it("rolls back key allocation when the FTS insert fails outside an item transaction", async () => {
    await storage.__sqliteRun("DROP TABLE items_fts", []);
    await expect(
      storage.search.index(itemId, { body: "insertfailure" }, "core.note"),
    ).rejects.toThrow(/INSERT OR REPLACE INTO items_fts/);
    expect(await key()).toEqual([]);
  });

  it("rolls back FTS removal when deleting its map key fails", async () => {
    await itemWrites(storage).create({
      id: itemId,
      type: "core.note",
      properties: { body: "removalfailure" },
    });
    const original = await key();
    expect(await hits("removalfailure")).toEqual([itemId]);
    await storage.__sqliteRun(
      "CREATE TRIGGER refuse_search_key_delete BEFORE DELETE ON item_search_keys BEGIN SELECT RAISE(ABORT, 'refuse key deletion'); END",
      [],
    );
    await expect(storage.search.remove(itemId)).rejects.toThrow(
      /DELETE FROM item_search_keys/,
    );
    expect(await key()).toEqual(original);
    expect(await hits("removalfailure")).toEqual([itemId]);
  });
});
