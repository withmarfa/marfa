/**
 * Conformance for what a credential may do with the internal `system.*` type
 * set, which under one permission model is: nothing.
 *
 * Every real `system.*` row is written by the server through the storage
 * layer, so the half that is assertable black-box is the refusal, asserted
 * from a credential holding write on every type.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackFolder,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "system-types",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function narrowClient(label: string): Promise<MarfaClient> {
  const resp = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions: { "*": "write" },
  });
  expect(resp.ok).toBe(true);
  trackKey(ctx, resp.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: resp.data.key });
}

describe("system.* set", () => {
  it("rejects system.* writes from every key the API can mint", async () => {
    const np = await narrowClient("np-system-write");
    const r = await np.createItem({
      type: "system.connection",
      properties: {
        kind: "app",
        status: "active",
        granted_at: new Date().toISOString(),
      },
    });
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("type_not_permitted");
  });

  it("refuses a system.folder write on every item door, from a key the folder door admits", async () => {
    const np = await narrowClient("np-folder-write");
    // The witness: this key writes a folder through its own door.
    const made = await np.createFolder({ title: "item doors" });
    expect(made.status).toBe(201);
    const folderId = made.data.item.id;
    trackFolder(ctx, folderId);
    const note = await np.createItem({
      type: "core.note",
      properties: { body: "not a folder" },
    });
    expect(note.status).toBe(201);
    trackItem(ctx, note.data.item.id);

    const answers = [
      await np.createItem({
        type: "system.folder",
        properties: { title: "x" },
      }),
      await np.updateItem(folderId, { version: 1, properties: { title: "x" } }),
      await np.deleteItem(folderId),
      await np.transitionItem(folderId, "archived"),
      await np.updateItem(note.data.item.id, {
        version: 1,
        type: "system.folder",
        retype: true,
        properties: { title: "x" },
      }),
    ];
    for (const r of answers) {
      expect(r.status).toBe(403);
      expect(r.error?.error.code).toBe("type_not_permitted");
    }
    const bulk = await np.bulkItems([
      { type: "system.folder", properties: { title: "x" } },
    ]);
    expect(bulk.status).toBe(403);
    expect(bulk.error?.error.code).toBe("bulk_atomic_rollback");
    expect(
      (bulk.error?.error.details as { code?: string } | undefined)?.code,
    ).toBe("type_not_permitted");

    const unchanged = await np.getItem(folderId);
    expect(unchanged.data.item.version).toBe(1);
    expect(unchanged.data.item.state).toBe("active");
  });

  it("ships only the system types the server writes", async () => {
    // **The absence is witnessed.** The two types something writes are
    // asserted present by the same doors, so a lookup that answered nothing
    // for every id would redden here.
    for (const id of ["system.connection", "system.folder"]) {
      const r = await client.getType(id);
      expect(r.status, id).toBe(200);
    }
    for (const id of [
      "system.account_holder",
      "system.app",
      "system.device",
      "system.webhook",
    ]) {
      const r = await client.getType(id);
      expect(r.status, id).toBe(404);
      expect(r.error?.error.code, id).toBe("type_not_found");
    }
  });

  it("declares app as the only system.connection kind", async () => {
    const r = await client.getType("system.connection");
    expect(r.ok).toBe(true);
    expect(r.data.fields.kind?.enum_values).toEqual(["app"]);
    expect(r.data.description ?? "").not.toContain("connector");
  });

  it("ships none of the system.connection fields no door accepts", async () => {
    // No door accepts these fields and no server path stamps them, so the
    // type declares none of them and its description has nothing to
    // explain about them.
    //
    // **The absence is witnessed.** A type serving no fields at all
    // would pass an absence assertion while meaning something entirely
    // different, so the fields the type keeps are asserted present in
    // the same read.
    const unwritten = [
      "attached_device",
      "feed_activity",
      "last_error_at",
      "last_sync_at",
      "mapping_reapply_until",
      "next_run_at",
      "runtime_status",
      "triggers",
      "connector_id",
      "credential_id",
      "configuration",
      "direction",
      "mapping",
    ];
    const kept = [
      "kind",
      "status",
      "granted_at",
      "client_id",
      "scopes",
      "last_used_at",
      "revoked_at",
    ];

    const r = await client.getType("system.connection");
    expect(r.ok).toBe(true);
    const declared = Object.keys(r.data.fields);

    expect(unwritten.filter((name) => declared.includes(name))).toEqual([]);
    expect(kept.filter((name) => !declared.includes(name))).toEqual([]);

    // And the description says nothing about them: a sentence explaining
    // why absent fields are absent is a declaration by other means.
    const description = r.data.description ?? "";
    expect(unwritten.filter((name) => description.includes(name))).toEqual([]);
    expect(description).not.toContain("written by nothing in this build");
    expect(description).not.toContain("server-stamped");
  });

  it("serves no system.connection carrying a field the type no longer declares", async () => {
    // The other half of the same claim, and the half a schema cannot
    // make on its own: a field removed from the declaration can still be
    // sitting in a stored row. Nothing over the wire creates a
    // `system.connection` — an OAuth grant is what writes one — so this
    // asserts over whatever the instance happens to hold and is vacuous
    // on a dataset with none. Vacuous and honest beats absent: the
    // moment a grant exists in the run, a server path that started
    // filling one of them reddens here.
    const unwritten = [
      "attached_device",
      "feed_activity",
      "last_error_at",
      "last_sync_at",
      "mapping_reapply_until",
      "next_run_at",
      "runtime_status",
      "triggers",
      "connector_id",
      "credential_id",
      "configuration",
      "direction",
      "mapping",
    ];
    const r = await client.rawRequest<{
      data: { id: string; properties: Record<string, unknown> }[];
    }>("/items?type=system.connection&include=system&limit=100");
    expect(r.status).toBe(200);
    const populated: string[] = [];
    for (const row of r.data.data) {
      for (const name of unwritten) {
        if (row.properties[name] !== undefined) {
          populated.push(`${row.id}.${name}`);
        }
      }
    }
    expect(populated).toEqual([]);
  });
});
