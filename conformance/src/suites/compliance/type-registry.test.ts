import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import type { TypeSchema } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { generateId } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "type-registry",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

function testTypeId(label: string): string {
  return `user.evaluator-${label}-${generateId().slice(0, 8).toLowerCase()}`;
}

describe("type registry", () => {
  it("lists registered types including core types", async () => {
    const r = await client.listTypes();
    expect(r.ok).toBe(true);
    await expectMatchesSchema("GET", "/types", 200, r.data);
    expect(r.data.data.length).toBeGreaterThanOrEqual(1);

    const typeIds = r.data.data.map((t) => t.id);
    expect(typeIds).toContain("core.note");
    expect(typeIds).toContain("core.bookmark");
  });

  it("gets a single type by type identifier", async () => {
    const r = await client.getType("core.note");
    expect(r.ok).toBe(true);
    await expectMatchesSchema("GET", "/types/{id}", 200, r.data);
    expect(r.data.id).toBe("core.note");
  });

  it("returns 404 for a non-existent type identifier", async () => {
    const r = await client.getType("user.evaluator-does-not-exist");
    expect(r.status).toBe(404);
    expect(r.error?.error.code).toBe("type_not_found");
  });

  it("registers a new custom type", async () => {
    const typeId = testTypeId("register");
    const schema: TypeSchema = {
      id: typeId,
      fields: {
        title: { type: "string", required: true, searchable: true },
        priority: { type: "number" },
      },
    };

    const r = await client.registerType(schema);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(201);
    await expectMatchesSchema("POST", "/types", 201, r.data);
    expect(r.data.type.id).toBe(typeId);
  });

  it("rejects duplicate type registration with 409", async () => {
    const typeId = testTypeId("duplicate");
    const schema: TypeSchema = {
      id: typeId,
      fields: { name: { type: "string", required: true } },
    };

    const first = await client.registerType(schema);
    expect(first.ok).toBe(true);

    const second = await client.registerType(schema);
    expect(second.ok).toBe(false);
    expect(second.status).toBe(409);
    expect(second.error?.error.code).toBe("type_already_exists");
  });

  it("rejects type registration from a key without metadata.types:write", async () => {
    // The registration door asks for the metadata map, not a
    // permission: a key naming any map at all takes `metadata_permissions`
    // empty, and content reach says nothing about the registry.
    const keyResp = await client.createKey({
      label: "no-schema-type-reg",
      source: `${ctx.source}-${"no-schema-type-reg"}`,
      type_permissions: { "*": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const schema: TypeSchema = {
      id: testTypeId("no-schema"),
      fields: { name: { type: "string" } },
    };

    const r = await scopedClient.registerType(schema);
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("forbidden");
    expect(r.error?.error.details?.metadata_subresource).toBe("types");
  });

  it("refuses both schema.write doors to a key without it, and declares the refusal", async () => {
    // `PUT` and `DELETE /types/{id}` gate on `schema.write` and published no
    // 403 at all, so the refusal a caller is most likely to meet was the one
    // response the document did not describe. Two halves are asserted, and
    // the second is the one that reddens if the declaration goes again:
    // `expectMatchesSchema` throws when the served document declares no such
    // status for the door.
    const typeId = testTypeId("schema-write-gate");
    const registered = await client.registerType({
      id: typeId,
      fields: { name: { type: "string" } },
    });
    expect(registered.ok).toBe(true);

    const keyResp = await client.createKey({
      label: "no-schema-write",
      source: `${ctx.source}-${"no-schema-write"}`,
      permissions: [],
      type_permissions: { "*": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const replaced = await scopedClient.updateType(typeId, {
      id: typeId,
      version: 2,
      fields: { name: { type: "string" }, note: { type: "string" } },
    });
    expect(replaced.status).toBe(403);
    expect(replaced.error?.error.code).toBe("forbidden");
    await expectMatchesSchema("PUT", "/types/{id}", 403, replaced.error);

    const removed = await scopedClient.deleteType(typeId);
    expect(removed.status).toBe(403);
    expect(removed.error?.error.code).toBe("forbidden");
    await expectMatchesSchema("DELETE", "/types/{id}", 403, removed.error);
  });

  it("refuses both schema.write doors a platform-shipped type, and declares that refusal too", async () => {
    // The other code the 403 now names. A credential that holds
    // `schema.write` reaches the immutability check, so this is the arm the
    // permission refusal above can never reach.
    const replaced = await client.updateType("core.note", {
      id: "core.note",
      version: 99,
      fields: { body: { type: "string" } },
    });
    expect(replaced.status).toBe(403);
    expect(replaced.error?.error.code).toBe("core_type_immutable");
    await expectMatchesSchema("PUT", "/types/{id}", 403, replaced.error);

    const removed = await client.deleteType("core.note");
    expect(removed.status).toBe(403);
    expect(removed.error?.error.code).toBe("core_type_immutable");
    await expectMatchesSchema("DELETE", "/types/{id}", 403, removed.error);
  });

  it("updates type schema: adding a field with a version bump succeeds", async () => {
    const typeId = testTypeId("update-add");
    const schema: TypeSchema = {
      id: typeId,
      version: 1,
      fields: { name: { type: "string", required: true } },
    };

    const created = await client.registerType(schema);
    expect(created.ok).toBe(true);

    // Adding a field is a minor change — requires version > 1.
    // Detailed semver-diff coverage lives in type-versioning.test.ts;
    // this is the registry-CRUD smoke for the additive path.
    const updated = await client.updateType(typeId, {
      ...schema,
      version: 2,
      fields: {
        ...schema.fields,
        description: { type: "string" },
      },
    });
    expect(updated.ok).toBe(true);
    await expectMatchesSchema("PUT", "/types/{id}", 200, updated.data);
  });

  it("rejects type schema update at the same version (additive without bump)", async () => {
    const typeId = testTypeId("update-no-bump");
    const schema: TypeSchema = {
      id: typeId,
      version: 1,
      fields: { name: { type: "string", required: true } },
    };

    const created = await client.registerType(schema);
    expect(created.ok).toBe(true);

    // Adding a field while keeping version=1 must fail with a clear
    // version_bump_mismatch error: under semver-diff, additive and breaking
    // changes alike need a version bump.
    const updated = await client.updateType(typeId, {
      ...schema,
      fields: {
        ...schema.fields,
        description: { type: "string" },
      },
    });
    expect(updated.ok).toBe(false);
    expect(updated.status).toBe(422);
    expect(updated.error?.error.code).toBe("version_bump_mismatch");
  });

  it("deletes a type with no items", async () => {
    const typeId = testTypeId("delete-empty");
    const schema: TypeSchema = {
      id: typeId,
      fields: { name: { type: "string" } },
    };

    const created = await client.registerType(schema);
    expect(created.ok).toBe(true);

    const deleted = await client.deleteType(typeId);
    expect(deleted.ok).toBe(true);
    await expectMatchesSchema("DELETE", "/types/{id}", 200, deleted.data);
  });

  it("rejects deleting a type that has items", async () => {
    const typeId = testTypeId("delete-with-items");
    const schema: TypeSchema = {
      id: typeId,
      fields: { name: { type: "string" } },
    };

    const created = await client.registerType(schema);
    expect(created.ok).toBe(true);

    const item = await client.createItem({
      type: typeId,
      properties: { name: "Test" },
      source: ctx.source,
    });
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);

    const deleted = await client.deleteType(typeId);
    expect(deleted.ok).toBe(false);
    expect(deleted.status).toBe(409);
    expect(deleted.error?.error.code).toBe("type_in_use");
  });

  it("force-deletes a type that has items", async () => {
    const typeId = testTypeId("force-delete");
    const schema: TypeSchema = {
      id: typeId,
      fields: { name: { type: "string" } },
    };

    const created = await client.registerType(schema);
    expect(created.ok).toBe(true);

    const item = await client.createItem({
      type: typeId,
      properties: { name: "Test" },
      source: ctx.source,
    });
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);

    const deleted = await client.deleteType(typeId, true);
    expect(deleted.ok).toBe(true);
  });

  it("refuses a create of a type that was force-deleted under it", async () => {
    const typeId = testTypeId("force-delete-then-create");
    const created = await client.registerType({
      id: typeId,
      fields: { name: { type: "string" } },
    });
    expect(created.ok).toBe(true);

    const item = await client.createItem({
      type: typeId,
      properties: { name: "Test" },
      source: ctx.source,
    });
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);

    const deleted = await client.deleteType(typeId, true);
    expect(deleted.ok).toBe(true);

    const again = await client.createItem({
      type: typeId,
      properties: { name: "Test again" },
      source: ctx.source,
    });
    expect(again.ok).toBe(false);
    expect(again.status).toBe(400);
    expect(again.error?.error.code).toBe("unknown_type");
  });

  it("refuses deleting a parent while a subtype still declares it", async () => {
    const parentId = testTypeId("subtype-parent");
    const childId = testTypeId("subtype-child");

    const parent = await client.registerType({
      id: parentId,
      fields: { url: { type: "string" } },
    });
    expect(parent.ok).toBe(true);

    const child = await client.registerType({
      id: childId,
      parent: parentId,
      fields: { extra: { type: "string" } },
    });
    expect(child.ok).toBe(true);

    const blocked = await client.deleteType(parentId);
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe(409);
    expect(blocked.error?.error.code).toBe("type_has_subtypes");
    expect(blocked.error?.error.details?.subtype_ids).toContain(childId);

    const childGone = await client.deleteType(childId);
    expect(childGone.ok).toBe(true);

    const parentGone = await client.deleteType(parentId);
    expect(parentGone.ok).toBe(true);
  });

  it("answers 404 deleting a type identifier that was never registered", async () => {
    const r = await client.deleteType(testTypeId("delete-absent"));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.error?.error.code).toBe("type_not_found");
  });

  it("creates item with valid properties for a registered type", async () => {
    const typeId = testTypeId("valid-properties");
    const schema: TypeSchema = {
      id: typeId,
      fields: {
        title: { type: "string", required: true },
        count: { type: "number" },
      },
    };

    const registered = await client.registerType(schema);
    expect(registered.ok).toBe(true);

    const item = await client.createItem({
      type: typeId,
      properties: { title: "Valid properties", count: 42 },
      source: ctx.source,
    });
    expect(item.ok).toBe(true);
    expect(item.status).toBe(201);
    trackItem(ctx, item.data.item.id);
  });

  it("rejects item with invalid properties for a registered type", async () => {
    const typeId = testTypeId("invalid-properties");
    const schema: TypeSchema = {
      id: typeId,
      fields: {
        title: { type: "string", required: true },
      },
    };

    const registered = await client.registerType(schema);
    expect(registered.ok).toBe(true);

    const item = await client.createItem({
      type: typeId,
      properties: { description: "Missing title" },
      source: ctx.source,
    });
    expect(item.status).toBe(400);
    expect(item.error?.error.code).toBe("invalid_properties");
    const errors = item.error?.error.details?.errors as
      Array<{ field: string }> | undefined;
    expect(errors?.map((e) => e.field)).toContain("title");
  });

  it("rejects item with an unregistered type", async () => {
    // Every item must carry a registered type. An identifier with no schema
    // has nothing to validate against, so the server rejects it with
    // `unknown_type` rather than persisting an ad-hoc / typo'd type. Custom
    // types must be registered via POST /types before items of that type can
    // be created.
    const unregisteredType = `user.evaluator-unregistered-${generateId().slice(0, 8).toLowerCase()}`;

    const item = await client.createItem({
      type: unregisteredType,
      properties: { anything: "goes" },
      source: ctx.source,
    });
    expect(item.ok).toBe(false);
    expect(item.status).toBe(400);
    expect(item.error?.error.code).toBe("unknown_type");
  });
});
