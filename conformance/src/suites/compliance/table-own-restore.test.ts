import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { editLineFile, readLineFile } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let origin: FreshServer;
let destination: FreshServer;
beforeEach(async () => {
  [origin, destination] = await Promise.all([
    bootFreshServer("own-restore-origin"),
    bootFreshServer("own-restore-destination"),
  ]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);
afterEach(async () => {
  await Promise.all([origin?.stop(), destination?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

const working = (server: FreshServer) =>
  new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
const owner = (server: FreshServer) =>
  new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });

async function archiveOf(client: MarfaClient) {
  const exported = await client.exportArchive({ state: "any" });
  expect(
    exported.status,
    Buffer.from(exported.data).toString().slice(0, 500),
  ).toBe(200);
  return exported.data;
}

describe("a restore of an item that keeps a table", () => {
  it(
    "refuses an item of a type below core.table whose columns a table cannot take, naming the column",
    async () => {
      const source = working(origin);
      const sheet = "user.sheet";
      expect(
        (
          await source.registerType({
            id: sheet,
            parent: "core.table",
            fields: { owner: { type: "string" } },
          })
        ).status,
      ).toBe(201);
      const made = await source.createItem({
        type: sheet,
        properties: { title: "Sheet", columns: { a: { type: "string" } } },
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      const id = made.data.item.id;
      const exported = await archiveOf(source);
      expect(readLineFile(exported, "items")).toContain(id);

      const restoredWhole = await owner(destination).restoreArchive(exported);
      expect(restoredWhole.status, JSON.stringify(restoredWhole.error)).toBe(
        200,
      );
      const reset = await bootFreshServer("own-restore-refusing");
      try {
        const broken = editLineFile(exported, "items", (text) =>
          text.replace('"a":{"type":"string"}', '"a":{"type":"money"}'),
        );
        expect(readLineFile(broken, "items")).toContain('"money"');
        const refused = await owner(reset).restoreArchive(broken);
        expect(refused.status, JSON.stringify(refused.data)).toBe(400);
        expect(refused.error?.error.code).toBe("invalid_properties");
        expect(refused.error?.error.details).toMatchObject({
          field: "properties.columns.a.type",
          item_id: id,
        });
        expect((await working(reset).getItem(id)).status).toBe(404);
      } finally {
        await reset.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it("exports and restores the rows of an item of core.table, as unlogged rows that a later write can undo", async () => {
    const source = working(origin);
    const columns = {
      name: { type: "string" },
      amount: { type: "number", adds_up: "sum" },
    };
    const made = await source.createItem({
      type: "core.table",
      properties: { title: "Ledger", columns },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const id = made.data.item.id;
    const written = await source.writeRows(id, "table", {
      operations: [
        { op: "put", values: { name: "rent", amount: 900 } },
        { op: "put", values: { name: "tea", amount: 4 } },
      ],
    });
    expect(written.status, JSON.stringify(written.error)).toBe(200);
    const rowsOf = async (on: MarfaClient) => {
      const listed = await on.listRows(id, "table", { limit: 1000 });
      expect(listed.status, JSON.stringify(listed.error)).toBe(200);
      return listed.data.data;
    };
    const sent = await rowsOf(source);
    expect(sent).toHaveLength(2);

    const exported = await archiveOf(source);
    expect(readLineFile(exported, "rows")).toContain(id);
    const restored = await owner(destination).restoreArchive(exported);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({ rows_imported: 2, rows_skipped: 0 });

    const target = working(destination);
    expect(await rowsOf(target)).toEqual(sent);
    const summary = (await target.listTables(id)).data.data;
    expect(summary).toMatchObject([
      { name: "table", row_count: 2, changed_at: expect.any(String) },
    ]);
    expect((await target.rowTotals(id, "table")).data.totals).toEqual({
      amount: { sum: 904 },
    });

    const unlogged = summary[0]!.last_batch!;
    const refused = await target.undoBatch(id, "table", unlogged);
    expect(refused.status, JSON.stringify(refused.data)).toBe(404);
    expect(refused.error?.error.code).toBe("batch_not_found");

    const changed = await target.writeRows(id, "table", {
      operations: [{ op: "patch", id: sent[0]!.id, values: { amount: 1 } }],
    });
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    const undone = await target.undoBatch(id, "table", changed.data.batch!);
    expect(undone.status, JSON.stringify(undone.error)).toBe(200);
    expect(await rowsOf(target)).toEqual(sent);
  });

  it("exports and restores an item of core.table whose column names a type deleted with force", async () => {
    const source = working(origin);
    const target = "user.gone";
    expect(
      (
        await source.registerType({
          id: target,
          fields: { title: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    const columns = {
      link: { type: "item", type_constraints: [target] },
      name: { type: "string" },
    };
    const made = await source.createItem({
      type: "core.table",
      properties: { title: "Links", columns },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const id = made.data.item.id;
    expect((await source.deleteType(target, true)).status).toBe(200);
    expect((await source.getType(target)).status).toBe(404);

    const exported = await archiveOf(source);
    const restored = await owner(destination).restoreArchive(exported);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    const held = await working(destination).getItem(id);
    expect(held.status, JSON.stringify(held.error)).toBe(200);
    expect(held.data.item.properties.columns).toEqual(columns);
  });

  it("refuses a restored item of core.table whose column has an empty type_constraints, naming it", async () => {
    const source = working(origin);
    const target = "user.gone";
    expect(
      (
        await source.registerType({
          id: target,
          fields: { title: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    const made = await source.createItem({
      type: "core.table",
      properties: {
        title: "Links",
        columns: { link: { type: "item", type_constraints: [target] } },
      },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const id = made.data.item.id;
    expect((await source.deleteType(target, true)).status).toBe(200);
    const exported = await archiveOf(source);

    const emptied = editLineFile(exported, "items", (text) =>
      text.replace(/"type_constraints":\["[^"]*"\]/, '"type_constraints":[]'),
    );
    expect(readLineFile(emptied, "items")).toContain('"type_constraints":[]');
    const refused = await owner(destination).restoreArchive(emptied);
    expect(refused.status, JSON.stringify(refused.data)).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(refused.error?.error.details).toMatchObject({
      field: "properties.columns.link.type_constraints",
      item_id: id,
    });
    expect((await working(destination).getItem(id)).status).toBe(404);
  });
});
