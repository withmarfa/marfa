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
});
