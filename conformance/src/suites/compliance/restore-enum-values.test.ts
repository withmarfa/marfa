import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { editLineFile } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A restore takes a type that names `enum_values` on a field or a table column
 * that is not an enum as the archive holds it, and an update that leaves such
 * a member as the type holds it takes it too. The only way to hold one is an
 * archive that says so, so the fixture edits the types' lines, and restores
 * once for both tests.
 */
const TYPE = "user.stored-enum-values";
const UPDATED = "user.stored-enum-values-updated";

let origin: FreshServer;
let destination: FreshServer;
let source: MarfaClient;
let worker: MarfaClient;

beforeAll(async () => {
  [origin, destination] = await Promise.all([
    bootFreshServer("enum-values-origin"),
    bootFreshServer("enum-values-destination"),
  ]);
  source = new MarfaClient({
    baseUrl: origin.apiUrl,
    apiKey: origin.workingKey,
  });
  for (const id of [TYPE, UPDATED]) {
    const registered = await source.registerType({
      id,
      fields: { size: { type: "string" } },
      tables: { lines: { columns: { note: { type: "string" } } } },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  }

  const exported = await source.exportArchive({ state: "any" });
  expect(exported.status).toBe(200);
  let edited = 0;
  const archive = editLineFile(exported.data, "instance", (text) =>
    text
      .split("\n")
      .map((line) => {
        if (line === "") return line;
        const entry = JSON.parse(line) as {
          type?: {
            id?: string;
            fields?: Record<string, object>;
            tables?: Record<string, { columns: Record<string, object> }>;
          };
        };
        const lines = entry.type?.tables?.lines;
        if (
          (entry.type?.id !== TYPE && entry.type?.id !== UPDATED) ||
          entry.type.fields === undefined ||
          lines === undefined
        ) {
          return line;
        }
        entry.type.fields.size = {
          ...entry.type.fields.size,
          enum_values: ["s", "m"],
        };
        lines.columns.note = { ...lines.columns.note, enum_values: ["a"] };
        edited += 1;
        return JSON.stringify(entry);
      })
      .join("\n"),
  );
  expect(edited, "the archive holds both types' lines").toBe(2);

  const restoring = new MarfaClient({
    baseUrl: destination.apiUrl,
    controlSocket: destination.controlSocket,
  });
  const restored = await restoring.restoreArchive(archive);
  expect(restored.status, JSON.stringify(restored.error)).toBe(200);
  worker = new MarfaClient({
    baseUrl: destination.apiUrl,
    apiKey: destination.workingKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([origin?.stop(), destination?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

describe("a type that names enum_values on a field that is not an enum", () => {
  it("restores from an archive, and its items read and take any string", async () => {
    // The witness: the same definitions are refused when they are registered.
    const refused = await source.registerType({
      id: `${TYPE}-direct`,
      fields: { size: { type: "string", enum_values: ["s", "m"] } },
    } as never);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    const refusedColumn = await source.registerType({
      id: `${TYPE}-direct-column`,
      fields: { size: { type: "string" } },
      tables: {
        lines: { columns: { note: { type: "string", enum_values: ["a"] } } },
      },
    } as never);
    expect(refusedColumn.status).toBe(400);
    expect(refusedColumn.error?.error.code).toBe("invalid_schema");

    const restoredType = (await worker.getType(TYPE)).data;
    expect(restoredType.fields.size).toMatchObject({
      type: "string",
      enum_values: ["s", "m"],
    });
    // The whole table comes back, with the column that carries the list.
    expect(restoredType.tables?.lines?.columns.note).toMatchObject({
      type: "string",
      enum_values: ["a"],
    });
    const created = await worker.createItem({
      type: TYPE,
      properties: { size: "xl" },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const read = await worker.getItem(created.data.item.id);
    expect(read.status).toBe(200);
    expect(read.data.item.properties.size).toBe("xl");
  });

  it("takes an update that leaves a member as the type holds it, and refuses one that adds or changes a list", async () => {
    const held = (await worker.getType(UPDATED)).data;
    const whole = (
      fields: Record<string, object> = {},
      size: object = {},
      note: object = {},
    ) => ({
      fields: {
        ...held.fields,
        ...fields,
        size: { ...held.fields.size, ...size },
      },
      tables: {
        lines: {
          columns: {
            ...held.tables?.lines?.columns,
            note: { ...held.tables?.lines?.columns.note, ...note },
          },
        },
      },
    });

    // The witnesses: a new member, and a held member whose list or kind changes.
    for (const [what, definition] of [
      ["a new field", whole({ extra: { type: "string", enum_values: ["a"] } })],
      ["a changed field list", whole({}, { enum_values: ["s", "m", "l"] })],
      ["a changed field kind", whole({}, { type: "number" })],
      ["a changed column list", whole({}, {}, { enum_values: ["b"] })],
    ] as const) {
      const refused = await worker.replaceType(UPDATED, definition as never);
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("invalid_schema");
    }

    const replaced = await worker.replaceType(
      UPDATED,
      whole({ unrelated: { type: "string" } }, { label: "Size" }) as never,
    );
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);

    const after = (await worker.getType(UPDATED)).data;
    expect(after.fields.size).toMatchObject({ enum_values: ["s", "m"] });
    expect(after.tables?.lines?.columns.note).toMatchObject({
      enum_values: ["a"],
    });
    expect(Object.keys(after.fields)).toContain("unrelated");
  });
});
