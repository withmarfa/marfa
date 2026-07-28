/**
 * What a runtime credential is bound to, and for how long.
 *
 * Four properties, each of which was violated in a way that produced no
 * error, no log line and no failing test:
 *
 *   1. A credential is fenced by a tenant. A Connection installed
 *      without one produced a credential with no `tenant_id`, which is
 *      not a narrow credential but the platform tier: the RLS wrapper
 *      skips it and the storage layer drops its tenant predicate, so
 *      reading `core.note` returned other customers' rows.
 *   2. A credential's item provenance survives its own rotation. The
 *      stamped `source` used to be the credential's, which changes on
 *      every mint, so upsert identity `(source, source_id)` moved with
 *      it and every refresh forked the connector's corpus.
 *   3. A mint cannot outlive the uninstall it raced. The state check and
 *      the write were not serialized against the pipeline that revokes
 *      credentials and revokes the Connection.
 *   4. A credential speaks only for its own Connection. The
 *      `system.activity` carve-out is about the type; it said nothing
 *      about whose activity a row claimed to be.
 *
 * Boots in `hosted` mode because three of the four are only wrong on a
 * deployment that has tenants.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { IntegrationManifest } from "@withmarfa/shared";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
});

afterAll(async () => {
  await ctx.cleanup();
});

const INTEGRATION = "acme.lifecycle";

interface MintResponse {
  id: string;
  api_key: string;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

function manifest(name: string): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "Runtime credential lifecycle fixture",
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

async function makeConnection(
  tenantId: string | undefined,
  name = INTEGRATION,
): Promise<string> {
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
    tenantId,
  );
  return connection.id;
}

async function mint(
  connectionId: string,
  integrationName = INTEGRATION,
): Promise<Response> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return request(ctx.app, "POST", "/system/runtime-credentials", {
    key: ctx.adminKey,
    body: {
      connection_id: connectionId,
      integration_name: integrationName,
      label: `lifecycle ${suffix}`,
      source: `lifecycle-${suffix}`,
    },
  });
}

describe("a runtime credential is fenced by a tenant", () => {
  it("refuses to mint for a Connection with no tenant", async () => {
    const tenantA = await ctx.storage.tenants!.create("A");
    const tenantB = await ctx.storage.tenants!.create("B");
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "a-note" } },
      tenantA.id,
    );
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "b-note" } },
      tenantB.id,
    );

    // A platform admin can install a Connection without naming a tenant.
    // Nothing downstream notices until the credential minted for it
    // starts reading, at which point it reads everything.
    const connectionId = await makeConnection(undefined);
    const res = await mint(connectionId);

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("forbidden");
    expect(body.error.message).toMatch(/no tenant/i);
  });

  it("keeps minting for a Connection that has one", async () => {
    // The guard must refuse the tenant-less case and nothing else, or it
    // would take every integration offline rather than one broken
    // install.
    const tenant = await ctx.storage.tenants!.create("scoped");
    const connectionId = await makeConnection(tenant.id);
    expect((await mint(connectionId)).status).toBe(201);
  });
});

describe("item provenance survives a credential rotation", () => {
  it("upserts under the same source across two mints", async () => {
    const tenant = await ctx.storage.tenants!.create("provenance");
    const connectionId = await makeConnection(tenant.id);

    const first = (await (await mint(connectionId)).json()) as MintResponse;
    const created = await request(ctx.app, "POST", "/items", {
      key: first.api_key,
      body: {
        type: "core.note",
        source_id: "upstream-42",
        properties: { body: "first write" },
      },
    });
    expect(created.status).toBe(201);
    const firstItem = (
      (await created.json()) as { item: { id: string; source: string } }
    ).item;

    // The refresh the broker performs on every cache miss.
    const second = (await (await mint(connectionId)).json()) as MintResponse;
    const rewritten = await request(ctx.app, "POST", "/items", {
      key: second.api_key,
      body: {
        type: "core.note",
        source_id: "upstream-42",
        properties: { body: "second write" },
      },
    });
    // 200, not 201: the upsert found the existing row. A 201 here is the
    // defect — the same upstream record stored twice, silently, once per
    // credential generation.
    expect(rewritten.status).toBe(200);
    const secondItem = (
      (await rewritten.json()) as { item: { id: string; source: string } }
    ).item;

    expect(secondItem.id).toBe(firstItem.id);
    expect(secondItem.source).toBe(firstItem.source);
    // Derived from the Connection, so it cannot move when the credential
    // does.
    expect(firstItem.source).toBe(`integration:${connectionId}`);
  });
});

describe("a mint cannot outlive the uninstall it raced", () => {
  it("blocks on the Connection lifecycle lock and re-reads state under it", async () => {
    const tenant = await ctx.storage.tenants!.create("race");
    const connectionId = await makeConnection(tenant.id);

    let settled = false;
    let result: Response | null = null;

    // Hold the lock the uninstall pipeline takes for the whole of its
    // run, and revoke inside it exactly as step 7 of that pipeline does.
    // A mint that does not serialize against uninstall completes here,
    // against a Connection that is about to stop existing.
    await ctx.storage.coordination.withExclusiveLock(
      `connection-lifecycle:${connectionId}`,
      async () => {
        void mint(connectionId).then((r) => {
          settled = true;
          result = r;
          return r;
        });
        await new Promise((r) => setTimeout(r, 200));
        // Asserted before the revoke rather than after: what is being
        // pinned is that the mint is still waiting, not merely that it
        // ends up refused.
        expect(settled).toBe(false);
        await ctx.storage.items.transition(connectionId, "revoked", tenant.id);
      },
    );

    await new Promise((r) => setTimeout(r, 200));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(((await result!.json()) as ErrorResponse).error.code).toBe(
      "connection_not_active",
    );
  });
});

describe("a runtime credential speaks only for its own Connection", () => {
  async function credentialFor(
    tenantId: string,
    name: string,
  ): Promise<{ key: string; connectionId: string }> {
    const connectionId = await makeConnection(tenantId, name);
    const res = await mint(connectionId, name);
    expect(res.status).toBe(201);
    return {
      key: ((await res.json()) as MintResponse).api_key,
      connectionId,
    };
  }

  it("refuses to create activity attributed to a sibling", async () => {
    const tenant = await ctx.storage.tenants!.create("activity-create");
    const mine = await credentialFor(tenant.id, "acme.mine");
    const sibling = await credentialFor(tenant.id, "acme.sibling");

    const res = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: sibling.connectionId,
          severity: "action_required",
          summary: "re-authorize this integration",
        },
      },
    });
    expect(res.status).toBe(403);
  });

  it("refuses the same write through the bulk door", async () => {
    // Bulk runs the same type gate, so the carve-out that admits
    // `system.activity` admits it here too. Without the attribution
    // check the door is simply wider.
    const tenant = await ctx.storage.tenants!.create("activity-bulk");
    const mine = await credentialFor(tenant.id, "acme.bulk-mine");
    const sibling = await credentialFor(tenant.id, "acme.bulk-sibling");

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: mine.key,
      body: {
        items: [
          {
            type: "system.activity",
            properties: {
              connection_id: sibling.connectionId,
              severity: "error",
              summary: "sibling is broken",
            },
          },
        ],
      },
    });
    // Atomic mode is the default, so an unauthorized item aborts the
    // batch rather than reporting per-item.
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = await ctx.storage.items.list({
      type: "system.activity",
      tenantId: tenant.id,
    });
    expect(rows.data).toHaveLength(0);
  });

  it("refuses to edit a sibling's activity row", async () => {
    const tenant = await ctx.storage.tenants!.create("activity-patch");
    const mine = await credentialFor(tenant.id, "acme.patch-mine");
    const sibling = await credentialFor(tenant.id, "acme.patch-sibling");

    const created = await request(ctx.app, "POST", "/items", {
      key: sibling.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: sibling.connectionId,
          severity: "info",
          summary: "sync complete",
        },
      },
    });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { item: { id: string } }).item;

    // No `connection_id` in the body at all: the row is not this
    // credential's to touch, whatever the patch says.
    const res = await request(ctx.app, "PATCH", `/items/${row.id}`, {
      key: mine.key,
      body: { properties: { severity: "action_required" } },
    });
    expect(res.status).toBe(403);
  });

  it("refuses to claim a sibling's activity row by re-pointing it", async () => {
    // The one case the post-merge check alone cannot catch: the row
    // being edited belongs to a sibling, and the patch names this
    // credential's own connection. Judged on the merged result, that
    // reads as a credential writing its own activity; judged on the row
    // as it stands, it is one connector taking another's.
    const tenant = await ctx.storage.tenants!.create("activity-claim");
    const mine = await credentialFor(tenant.id, "acme.claim-mine");
    const sibling = await credentialFor(tenant.id, "acme.claim-sibling");

    const created = await request(ctx.app, "POST", "/items", {
      key: sibling.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: sibling.connectionId,
          severity: "info",
          summary: "sync complete",
        },
      },
    });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { item: { id: string } }).item;

    const res = await request(ctx.app, "PATCH", `/items/${row.id}`, {
      key: mine.key,
      body: {
        properties: {
          connection_id: mine.connectionId,
          summary: "actually mine",
        },
      },
    });
    expect(res.status).toBe(403);
  });

  it("refuses to re-attribute its own activity row to a sibling", async () => {
    const tenant = await ctx.storage.tenants!.create("activity-reattribute");
    const mine = await credentialFor(tenant.id, "acme.reattr-mine");
    const sibling = await credentialFor(tenant.id, "acme.reattr-sibling");

    const created = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: mine.connectionId,
          severity: "info",
          summary: "sync complete",
        },
      },
    });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { item: { id: string } }).item;

    const res = await request(ctx.app, "PATCH", `/items/${row.id}`, {
      key: mine.key,
      body: { properties: { connection_id: sibling.connectionId } },
    });
    expect(res.status).toBe(403);
  });

  it("still lets a credential write and update its own activity", async () => {
    // The gate has to admit the only thing a connector legitimately does
    // with this type, or the runtime SDK's activity sink stops working
    // on every run and the failure is invisible until nothing reports.
    const tenant = await ctx.storage.tenants!.create("activity-own");
    const mine = await credentialFor(tenant.id, "acme.own");

    const created = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "system.activity",
        properties: {
          connection_id: mine.connectionId,
          severity: "info",
          summary: "sync complete",
        },
      },
    });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { item: { id: string } }).item;

    // A partial patch that never mentions `connection_id` must not be
    // read as claiming an absent one.
    const patched = await request(ctx.app, "PATCH", `/items/${row.id}`, {
      key: mine.key,
      body: { properties: { summary: "sync complete (42 items)" } },
    });
    expect(patched.status).toBe(200);
  });
});
