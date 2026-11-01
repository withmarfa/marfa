import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * A registered type can sit in conflict with the types above it: an upgrade
 * gave a shipped type a field the registered type below it already declares in
 * another shape. The registration doors refuse that, so none produces it.
 *
 * **Arranged in the stored file, on a server of its own.** The fixture
 * registers a subtype of the shipped `core.task` with a field of a name the
 * shipped type does not declare, stops the server, renames that field in the
 * stored row to `assignees`, which `core.task` declares as a list of
 * objects, and boots the server on that file. What is asserted is what the
 * instance then answers.
 */
let server: FreshServer | undefined;
let client: MarfaClient;

const CONFLICTING = "conflict.issue";
const AGREEING = "conflict.agrees";

interface Listed {
  id: string;
  conflicts?: Record<string, string>[];
}

async function listed(id: string): Promise<{ type: Listed; body: unknown }> {
  const res = await client.listTypes();
  expect(res.status).toBe(200);
  const type = (res.data.data as unknown as Listed[]).find((t) => t.id === id);
  expect(type, id).toBeDefined();
  return { type: type as Listed, body: res.data };
}

beforeAll(async () => {
  server = await bootFreshServer("type-conflicts");
  const arranging = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  for (const [id, field] of [
    [CONFLICTING, "assignees_pending"],
    [AGREEING, "note"],
  ] as const) {
    const registered = await arranging.registerType({
      id,
      parent: "core.task",
      fields: { [field]: { type: "array", items_type: "string" } },
    });
    expect(registered.status, id).toBe(201);
  }
  const item = await arranging.createItem({
    type: CONFLICTING,
    properties: { title: "held" },
  });
  expect(item.status).toBe(201);

  await server.restart(() => {
    const changed = withInstanceDatabase(server!.sqlitePath, (db) =>
      db
        .prepare(
          "UPDATE types SET schema = replace(schema, 'assignees_pending', 'assignees') WHERE id = ?",
        )
        .run(CONFLICTING),
    );
    expect(Number(changed.changes)).toBe(1);
  });
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("a registered type that conflicts with the types above it", () => {
  it("lists the field it declares in another shape, and nothing for a type that agrees", async () => {
    const { type, body } = await listed(CONFLICTING);
    expect(type.conflicts).toEqual([
      {
        field: "assignees",
        attribute: "items_type",
        inherited_from: "core.task",
        inherited: 'items_type "object"',
        declared: 'items_type "string"',
      },
    ]);
    await expectMatchesSchema("GET", "/types", 200, body);
    // The witness: the same listing carries `conflicts` for the one type
    // above, and the type that adds a field of its own has none.
    expect((await listed(AGREEING)).type.conflicts).toBeUndefined();
    expect((await listed("core.task")).type.conflicts).toBeUndefined();
  });

  it("keeps its items readable and listable", async () => {
    const items = await client.listItems({ type: CONFLICTING });
    expect(items.status).toBe(200);
    expect(items.data.data).toHaveLength(1);
    const first = items.data.data[0];
    const read = await client.getItem(first?.id ?? "");
    expect(read.status).toBe(200);
    expect(read.data.item.properties.title).toBe("held");
  });

  it("stops listing the conflict once the type declares the shape above, with no restart", async () => {
    expect((await listed(CONFLICTING)).type.conflicts).toHaveLength(1);
    const shipped = (await client.getType("core.task")).data.fields.assignees;
    expect(shipped).toBeDefined();
    const replaced = await client.replaceType(CONFLICTING, {
      parent: "core.task",
      fields: { assignees: shipped },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    expect((await listed(CONFLICTING)).type.conflicts).toBeUndefined();
  });
});
