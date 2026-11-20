import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { editLineFile } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A restore takes a type that names `enum_values` on a field that is not an
 * enum as the archive holds it. The only way to hold one is an archive that
 * says so, so the fixture edits the type's line.
 */
const TYPE = "user.stored-enum-values";

let origin: FreshServer;
let destination: FreshServer;

beforeAll(async () => {
  [origin, destination] = await Promise.all([
    bootFreshServer("enum-values-origin"),
    bootFreshServer("enum-values-destination"),
  ]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([origin?.stop(), destination?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

describe("a type that names enum_values on a field that is not an enum", () => {
  it("restores from an archive, and its items read and take any string", async () => {
    const source = new MarfaClient({
      baseUrl: origin.apiUrl,
      apiKey: origin.workingKey,
    });
    const registered = await source.registerType({
      id: TYPE,
      fields: { size: { type: "string" } },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);

    const exported = await source.exportArchive({ state: "any" });
    expect(exported.status).toBe(200);
    let edited = 0;
    const archive = editLineFile(exported.data, "instance", (text) =>
      text
        .split("\n")
        .map((line) => {
          if (line === "") return line;
          const entry = JSON.parse(line) as {
            type?: { id?: string; fields?: Record<string, object> };
          };
          if (entry.type?.id !== TYPE || entry.type.fields === undefined) {
            return line;
          }
          entry.type.fields.size = {
            ...entry.type.fields.size,
            enum_values: ["s", "m"],
          };
          edited += 1;
          return JSON.stringify(entry);
        })
        .join("\n"),
    );
    expect(edited, "the archive holds the type's line").toBe(1);

    // The witness: the same definition is refused when it is registered.
    const refused = await source.registerType({
      id: `${TYPE}-direct`,
      fields: { size: { type: "string", enum_values: ["s", "m"] } },
    } as never);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");

    const owner = new MarfaClient({
      baseUrl: destination.apiUrl,
      controlSocket: destination.controlSocket,
    });
    const restored = await owner.restoreArchive(archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);

    const worker = new MarfaClient({
      baseUrl: destination.apiUrl,
      apiKey: destination.workingKey,
    });
    expect((await worker.getType(TYPE)).data.fields.size).toMatchObject({
      type: "string",
      enum_values: ["s", "m"],
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
});
