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
 * A drifted platform type is one the instance holds as a platform row and the
 * build no longer ships: listed by `GET /platform-types/drift` and removed by
 * `DELETE /platform-types/{id}` once nothing holds it.
 *
 * **Arranged in the stored file, on a server of its own.** No door registers a
 * platform type, and the shared server's types match its build. The fixture
 * registers ordinary types over HTTP, stops the server, marks their rows as
 * platform rows, and boots the server on that file. The build ships none of
 * them, so each is drift. What is asserted is what the instance then answers.
 */
let server: FreshServer | undefined;
let working: MarfaClient;
let operator: MarfaClient;

const REMOVABLE = "drift.removable";
const WITH_ITEMS = "drift.with-items";
const PARENT = "drift.parent";
const CHILD = "drift.child";

beforeAll(async () => {
  server = await bootFreshServer("platform-type-drift");
  const arranging = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const fields = { name: { type: "string" as const } };
  for (const id of [REMOVABLE, WITH_ITEMS, PARENT]) {
    expect((await arranging.registerType({ id, fields })).status, id).toBe(201);
  }
  expect(
    (
      await arranging.registerType({
        id: CHILD,
        parent: PARENT,
        fields: { extra: { type: "string" } },
      })
    ).status,
  ).toBe(201);
  const item = await arranging.createItem({
    type: WITH_ITEMS,
    properties: { name: "held" },
  });
  expect(item.status).toBe(201);

  await server.restart(() => {
    const changed = withInstanceDatabase(server!.sqlitePath, (db) =>
      db
        .prepare("UPDATE types SET origin = 'platform' WHERE id IN (?, ?, ?)")
        .run(REMOVABLE, WITH_ITEMS, PARENT),
    );
    expect(Number(changed.changes)).toBe(3);
  });
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("a drifted platform type", () => {
  it("lists a drifted platform type, and removes it once nothing holds it", async () => {
    const listed = await operator.listPlatformTypeDrift();
    expect(listed.status).toBe(200);
    expect(listed.data.data.find((row) => row.id === REMOVABLE)).toEqual({
      id: REMOVABLE,
      item_count: 0,
      child_types: [],
      removable: true,
    });
    // The witness: the type resolves as the registered type it was.
    expect((await working.getType(REMOVABLE)).status).toBe(200);

    const removed = await operator.deletePlatformType(REMOVABLE);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    expect(removed.data).toEqual({ removed: true, id: REMOVABLE });
    await expectMatchesSchema(
      "DELETE",
      "/platform-types/{id}",
      200,
      removed.data,
    );

    const gone = await working.getType(REMOVABLE);
    expect(gone.status).toBe(404);
    expect(gone.error?.error.code).toBe("type_not_found");
    const after = await operator.listPlatformTypeDrift();
    expect(after.data.data.map((row) => row.id)).not.toContain(REMOVABLE);
    // The door answers the identifier as absent now.
    const again = await operator.deletePlatformType(REMOVABLE);
    expect(again.status).toBe(404);
    expect(again.error?.error.code).toBe("type_not_found");

    const managementKey = await operator.getCurrentKey();
    expect(managementKey.status, JSON.stringify(managementKey.error)).toBe(200);
    const audited = await working.listAudit({
      action: "platform_type.removed",
      resource_id: REMOVABLE,
    });
    expect(audited.status).toBe(200);
    expect(
      audited.data.data.map((row) => [row.resource_type, row.key_id]),
    ).toEqual([["type", managementKey.data.id]]);
  });

  it("refuses a replacement and a delete of a drifted platform type through the type registry", async () => {
    const replaced = await working.replaceType(WITH_ITEMS, {
      id: WITH_ITEMS,
      fields: { name: { type: "string" }, extra: { type: "string" } },
    });
    expect(replaced.status).toBe(403);
    expect(replaced.error?.error.code).toBe("core_type_immutable");
    const forced = await working.deleteType(WITH_ITEMS, true);
    expect(forced.status).toBe(403);
    expect(forced.error?.error.code).toBe("core_type_immutable");
    expect((await working.getType(WITH_ITEMS)).data.fields).toEqual({
      name: { type: "string" },
    });

    // The witness: the same forced delete takes a type registered at run
    // time that an item holds.
    const runtime = "drift.runtime";
    expect(
      (
        await working.registerType({
          id: runtime,
          fields: { name: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    expect(
      (await working.createItem({ type: runtime, properties: { name: "x" } }))
        .status,
    ).toBe(201);
    expect((await working.deleteType(runtime, true)).status).toBe(200);
  });

  it("refuses to remove a drifted type that items still carry", async () => {
    const listed = await operator.listPlatformTypeDrift();
    expect(listed.data.data.find((row) => row.id === WITH_ITEMS)).toEqual({
      id: WITH_ITEMS,
      item_count: 1,
      child_types: [],
      removable: false,
    });

    const refused = await operator.deletePlatformType(WITH_ITEMS);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("conflict");
    expect(refused.error?.error.details?.item_count).toBe(1);
    expect((await working.getType(WITH_ITEMS)).status).toBe(200);

    // The witness: once the item is gone the same removal is taken, so what
    // refused it was the item.
    const items = await working.listItems({ type: WITH_ITEMS });
    expect(items.data.data).toHaveLength(1);
    const id = items.data.data[0]!.id;
    expect((await working.deleteItem(id)).status).toBe(200);
    expect((await working.purgeItem(id)).status).toBe(200);
    const removed = await operator.deletePlatformType(WITH_ITEMS);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    expect(removed.data).toEqual({ removed: true, id: WITH_ITEMS });
  });

  it("refuses to remove a drifted type another type inherits from", async () => {
    const listed = await operator.listPlatformTypeDrift();
    expect(listed.data.data.find((row) => row.id === PARENT)).toEqual({
      id: PARENT,
      item_count: 0,
      child_types: [CHILD],
      removable: false,
    });

    const refused = await operator.deletePlatformType(PARENT);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("conflict");
    expect(refused.error?.error.details?.child_types).toEqual([CHILD]);
    expect((await working.getType(PARENT)).status).toBe(200);
    expect((await working.getType(CHILD)).data.parent).toBe(PARENT);

    // The witness: with the child gone the same removal is taken.
    expect((await working.deleteType(CHILD)).status).toBe(200);
    const removed = await operator.deletePlatformType(PARENT);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    expect(removed.data).toEqual({ removed: true, id: PARENT });
  });
});
