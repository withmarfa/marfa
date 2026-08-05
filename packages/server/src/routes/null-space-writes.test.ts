/**
 * A space-bound credential cannot write a row no space owns.
 *
 * Staging accumulated 125 `system.activity` rows with `space_id: null` over
 * five weeks, every one of them attributed by `properties.connection_id` to a
 * Connection that had a perfectly good space. Only the runtime execution
 * path was affected: the install and uninstall pipelines pass a space
 * explicitly, while an integration's own writes are stamped from the credential
 * it presents. `POST /keys` minted space-less credentials from a platform
 * admin, so a credential that read as scoped carried the platform tier, and
 * every row it wrote landed unowned.
 *
 * A null space is not a missing label. It is the signal the RLS policies and
 * the storage layer's space predicate both read as "every space", so an
 * unowned row is visible across the boundary it was supposed to sit inside.
 * The condition had been reproduced deliberately on a test instance and
 * dismissed as theoretical; this is it arising on its own, in ordinary
 * operation.
 *
 * The mint paths are guarded where they mint — `POST /keys` refuses a
 * space-less `space_admin`, and `assertMintableSpaceScope` refuses a
 * runtime-credential mint for a Connection with no space. Those tests prove
 * the refusals. This one proves the consequence, at the layer the residue
 * appeared: what a credential actually writes. A future mint path that
 * reintroduces the gap would pass every existing test and fail this one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { IntegrationManifest } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
});

afterAll(async () => {
  await ctx.cleanup();
});

function manifest(name: string): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "Null-space guard fixture",
    direction: "read",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    runtime_compatibility: ["hosted"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "1.0.0",
    permissions: {},
  };
}

/** A runtime credential bound to a Connection in `spaceId`. */
async function runtimeCredential(
  spaceId: string,
): Promise<{ key: string; connectionId: string }> {
  const name = `acme.null-space-${Math.random().toString(36).slice(2, 10)}`;
  const m = manifest(name);
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: m.name,
        manifest_version: m.version,
        publisher: m.publisher,
        manifest: m,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  const connection = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: integration.id,
      },
    },
    spaceId,
  );
  const suffix = Math.random().toString(36).slice(2, 10);
  const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
    key: ctx.adminKey,
    body: {
      connection_id: connection.id,
      integration_name: name,
      label: `null-space ${suffix}`,
      source: `null-space-${suffix}`,
    },
  });
  expect(res.status).toBe(201);
  return {
    key: ((await res.json()) as { api_key: string }).api_key,
    connectionId: connection.id,
  };
}

/** Every row of a type with no owning space, asked of the storage layer
 *  directly: a space-scoped read cannot see them, which is why the residue
 *  went unnoticed for five weeks. */
async function unownedRowIds(type: string): Promise<string[]> {
  const rows = await ctx.storage.items.list({ type, limit: 500 });
  return rows.data
    .filter((r) => (r.space_id ?? null) === null)
    .map((r) => r.id);
}

describe("a runtime credential's writes belong to its space", () => {
  it("REGRESSION: an activity row written by an integration carries the space", async () => {
    const space = await ctx.storage.spaces!.create("activity-owner");
    const cred = await runtimeCredential(space.id);

    const res = await request(ctx.app, "POST", "/items", {
      key: cred.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: cred.connectionId,
          severity: "info",
          summary: "sync complete",
        },
      },
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { item: { id: string } }).item.id;

    // Asserted on the stored row, not on the response: the wire shape could
    // echo a space the row does not carry, and it is the row RLS filters on.
    const stored = await ctx.storage.items.get(id, space.id);
    expect(stored?.space_id).toBe(space.id);

    // And the row is genuinely fenced: a sibling space cannot reach it. A
    // null-space row would be visible to both, which is the whole exposure.
    const other = await ctx.storage.spaces!.create("activity-other");
    // Coalesced because the two dialects differ on absent-row representation,
    // and the property is "not reachable", not which falsy value says so.
    expect((await ctx.storage.items.get(id, other.id)) ?? null).toBeNull();
  });

  it("leaves no unowned system.activity row behind", async () => {
    // The observable the staging inventory used, as a standing guard. A row
    // attributed to a Connection but owned by nobody is the exact shape that
    // accumulated, and it is invisible to every space-scoped read — so the
    // question has to be asked unscoped or not at all.
    const space = await ctx.storage.spaces!.create("activity-sweep");
    const cred = await runtimeCredential(space.id);
    for (const summary of ["first", "second", "third"]) {
      const res = await request(ctx.app, "POST", "/items", {
        key: cred.key,
        body: {
          type: "system.activity",
          properties: {
            connection_id: cred.connectionId,
            severity: "info",
            summary,
          },
        },
      });
      expect(res.status).toBe(201);
    }
    expect(await unownedRowIds("system.activity")).toEqual([]);
  });

  it("projects the owning space on a search hit, not a null", async () => {
    // A read that stamped `space_id: null` on an owned row would create the
    // same confusion from the other direction, and the inventory that found
    // the residue reads through surfaces like this one. Searched as a
    // `core.note` because `system.*` rows are deliberately excluded from
    // search, so the type that carried the residue cannot be asked here.
    const space = await ctx.storage.spaces!.create("search-owner");
    const cred = await runtimeCredential(space.id);
    const marker = `srch${Math.random().toString(36).slice(2, 8)}`;
    const created = await request(ctx.app, "POST", "/items", {
      key: cred.key,
      body: { type: "core.note", properties: { body: `searchable ${marker}` } },
    });
    expect(created.status).toBe(201);

    const res = await request(ctx.app, "GET", `/search?q=${marker}`, {
      key: cred.key,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { item: { id: string; space_id?: string | null } }[];
    };
    expect(body.results.length).toBeGreaterThan(0);
    for (const hit of body.results) {
      expect(hit.item.space_id ?? null).toBe(space.id);
    }
  });

  it("refuses to mint a credential for a Connection with no space", async () => {
    // The mint-side half, kept here beside the consequence it produces: a
    // space-less credential is not a narrow credential, it is the platform
    // tier, so the refusal is what makes the guard above hold rather than
    // merely happening to pass.
    const name = `acme.unspaceed-${Math.random().toString(36).slice(2, 10)}`;
    const m = manifest(name);
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: m.name,
          manifest_version: m.version,
          publisher: m.publisher,
          manifest: m,
          registered_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const orphan = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
          integration_ref: integration.id,
        },
      },
      undefined,
    );
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: orphan.id,
        integration_name: name,
        label: `orphan ${suffix}`,
        source: `orphan-${suffix}`,
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
