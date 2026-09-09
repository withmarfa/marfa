/**
 * Regression suite for authority checks that were hand-rolled instead of
 * going through the shared auth helpers.
 *
 * The operator gate is the absence of a space binding as much as it is the
 * flag, because `POST /admin/spaces/{id}/keys` legitimately mints a
 * space-bound credential whose reach is deliberately one space. Every route
 * that spelled the gate as a bare flag test kept the old meaning and
 * disagreed with `checkOperatorKey` — readmitting exactly the credential the
 * gate exists to exclude, on surfaces whose lookups are unfenced.
 *
 * The space fence runs alongside it and is the other half: a credential
 * holding a space permission holds it *in its own space*, so every lookup
 * behind such a door has to be threaded with the caller's space or the
 * permission reaches every space at once.
 *
 * Each site is covered twice: the credential that must be refused, and a
 * control proving the legitimate caller still gets through.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ApiKey, SpacePermission } from "@withmarfa/shared";
import {
  hashApiKey,
  hasOperatorAuthority,
  isReservedCredentialSource,
} from "./auth.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import type { Storage } from "../storage/interface.js";

// ---------------------------------------------------------------------------
// Unit — the predicates the routes now share
// ---------------------------------------------------------------------------

function fakeKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key-test",
    label: "test",
    source: "test",
    is_operator: false,
    default_tier: "library",
    type_permissions: {},
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: new Date().toISOString(),
    last_used_at: null,
    ...overrides,
  };
}

describe("hasOperatorAuthority", () => {
  it("admits an unbound operator key", () => {
    expect(hasOperatorAuthority(fakeKey({ is_operator: true }))).toBe(true);
  });

  it("refuses a space-bound one — the shape the escalation fix named", () => {
    expect(
      hasOperatorAuthority(fakeKey({ is_operator: true, space_id: "t-a" })),
    ).toBe(false);
  });

  it("refuses a credential carrying no operator flag", () => {
    expect(hasOperatorAuthority(fakeKey())).toBe(false);
    expect(hasOperatorAuthority(fakeKey({ space_id: "t-a" }))).toBe(false);
  });
});

describe("isReservedCredentialSource", () => {
  it("claims the three integration prefixes", () => {
    expect(isReservedCredentialSource("oauth:conn-1")).toBe(true);
    expect(isReservedCredentialSource("integration:conn-1")).toBe(true);
    expect(isReservedCredentialSource("runtime-abc-123")).toBe(true);
  });

  it("is case- and whitespace-insensitive, so the prefix cannot be smuggled", () => {
    expect(isReservedCredentialSource("  OAuth:conn-1")).toBe(true);
  });

  it("leaves ordinary sources alone", () => {
    expect(isReservedCredentialSource("my-laptop")).toBe(false);
    expect(isReservedCredentialSource("cli")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({});
});

afterAll(async () => {
  await ctx.cleanup();
});

function spaceStore(): NonNullable<Storage["spaces"]> {
  const spaces = ctx.storage.spaces;
  if (!spaces) throw new Error("test context has no space store");
  return spaces;
}

let mintCounter = 0;

async function mintKey(opts: {
  spacePermissions?: SpacePermission[];
  spaceId?: string;
  is_operator?: boolean;
  label?: string;
  source?: string;
  type_permissions?: Record<string, "read" | "write" | "none">;
  extension_permissions?: Record<string, "read" | "write">;
}): Promise<string> {
  mintCounter += 1;
  const suffix = `${String(mintCounter)}${Math.random().toString(36).slice(2, 10)}`;
  const raw = `marfa_k1_authority_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: opts.label ?? `authority-${suffix}`,
      source: opts.source ?? `authority-${suffix}`,
      space_permissions: opts.spacePermissions ?? [],
      default_tier: "library",
      type_permissions: opts.type_permissions ?? {},
      extension_permissions: opts.extension_permissions,
      is_operator: opts.is_operator ?? false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    opts.spaceId,
  );
  return raw;
}

/** A `system.connection` of kind integration, seeded through storage so
 *  the test doesn't depend on the install pipeline. */
async function seedConnection(spaceId: string): Promise<string> {
  const conn = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: "acme.demo",
      },
    },
    spaceId,
  );
  return conn.id;
}

// ---------------------------------------------------------------------------
// POST /connections/:id/oauth/start
// ---------------------------------------------------------------------------

describe("POST /connections/:id/oauth/start — space fence on the connection lookup", () => {
  it("refuses a space-bound credential reaching a connection in another space", async () => {
    const spaceA = await spaceStore().create("authority-oauth-start-A");
    const spaceB = await spaceStore().create("authority-oauth-start-B");
    const victimConnection = await seedConnection(spaceB.id);

    // Holds the permission this door names, in a different space. The
    // permission is what gets it through the gate; the fence is what has to
    // stop it reaching past its own space, and the old gate tested rank and
    // passed no space, so this reached space B's connection.
    const boundCaller = await mintKey({
      spacePermissions: ["space.credentials"],
      spaceId: spaceA.id,
    });

    // Guard the fixture: a mistyped id would make the 404 below pass for
    // the wrong reason, hiding a live cross-space read.
    expect(victimConnection).toMatch(/\w/);
    expect(await ctx.storage.items.get(victimConnection, spaceB.id)).not.toBe(
      null,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${victimConnection}/oauth/start`,
      {
        key: boundCaller,
        body: { redirect_uri: "http://localhost:0/callback" },
      },
    );

    // 404, not 403 — a cross-space probe must not confirm the id exists.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("item_not_found");
  });

  it("admits the same credential on its own space's connection", async () => {
    const space = await spaceStore().create("authority-oauth-start-own");
    const connectionId = await seedConnection(space.id);
    const caller = await mintKey({
      spacePermissions: ["space.credentials"],
      spaceId: space.id,
    });

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/oauth/start`,
      {
        key: caller,
        body: { redirect_uri: "http://localhost:0/callback" },
      },
    );

    // Reaches the credential resolution and fails there (this connection
    // has no credential_ref) rather than being refused at the gate. The
    // point is that it is no longer a 403: the permission is held, and it is
    // held in this space.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });

  it("refuses a credential that does not hold space.credentials", async () => {
    const space = await spaceStore().create("authority-oauth-start-none");
    const connectionId = await seedConnection(space.id);
    const caller = await mintKey({ spaceId: space.id });

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/oauth/start`,
      {
        key: caller,
        body: { redirect_uri: "http://localhost:0/callback" },
      },
    );

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// /keys — list / revoke / update
// ---------------------------------------------------------------------------

describe("/keys — the space fence keys on the binding, not on the permission", () => {
  it("hides other spaces' keys from a space-bound holder of space.keys", async () => {
    const spaceA = await spaceStore().create("authority-keys-A");
    const spaceB = await spaceStore().create("authority-keys-B");
    await mintKey({
      spaceId: spaceB.id,
      label: "space-b-secret-key",
    });
    const boundCaller = await mintKey({
      spacePermissions: ["space.keys"],
      spaceId: spaceA.id,
    });

    const res = await request(ctx.app, "GET", "/keys", { key: boundCaller });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: { space_id?: string | null; label: string }[];
    };
    // Holding the permission is not holding it everywhere.
    expect(body.keys.every((k) => k.space_id === spaceA.id)).toBe(true);
    expect(body.keys.some((k) => k.label === "space-b-secret-key")).toBe(false);
  });

  it("404s a space-bound holder revoking another space's key", async () => {
    const spaceA = await spaceStore().create("authority-keys-revoke-A");
    const spaceB = await spaceStore().create("authority-keys-revoke-B");
    await mintKey({
      spaceId: spaceB.id,
      label: "victim-revoke",
    });
    const victim = (await ctx.storage.keys.list()).find(
      (k) => k.label === "victim-revoke",
    );
    if (!victim) throw new Error("seed key not found");
    const boundCaller = await mintKey({
      spacePermissions: ["space.keys"],
      spaceId: spaceA.id,
    });

    const res = await request(ctx.app, "DELETE", `/keys/${victim.id}`, {
      key: boundCaller,
    });
    expect(res.status).toBe(404);

    // `keys.get` filters revoked rows, so a surviving row is the proof the
    // refused DELETE did not land.
    const after = await ctx.storage.keys.get(victim.id);
    expect(after).not.toBeNull();
  });

  it("404s a space-bound holder rewriting another space's key permissions", async () => {
    const spaceA = await spaceStore().create("authority-keys-update-A");
    const spaceB = await spaceStore().create("authority-keys-update-B");
    await mintKey({
      spaceId: spaceB.id,
      label: "victim-update",
    });
    const victim = (await ctx.storage.keys.list()).find(
      (k) => k.label === "victim-update",
    );
    if (!victim) throw new Error("seed key not found");
    const boundCaller = await mintKey({
      spacePermissions: ["space.keys"],
      spaceId: spaceA.id,
    });

    const res = await request(ctx.app, "PATCH", `/keys/${victim.id}`, {
      key: boundCaller,
      body: { type_permissions: { "*": "write" } },
    });
    expect(res.status).toBe(404);

    const after = await ctx.storage.keys.get(victim.id);
    expect(after?.type_permissions).toEqual({});
  });

  it("still lets an unbound operator key see and address every space", async () => {
    const space = await spaceStore().create("authority-keys-control");
    await mintKey({
      spaceId: space.id,
      label: "control-visible",
    });

    const res = await request(ctx.app, "GET", "/keys", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: { label: string }[] };
    expect(body.keys.some((k) => k.label === "control-visible")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /keys — the reserved source prefixes
// ---------------------------------------------------------------------------

describe("POST /keys — integration source prefixes are not mintable", () => {
  it("refuses a source claiming a connection's integration identity", async () => {
    const space = await spaceStore().create("authority-source-reserve");
    const connectionId = await seedConnection(space.id);
    const caller = await mintKey({
      spacePermissions: ["space.keys"],
      spaceId: space.id,
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: caller,
      body: {
        label: "forged-integration",
        // Read by three connection routes as proof of integration identity.
        source: `oauth:${connectionId}`,
      },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("still accepts an ordinary source", async () => {
    const space = await spaceStore().create("authority-source-ok");
    const caller = await mintKey({
      spacePermissions: ["space.keys"],
      spaceId: space.id,
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: caller,
      body: { label: "ordinary", source: "my-laptop" },
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Extensions — the reserved-namespace gate reads the operator flag
// ---------------------------------------------------------------------------

describe("extensions — the reserved namespaces are nobody's", () => {
  it("refuses a space-bound credential writing a reserved namespace", async () => {
    const space = await spaceStore().create("authority-ext-reserved");
    const boundCaller = await mintKey({
      spaceId: space.id,
      // Granted the namespace outright, so the refusal below can only be the
      // reserved-namespace gate rather than a missing map entry.
      extension_permissions: { "*": "write" },
    });
    const item = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "reserved-host" } },
      space.id,
    );

    const res = await request(
      ctx.app,
      "PUT",
      `/items/${item.id}/extensions/system`,
      { key: boundCaller, body: { injected: true } },
    );
    // Reserved namespaces are the metadata-layer twin of the reserved type
    // namespaces: closed whatever the credential holds, and asserted on the
    // message so a refusal that happened to arrive from the permission map
    // instead could not stand in for this one.
    expect(res.status).toBe(403);
    expect(
      ((await res.json()) as { error: { message: string } }).error.message,
    ).toContain('Namespace "system" is reserved');
  });

  it("refuses an operator key on a reserved namespace too", async () => {
    const item = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "reserved-control" } },
      undefined,
    );
    // The gate used to admit the operator tier and then ask the namespace
    // map, which needed a credential holding both. There is none: the row
    // constraint makes `is_operator` and space-less the same thing, and a
    // space-less credential can hold no permissions at all, so the mint that
    // used to build this control is itself refused now. The namespace is
    // closed to every credential, and the platform writes it through the
    // storage layer as it writes a `system.*` row.
    const suffix = Math.random().toString(36).slice(2, 10);
    const minted = await request(ctx.app, "POST", "/keys", {
      key: ctx.operatorKey,
      body: {
        label: `reserved-ext-${suffix}`,
        source: `reserved-ext-${suffix}`,
        extension_permissions: { "*": "write" },
      },
    });
    expect(minted.status).toBe(403);

    const res = await request(
      ctx.app,
      "PUT",
      `/items/${item.id}/extensions/system`,
      { key: ctx.operatorKey, body: { ok: true } },
    );
    expect(res.status).toBe(403);
    // The namespace refusal rather than the permission map's, which would
    // also be a 403 and would leave this green if the fence came back.
    expect(
      ((await res.json()) as { error: { message: string } }).error.message,
    ).toContain('Namespace "system" is reserved');
  });
});
