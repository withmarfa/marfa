// @ts-check
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Completeness } from "../index.js";
import { AT, hydrated } from "./copy-fixture.mjs";

test("numeric group order and visibility compare values across SQLite number representations", async (t) => {
  const { core, path } = await hydrated(t, []);
  const db = new DatabaseSync(path);
  const put = db.prepare(`INSERT INTO items
    (id,type,state,tier,version,schema_version,source,occurred_at,created_at,updated_at,properties)
    VALUES (?,?,'active','library',1,1,'test',?,?,?,?)`);
  const settings = {
    title: "Numbers",
    query: { types: ["core.note"], tier: "library" },
    layouts: [{ id: "ordered", kind: "board", group: { by: "properties.rank", order: [1e19] } },
      { id: "hidden", kind: "board", group: { by: "properties.rank", hidden: [1e19] } }],
  };
  put.run("view", "system.view", AT, AT, AT, JSON.stringify(settings));
  put.run("a", "core.note", AT, AT, AT, JSON.stringify({ rank: 1 }));
  put.run("b", "core.note", AT, AT, AT, JSON.stringify({ rank: 1e19 }));
  assert.deepEqual(core.viewGroups("view", "ordered").groups.map((group) => group.key), [1e19, 1]);
  assert.deepEqual(core.viewGroups("view", "hidden").groups.map((group) => group.key), [1]);
  db.close();
});

test("offline views preserve settings, layout order, groups, search, and refusal reasons", async (t) => {
  const { core, path, server } = await hydrated(t, []);
  const db = new DatabaseSync(path);
  const put = db.prepare(`INSERT INTO items
    (id,type,state,tier,version,schema_version,source,occurred_at,created_at,updated_at,properties)
    VALUES (?,?,'active','library',1,1,'test',?,?,?,?)`);
  const settings = {
    title: "Notes",
    query: { types: ["core.note"], tier: "library" },
    layouts: [{
      id: "chart", kind: "chart",
      sort: [{ by: "properties.amount", direction: "asc" }],
      group: { by: "tags", order: ["second"] },
      y: { sum: "properties.amount" },
    }],
  };
  put.run("view", "system.view", AT, AT, AT, JSON.stringify(settings));
  put.run("a", "core.note", AT, AT, AT, JSON.stringify({ title: "Note a", amount: 4 }));
  put.run("b", "core.note", AT, AT, AT, JSON.stringify({ title: "Note b", amount: 2 }));
  db.exec("INSERT INTO tags VALUES ('a','first'), ('a','second')");
  db.exec("INSERT INTO items_fts(rowid,title) SELECT seq,json_extract(properties,'$.title') FROM items WHERE type='core.note'");
  const before = server.asked();
  assert.deepEqual(core.listViews(), {
    completeness: Completeness.Complete,
    views: [{ id: "view", version: 1, state: "active", settings }],
  });
  assert.deepEqual(core.view("view")?.settings, settings);
  assert.equal(core.view("absent"), null);
  assert.deepEqual(core.listInView("view", "chart").items.map((row) => row.id), ["b", "a"]);
  assert.deepEqual(core.listInView("view", "chart", 1, 1).items.map((row) => row.id), ["a"]);
  assert.deepEqual(core.viewGroups("view", "chart", "Europe/London"), {
    completeness: Completeness.Complete,
    groups: [
      { key: "second", count: 1, sum: 4 },
      { key: "first", count: 1, sum: 4 },
      { key: null, count: 1, sum: 2 },
    ],
  });
  assert.equal(core.searchInView("Note", "view", 5).hits.length, 2);
  db.prepare("UPDATE items SET properties=? WHERE id='view'").run(JSON.stringify({
    ...settings, query: { types: ["core.file"] },
  }));
  for (const read of [
    () => core.listInView("view"),
    () => core.searchInView("Note", "view"),
    () => core.viewGroups("view", "chart"),
  ]) {
    assert.throws(read, (error) => {
      assert.equal(/** @type {{code:string}} */ (error).code, "invalid");
      assert.match(/** @type {Error} */ (error).message, /view|slice|type/);
      return true;
    });
  }
  assert.equal(server.asked(), before);
  db.close();
});
