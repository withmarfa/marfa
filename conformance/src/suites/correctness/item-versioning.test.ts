import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  AncestorUnavailableResponse,
  ConflictResponse,
  MarfaItem,
  StaleVersionResponse,
  TestContext,
} from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "item-versioning"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("item versioning", () => {
  it("version starts at 1 on creation", async () => {
    const note = createNote({ source: ctx.source });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    expect(r.data.item.version).toBe(1);
    trackItem(ctx, r.data.item.id);
  });

  it("version increments on update", async () => {
    const note = createNote({
      source: ctx.source,
      properties: { title: "Version 1", body: "Original content" },
    });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    expect(r.data.item.version).toBe(1);
    trackItem(ctx, r.data.item.id);

    const updated = await client.updateItem(r.data.item.id, {
      properties: { title: "Version 2", body: "Updated content" },
      version: r.data.item.version,
    });
    expect(updated.ok).toBe(true);
    await expectMatchesSchema("PATCH", "/items/{id}", 200, updated.data);
    expect(updated.data.item.version).toBe(2);
  });

  it("updating an item creates a version snapshot", async () => {
    const note = createNote({
      source: ctx.source,
      properties: { title: "Version 1", body: "Original content" },
    });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const updated = await client.updateItem(r.data.item.id, {
      properties: { title: "Version 2", body: "Updated content" },
      version: r.data.item.version,
    });
    expect(updated.ok).toBe(true);
    expect(updated.data.item.properties.title).toBe("Version 2");

    const history = await client.getVersions(r.data.item.id);
    expect(history.ok).toBe(true);
    await expectMatchesSchema("GET", "/items/{id}/versions", 200, history.data);
    expect(history.data.versions.length).toBe(1);

    const firstVersion = history.data.versions[0];
    expect(firstVersion.properties.title).toBe("Version 1");
  });

  it("multiple updates create multiple versions", async () => {
    const note = createNote({
      source: ctx.source,
      properties: { title: "V1", body: "First" },
    });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    let version = r.data.item.version;
    for (let i = 2; i <= 4; i++) {
      const updated = await client.updateItem(r.data.item.id, {
        properties: { title: `V${i}`, body: `Version ${i}` },
        force_snapshot: true,
        version,
      });
      expect(updated.ok).toBe(true);
      version = updated.data.item.version;
    }

    const history = await client.getVersions(r.data.item.id);
    expect(history.ok).toBe(true);
    expect(history.data.versions.map((v) => v.properties.title)).toEqual([
      "V1",
      "V2",
      "V3",
    ]);
  });

  it("every update writes a snapshot, with or without force_snapshot", async () => {
    // The control for the case above: the flag changes nothing observable
    // on this server, so the count is the same without it.
    const r = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "C1", body: "First" },
      }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    let version = r.data.item.version;
    for (let i = 2; i <= 4; i++) {
      const updated = await client.updateItem(r.data.item.id, {
        properties: { title: `C${i}`, body: `Version ${i}` },
        version,
      });
      expect(updated.ok).toBe(true);
      version = updated.data.item.version;
    }
    const history = await client.getVersions(r.data.item.id);
    expect(history.ok).toBe(true);
    expect(history.data.versions.map((v) => v.properties.title)).toEqual([
      "C1",
      "C2",
      "C3",
    ]);
  });

  it("answers 404 for an unknown item's history and 400 for a malformed id", async () => {
    const unknown = await client.getVersions(
      "00000000-0000-7000-8000-000000000000",
    );
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("item_not_found");
    const malformed = await client.getVersions("not-an-id");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("invalid_id");
  });

  it("an update naming no version is refused", async () => {
    // The body is otherwise valid, so the only thing wrong with it is the
    // missing version. A server that answered `validation_error` here, or
    // that applied the write, would be offering the blind overwrite the
    // contract does not have: the writer names the version it read, or it
    // silently discards whatever arrived since it read.
    const note = createNote({
      source: ctx.source,
      properties: { title: "Unversioned", body: "Original" },
    });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const refused = await client.rawRequest<{ item: MarfaItem }>(
      `/items/${r.data.item.id}`,
      {
        method: "PATCH",
        body: { properties: { title: "Blind overwrite" } },
      },
    );
    expect(
      refused.status,
      `an update naming no version was not refused 400: ${JSON.stringify(refused.error ?? refused.data)}`,
    ).toBe(400);
    expect(refused.error?.error.code).toBe("missing_required_field");

    // The half that matters. A 400 reported after the write landed protects
    // nothing, and every assertion above passes on a server that refuses
    // loudly and writes anyway.
    const after = await client.getItem(r.data.item.id);
    expect(after.ok).toBe(true);
    expect(
      after.data.item.properties.title,
      "the refused write reached the stored row, so the refusal was reported without being enforced",
    ).toBe("Unversioned");
    expect(after.data.item.version, "a refused update moved the version").toBe(
      r.data.item.version,
    );
  });

  it("a version no client ever read answers ancestor_unavailable", async () => {
    const note = createNote({
      source: ctx.source,
      properties: { title: "Conflict test", body: "Original" },
    });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    expect(r.data.item.version).toBe(1);
    trackItem(ctx, r.data.item.id);

    const conflict = await client.updateItem(r.data.item.id, {
      properties: { title: "Stale update" },
      version: 0,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.error?.error.code).toBe("ancestor_unavailable");
    const body = conflict.error as unknown as AncestorUnavailableResponse;
    expect(body.error.status).toBe(409);
    expect(body.requested_version).toBe(0);
    expect(body.current.version).toBe(1);
    expect(body.current.properties.title).toBe("Conflict test");
    expect(body).not.toHaveProperty("ancestor");
    expect(body).not.toHaveProperty("merge_policy");
  });

  it("a stale write answers version_conflict with a three-way envelope", async () => {
    const note = createNote({
      source: ctx.source,
      properties: { title: "Conflict test", body: "Original" },
    });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const advanced = await client.updateItem(r.data.item.id, {
      properties: { title: "Server title" },
      version: 1,
    });
    expect(advanced.ok).toBe(true);
    expect(advanced.data.item.version).toBe(2);

    const conflict = await client.updateItem(r.data.item.id, {
      properties: { title: "Stale update" },
      version: 1,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.error?.error.code).toBe("version_conflict");

    const body = conflict.error as unknown as ConflictResponse;
    expect(body.error.status).toBe(409);
    expect(body.current.version).toBe(2);
    expect(body.current.properties.title).toBe("Server title");
    expect(body.current.properties.body).toBe("Original");
    expect(body.ancestor.version).toBe(1);
    expect(body.ancestor.properties.title).toBe("Conflict test");
    expect(body.conflicting_fields).toEqual(["title"]);

    // The resolved policy for core.note: body and notes keep both copies,
    // everything else, title included, is last-writer-wins by default.
    expect(body.merge_policy.default).toBe("last_writer_wins");
    expect(body.merge_policy.fields?.body).toBe("keep_both_copies");
    expect(body.merge_policy.fields?.notes).toBe("keep_both_copies");
    expect(body.merge_policy.fields?.title).toBeUndefined();
  });

  it("answers an edges-only stale write with the envelope minus its merge half", async () => {
    // The third shape this code is answered in, and the one a client is
    // most likely to be surprised by: there is nothing to merge, so there
    // is no ancestor and no field list, but `error.status` and `current`
    // are on every `version_conflict` the server answers.
    const r = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Edges only", body: "Original" },
      }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    const target = await client.createItem(createNote({ source: ctx.source }));
    expect(target.ok).toBe(true);
    trackItem(ctx, target.data.item.id);

    const advanced = await client.updateItem(r.data.item.id, {
      properties: { title: "Server title" },
      version: 1,
    });
    expect(advanced.ok).toBe(true);

    const stale = await client.updateItem(r.data.item.id, {
      version: 1,
      edges: { references: [target.data.item.id] },
    } as unknown as Parameters<typeof client.updateItem>[1]);
    expect(stale.status).toBe(409);
    expect(stale.error?.error.code).toBe("version_conflict");

    const body = stale.error as unknown as StaleVersionResponse &
      Partial<ConflictResponse>;
    expect(body.error.status).toBe(409);
    expect(body.current.version).toBe(2);
    expect(body.current.properties.title).toBe("Server title");
    // And not the three a merge would need.
    expect(body.ancestor).toBeUndefined();
    expect(body.conflicting_fields).toBeUndefined();
    expect(body.merge_policy).toBeUndefined();

    // The control: the same write at the current version lands, so the 409
    // is the version rather than the shape of the request.
    const fresh = await client.updateItem(r.data.item.id, {
      version: 2,
      edges: { references: [target.data.item.id] },
    } as unknown as Parameters<typeof client.updateItem>[1]);
    expect(fresh.status).toBe(200);
  });

  it("version history for item with no updates is empty", async () => {
    const note = createNote({ source: ctx.source });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const history = await client.getVersions(r.data.item.id);
    expect(history.ok).toBe(true);
    expect(history.data.versions.length).toBe(0);
  });

  it("versions have correct item_id reference", async () => {
    const note = createNote({ source: ctx.source });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    await client.updateItem(r.data.item.id, {
      properties: { title: "Updated", body: "Changed" },
      version: r.data.item.version,
    });

    const history = await client.getVersions(r.data.item.id);
    expect(history.ok).toBe(true);
    expect(history.data.versions.length).toBe(1);
    expect(history.data.versions[0].item_id).toBe(r.data.item.id);
  });
});
