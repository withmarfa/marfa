/**
 * A connection's owner can pause and resume it.
 *
 * They could not. Pause was built as a direct `items.transition`, so it hit
 * the reserved-namespace rule and returned `403 type_not_permitted` naming
 * a namespace the user never asked to write. The rule is right — space
 * credentials must not write `system.*` directly — and the mistake was
 * building pause as a direct write when uninstall already did the same
 * class of write through a mediated route and worked.
 *
 * So the shipped feature let an owner install a connection and destroy it,
 * but not temporarily stop it. The only route from running to not-running
 * was the irreversible one that drops the OAuth grant.
 *
 * It was broken twice over: the `system.connection` lifecycle is bounded to
 * `active | revoked`, so the `archived` state the old code transitioned to
 * does not exist for the type. Pause lives on `runtime_status`, which has a
 * `paused` member for the purpose.
 *
 * These tests prove it by permission, with a real non-platform space key,
 * rather than by mocking the gate — the gate is the thing under test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildEntryForConnection } from "../connections/envelope.js";
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
    description: "pause test",
    direction: "read",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    runtime_compatibility: ["local"],
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

/** A space-admin key with no platform flag: the shape a space owner holds. */
async function ownerKey(spaceId: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const res = await request(ctx.app, "POST", `/admin/spaces/${spaceId}/keys`, {
    key: ctx.adminKey,
    body: {
      label: `owner-${suffix}`,
      source: `owner-${suffix}`,
      role: "space_admin",
      default_tier: "library",
      type_permissions: { "*": "write" },
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { key: string; is_platform?: boolean };
  // The premise of the test: this key must NOT be a platform credential,
  // or it would bypass the very gate that made pause unusable.
  expect(body.is_platform ?? false).toBe(false);
  return body.key;
}

/** An installed, active integration connection in the given space. */
async function connectionIn(spaceId: string): Promise<string> {
  const name = `acme.pause-${Math.random().toString(36).slice(2, 10)}`;
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: name,
        manifest_version: "1.0.0",
        publisher: "Acme",
        manifest: manifest(name),
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
        runtime_status: "healthy",
        granted_at: new Date().toISOString(),
        integration_ref: integration.id,
      },
    },
    spaceId,
  );
  return connection.id;
}

describe("pause and resume are reachable by the connection's owner", () => {
  let spaceId: string;
  let key: string;

  beforeAll(async () => {
    const space = await ctx.storage.spaces!.create("pause-owner");
    spaceId = space.id;
    key = await ownerKey(spaceId);
  });

  it("REGRESSION: an ordinary space key pauses, then resumes, its own connection", async () => {
    const id = await connectionIn(spaceId);

    const paused = await request(ctx.app, "POST", `/connections/${id}/pause`, {
      key,
    });
    expect(paused.status).toBe(200);
    expect(
      ((await paused.json()) as { runtime_status: string }).runtime_status,
    ).toBe("paused");

    const afterPause = await ctx.storage.items.get(id, spaceId);
    expect(afterPause?.properties.runtime_status).toBe("paused");
    // The lifecycle is untouched: pause is not a soft uninstall, and the
    // credentials and grant survive so resume needs no re-consent.
    expect(afterPause?.state).toBe("active");

    const resumed = await request(
      ctx.app,
      "POST",
      `/connections/${id}/resume`,
      {
        key,
      },
    );
    expect(resumed.status).toBe(200);
    const afterResume = await ctx.storage.items.get(id, spaceId);
    expect(afterResume?.properties.runtime_status).toBe("healthy");
  });

  it("still refuses the same key a direct system.* write", async () => {
    // The reserved-namespace rule is correct and must survive the fix. If
    // this starts passing, pause was made to work by widening the gate
    // rather than by mediating the write.
    const res = await request(ctx.app, "POST", "/items", {
      key,
      body: {
        type: "system.connection",
        properties: { kind: "integration", status: "active" },
      },
    });
    expect(res.status).toBe(403);
  });

  it("refuses to pause a connection in another space", async () => {
    const other = await ctx.storage.spaces!.create("pause-other");
    const theirs = await connectionIn(other.id);
    const res = await request(ctx.app, "POST", `/connections/${theirs}/pause`, {
      key,
    });
    // Not found rather than forbidden: a cross-space probe must not
    // confirm the id exists.
    expect(res.status).toBe(404);
  });

  it("refuses to pause twice, and to resume something running", async () => {
    const id = await connectionIn(spaceId);
    expect(
      (await request(ctx.app, "POST", `/connections/${id}/pause`, { key }))
        .status,
    ).toBe(200);
    expect(
      (await request(ctx.app, "POST", `/connections/${id}/pause`, { key }))
        .status,
    ).toBe(400);
    expect(
      (await request(ctx.app, "POST", `/connections/${id}/resume`, { key }))
        .status,
    ).toBe(200);
    expect(
      (await request(ctx.app, "POST", `/connections/${id}/resume`, { key }))
        .status,
    ).toBe(400);
  });

  it("refuses to resume a connection that is not paused", async () => {
    // Resume undoes a pause and nothing else. Before the guard it was a
    // general clear-my-status button: a reauth_required connection came
    // back reading healthy on credentials the proxy had given up on.
    const id = await connectionIn(spaceId);
    const row = await ctx.storage.items.get(id, spaceId);
    await ctx.storage.items.update(
      id,
      { properties: { ...row!.properties, runtime_status: "reauth_required" } },
      spaceId,
    );

    const res = await request(ctx.app, "POST", `/connections/${id}/resume`, {
      key,
    });
    expect(res.status).toBe(400);

    const after = await ctx.storage.items.get(id, spaceId);
    expect(after?.properties.runtime_status).toBe("reauth_required");
  });

  it("refuses to pause a revoked connection", async () => {
    const id = await connectionIn(spaceId);
    await ctx.storage.items.transition(id, "revoked", spaceId);
    const res = await request(ctx.app, "POST", `/connections/${id}/pause`, {
      key,
    });
    expect(res.status).toBe(400);
  });

  it("records the pause as activity the owner can see", async () => {
    const id = await connectionIn(spaceId);
    const res = await request(ctx.app, "POST", `/connections/${id}/pause`, {
      key,
    });
    const body = (await res.json()) as { activity_id: string };
    const activity = await ctx.storage.items.get(body.activity_id, spaceId);
    expect(activity?.type).toBe("system.activity");
    expect(activity?.properties.connection_id).toBe(id);
    expect(String(activity?.properties.summary)).toMatch(/^Paused connection /);
  });
});

describe("pause actually stops dispatch", () => {
  // The defect this pins: pause flipped `runtime_status` and stopped
  // nothing — the reactive registry only gated `failing`, and the
  // schedule walker never read the field at all, so the operator's stop
  // control reported success and the connection kept running. This
  // suite covers the pure gate and the route's write; the live bridge's
  // CACHED map is covered by reactive-bridge.invalidation.test.ts.
  let spaceId: string;
  let key: string;

  beforeAll(async () => {
    const space = await ctx.storage.spaces!.create("pause-dispatch");
    spaceId = space.id;
    key = await ownerKey(spaceId);
  });

  /** A connection whose manifest declares an item-event trigger, so it
   *  qualifies for the reactive subscription registry. */
  async function reactiveConnection(): Promise<string> {
    const name = `acme.pausefx-${Math.random().toString(36).slice(2, 10)}`;
    const m = {
      ...manifest(name),
      triggers: [{ type: "item-event" as const }],
    };
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: name,
          manifest_version: "1.0.0",
          publisher: "Acme",
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
          runtime_status: "healthy",
          granted_at: new Date().toISOString(),
          integration_ref: integration.id,
        },
      },
      spaceId,
    );
    return connection.id;
  }

  it("the registry gate refuses a paused connection, and admits it after resume", async () => {
    const id = await reactiveConnection();

    const before = await ctx.storage.items.get(id, spaceId);
    expect(await buildEntryForConnection(ctx.storage, before!)).not.toBeNull();

    const paused = await request(ctx.app, "POST", `/connections/${id}/pause`, {
      key,
    });
    expect(paused.status).toBe(200);
    const whilePaused = await ctx.storage.items.get(id, spaceId);
    expect(await buildEntryForConnection(ctx.storage, whilePaused!)).toBeNull();

    const resumed = await request(
      ctx.app,
      "POST",
      `/connections/${id}/resume`,
      { key },
    );
    expect(resumed.status).toBe(200);
    const afterResume = await ctx.storage.items.get(id, spaceId);
    expect(
      await buildEntryForConnection(ctx.storage, afterResume!),
    ).not.toBeNull();
  });
});
