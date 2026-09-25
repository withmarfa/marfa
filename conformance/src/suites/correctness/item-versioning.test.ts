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
    expect(history.data.data.length).toBe(1);

    const firstVersion = history.data.data[0];
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
        version,
      });
      expect(updated.ok).toBe(true);
      version = updated.data.item.version;
    }

    const history = await client.getVersions(r.data.item.id);
    expect(history.ok).toBe(true);
    expect(history.data.data.map((v) => v.properties.title)).toEqual([
      "V1",
      "V2",
      "V3",
    ]);
  });

  it("refuses a body key the update door does not declare", async () => {
    // `force_snapshot` is a key the door does not declare. Accepted and
    // ignored, it would tell the caller its request had been honored when
    // only the half the door understood was, so the door refuses a key it
    // does not declare rather than dropping it, the rule the query grammar
    // keeps.
    const r = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "C1", body: "First" },
      }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const refused = await client.rawRequest<unknown>(
      `/items/${r.data.item.id}`,
      {
        method: "PATCH",
        body: {
          properties: { title: "C2" },
          version: r.data.item.version,
          force_snapshot: true,
        },
      },
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");

    // The witness. The same body without the key is accepted, so the
    // refusal above is about the key and not about the write, and a
    // snapshot is written on an update that carries no flag asking for one.
    const accepted = await client.updateItem(r.data.item.id, {
      properties: { title: "C2" },
      version: r.data.item.version,
    });
    expect(accepted.ok).toBe(true);
    const history = await client.getVersions(r.data.item.id);
    expect(history.ok).toBe(true);
    expect(history.data.data.map((v) => v.properties.title)).toEqual(["C1"]);
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
    expect(
      body.current.id,
      "the refusal did not name the row it is about in current.id",
    ).toBe(r.data.item.id);
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
    expect(
      [body.current.id, body.ancestor.id],
      "the refusal did not name the row in current.id and ancestor.id",
    ).toEqual([r.data.item.id, r.data.item.id]);
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

  it("refuses a stale write that collides on tier, occurred_at or source_id", async () => {
    // The three item fields an update may change that are not properties.
    // A version check that looked at properties alone would merge a stale
    // write carrying only one of these and overwrite the newer value it
    // landed on with nothing refused: a device holding the version as its
    // protection would be protected on properties and on nothing else.
    const cases = [
      {
        // Both writers move it, and a tier has two values, so they agree
        // on the destination. It is still a collision: the stale writer
        // read a row the first has already moved, and a check that let the
        // agreement through would depend on how many values a field has.
        field: "tier",
        server: { tier: "feed" as const },
        client: { tier: "feed" as const },
      },
      {
        field: "occurred_at",
        server: { occurred_at: "2026-03-01T00:00:00.000Z" },
        client: { occurred_at: "2026-04-01T00:00:00.000Z" },
      },
      {
        field: "source_id",
        server: { source_id: `${ctx.source}-server` },
        client: { source_id: `${ctx.source}-client` },
      },
    ];

    for (const { field, server, client: clientChange } of cases) {
      const r = await client.createItem(
        createNote({
          source: ctx.source,
          properties: { title: `Stale ${field}`, body: "Original" },
        }),
      );
      expect(r.ok, field).toBe(true);
      trackItem(ctx, r.data.item.id);
      // The three as they stand at the version the stale write will name,
      // so the envelope's `ancestor` can be held to them rather than to
      // whatever it happens to carry.
      const atBase = {
        tier: r.data.item.tier,
        occurred_at: r.data.item.occurred_at,
        source_id: r.data.item.source_id ?? null,
      };

      const advanced = await client.updateItem(r.data.item.id, {
        ...server,
        version: 1,
      });
      expect(advanced.ok, field).toBe(true);
      expect(advanced.data.item.version, field).toBe(2);

      const stale = await client.updateItem(r.data.item.id, {
        ...clientChange,
        version: 1,
      });
      expect(stale.status, field).toBe(409);
      expect(stale.error?.error.code, field).toBe("version_conflict");
      const body = stale.error as unknown as ConflictResponse;
      expect(body.conflicting_fields, field).toEqual([field]);

      // Both sides of the field the refusal names. Without them the
      // caller is told which field collided and has no way to read
      // either value, so the one thing it needs to resolve is the one
      // thing the envelope withholds.
      const snapshotField = field as "tier" | "occurred_at" | "source_id";
      expect(body.current[snapshotField], field).toEqual(
        server[snapshotField as keyof typeof server],
      );
      expect(body.ancestor[snapshotField], field).toEqual(
        atBase[snapshotField],
      );

      // The row is the one the first writer left, not the stale writer's.
      const after = await client.getItem(r.data.item.id);
      expect(after.ok, field).toBe(true);
      expect(after.data.item.version, field).toBe(2);
    }
  });

  it("merges a stale write on an item field nobody else changed", async () => {
    // The witness for the case above, and the rule it must not break:
    // `versions.md` 11 merges a stale write whose changed fields did not
    // collide, and widening the check to the three item fields does not
    // make every stale write carrying one a refusal.
    const r = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Non-colliding", body: "Original" },
      }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const advanced = await client.updateItem(r.data.item.id, {
      properties: { title: "Server title" },
      version: 1,
    });
    expect(advanced.ok).toBe(true);

    const stale = await client.updateItem(r.data.item.id, {
      tier: "feed",
      version: 1,
    });
    expect(stale.status).toBe(200);
    expect(stale.data.item.tier).toBe("feed");
    expect(stale.data.item.properties.title).toBe("Server title");
  });

  it("takes a replace at the current version as the item's whole properties, and refuses one that drops a required field", async () => {
    const r = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Whole", body: "Original", notes: "Set" },
      }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const replaced = await client.updateItem(r.data.item.id, {
      properties: { body: "Original" },
      properties_mode: "replace",
      version: 1,
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    expect(replaced.data.item.properties).toEqual({ body: "Original" });
    expect(replaced.data.item.version).toBe(2);

    // The witness for the refusal: the same shape landed above with the
    // required field in it.
    const dropped = await client.updateItem(r.data.item.id, {
      properties: { title: "No body" },
      properties_mode: "replace",
      version: 2,
    });
    expect(dropped.status).toBe(400);
    expect(dropped.error?.error.code).toBe("invalid_properties");

    const fetched = await client.getItem(r.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.version).toBe(2);
    expect(fetched.data.item.properties).toEqual({ body: "Original" });
  });

  it("moves the type on a stale write as on a current one", async () => {
    const r = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Moving", body: "Original" },
      }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const advanced = await client.updateItem(r.data.item.id, {
      properties: { title: "Server title" },
      version: 1,
    });
    expect(advanced.ok).toBe(true);
    // The witness for the clear below: the body is there to be cleared.
    expect(advanced.data.item.properties.body).toBe("Original");

    // The replace clears the body the note had, the url arrives with it,
    // and the title the other writer changed since is kept, because this
    // write echoed it at the value it read.
    const moved = await client.updateItem(r.data.item.id, {
      type: "core.bookmark",
      retype: true,
      properties: { url: "https://example.com/moved", title: "Moving" },
      properties_mode: "replace",
      version: 1,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect(moved.data.item.type).toBe("core.bookmark");
    expect(moved.data.item.version).toBe(3);
    expect(moved.data.item.properties).toEqual({
      url: "https://example.com/moved",
      title: "Server title",
    });

    const fetched = await client.getItem(r.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.type).toBe("core.bookmark");
    expect(fetched.data.item.properties).not.toHaveProperty("body");
  });

  it("refuses a stale move whose merged properties fall short of the type entered", async () => {
    // A bookmark requires nothing and may carry a body; a note requires
    // one. The body this write carries echoes the ancestor's value, so it
    // is not applied, and the other writer removed it since: the row a
    // note would be left as has no body.
    const r = await client.createItem({
      type: "core.bookmark",
      source: ctx.source,
      properties: { url: "https://example.com/short", body: "Carried" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const removed = await client.updateItem(r.data.item.id, {
      properties: { url: "https://example.com/short" },
      properties_mode: "replace",
      version: 1,
    });
    expect(removed.ok).toBe(true);
    expect(removed.data.item.properties).not.toHaveProperty("body");

    const refused = await client.updateItem(r.data.item.id, {
      type: "core.note",
      retype: true,
      properties: { body: "Carried" },
      version: 1,
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");

    const fetched = await client.getItem(r.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.type).toBe("core.bookmark");
    expect(fetched.data.item.version).toBe(2);
  });

  it("moves the type with retype alone, holding the row to the type entered", async () => {
    const r = await client.createItem({
      type: "core.bookmark",
      source: ctx.source,
      properties: { url: "https://example.com/alone", body: "Kept" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const moved = await client.updateItem(r.data.item.id, {
      type: "core.note",
      retype: true,
      version: 1,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect(moved.data.item.type).toBe("core.note");
    expect(moved.data.item.version).toBe(2);
    expect(moved.data.item.properties.body).toBe("Kept");

    // The witness: the same move on a row without the body the note
    // requires is refused, and nothing moves.
    const bare = await client.createItem({
      type: "core.bookmark",
      source: ctx.source,
      properties: { url: "https://example.com/bare" },
    });
    expect(bare.ok).toBe(true);
    trackItem(ctx, bare.data.item.id);
    const refused = await client.updateItem(bare.data.item.id, {
      type: "core.note",
      retype: true,
      version: 1,
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    const fetched = await client.getItem(bare.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.type).toBe("core.bookmark");
    expect(fetched.data.item.version).toBe(1);
  });

  it("clears a field a stale replace leaves out, where nobody changed it since", async () => {
    // `versions.md` 11 applies a stale write's genuine changes over the
    // current row. Under `properties_mode: replace` the body is the whole of
    // the caller's properties, so a field the ancestor had and the body
    // lacks is one of those changes: the caller cleared it.
    const r = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Replace", body: "Original", notes: "To clear" },
      }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const advanced = await client.updateItem(r.data.item.id, {
      properties: { title: "Server title" },
      version: 1,
    });
    expect(advanced.ok).toBe(true);
    // The witness: the field is there to be cleared.
    expect(advanced.data.item.properties.notes).toBe("To clear");

    const stale = await client.updateItem(r.data.item.id, {
      properties: { title: "Replace", body: "Original" },
      properties_mode: "replace",
      version: 1,
    });
    expect(stale.status, JSON.stringify(stale.error)).toBe(200);
    expect(stale.data.item.properties).not.toHaveProperty("notes");
    expect(stale.data.item.properties.title).toBe("Server title");
    expect(stale.data.item.properties.body).toBe("Original");
    // A merge is told from a clean write by its version: more than one step
    // past the one the caller named.
    expect(stale.data.item.version).toBe(3);

    const fetched = await client.getItem(r.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.properties).not.toHaveProperty("notes");
  });

  it("refuses a stale replace that leaves out a field the other writer changed since", async () => {
    const r = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Replace", body: "Original", notes: "Mine" },
      }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const advanced = await client.updateItem(r.data.item.id, {
      properties: { notes: "Changed since" },
      version: 1,
    });
    expect(advanced.ok).toBe(true);
    expect(advanced.data.item.version).toBe(2);

    const stale = await client.updateItem(r.data.item.id, {
      properties: { title: "Replace", body: "Original" },
      properties_mode: "replace",
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.error?.error.code).toBe("version_conflict");
    const body = stale.error as unknown as ConflictResponse;
    expect(body.conflicting_fields).toEqual(["notes"]);
    expect(body.current.version).toBe(2);
    expect(body.current.properties.notes).toBe("Changed since");

    const fetched = await client.getItem(r.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.version).toBe(2);
    expect(fetched.data.item.properties.notes).toBe("Changed since");
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
    expect(
      body.current.id,
      "the refusal did not name the row it is about in current.id",
    ).toBe(r.data.item.id);
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
    expect(history.data.data.length).toBe(0);
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
    expect(history.data.data.length).toBe(1);
    expect(history.data.data[0].item_id).toBe(r.data.item.id);
  });
});
