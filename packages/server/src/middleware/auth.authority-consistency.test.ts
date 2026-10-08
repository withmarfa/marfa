/**
 * Authority checks that go through the shared auth helpers.
 *
 * A route that spells a gate itself rather than asking the shared predicate
 * drifts from it, and readmits exactly the credential the gate exists to
 * exclude on surfaces whose lookups are unfenced.
 *
 * Each site is covered twice: the credential that must be refused, and a
 * control proving the legitimate caller still gets through.
 */

import { itemWrites } from "../storage/item-writes.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Permission } from "@withmarfa/shared";
import { hashApiKey, isReservedCredentialSource } from "./auth.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";

// ---------------------------------------------------------------------------
// Unit — the predicates the routes share
// ---------------------------------------------------------------------------

describe("isReservedCredentialSource", () => {
  it("claims the reserved prefix", () => {
    expect(isReservedCredentialSource("oauth:conn-1")).toBe(true);
  });

  it("is case- and whitespace-insensitive, so the prefix cannot be smuggled", () => {
    expect(isReservedCredentialSource("  OAuth:conn-1")).toBe(true);
  });

  it("leaves ordinary sources alone", () => {
    expect(isReservedCredentialSource("my-laptop")).toBe(false);
    expect(isReservedCredentialSource("cli")).toBe(false);
    expect(isReservedCredentialSource("connector:conn-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Through the routes
// ---------------------------------------------------------------------------

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({});
});

afterAll(async () => {
  await ctx.cleanup();
});

let mintCounter = 0;

async function mintKey(opts: {
  permissions?: Permission[];

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
      permissions: opts.permissions ?? [],
      default_tier: "library",
      type_permissions: opts.type_permissions ?? {},
      extension_permissions: opts.extension_permissions,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return raw;
}

/** A `system.connection`, seeded through storage so the test doesn't
 *  depend on the consent pipeline. */
async function seedConnection(): Promise<string> {
  const conn = await itemWrites(ctx.storage).create({
    type: "system.connection",
    properties: {
      kind: "app",
      status: "active",
      granted_at: new Date().toISOString(),
      client_id: "acme.demo",
    },
  });
  return conn.id;
}

// ---------------------------------------------------------------------------
// POST /keys — the reserved source prefixes
// ---------------------------------------------------------------------------

describe("POST /keys — connector source prefixes are not mintable", () => {
  it("refuses a source claiming a connection's connector identity", async () => {
    const connectionId = await seedConnection();
    const caller = await mintKey({
      permissions: ["keys.mint"],
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: caller,
      body: {
        label: "forged-connector",
        // Read by three connection routes as proof of connector identity.
        source: `oauth:${connectionId}`,
      },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("still accepts an ordinary source", async () => {
    const caller = await mintKey({
      permissions: ["keys.mint"],
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: caller,
      body: { label: "ordinary", source: "my-laptop" },
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Extensions — the reserved namespaces are closed to every credential
// ---------------------------------------------------------------------------

describe("extensions — the reserved namespaces are nobody's", () => {
  it("refuses a working credential writing a reserved namespace", async () => {
    const boundCaller = await mintKey({
      // Granted the item's type and the namespace outright, so the refusal
      // below can only be the reserved-namespace gate.
      type_permissions: { "core.note": "write" },
      extension_permissions: { "*": "write" },
    });
    const item = await itemWrites(ctx.storage).create({
      type: "core.note",
      properties: { body: "reserved-host" },
    });

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

  it("refuses a management key on a reserved namespace too", async () => {
    const item = await itemWrites(ctx.storage).create({
      type: "core.note",
      properties: { body: "reserved-control" },
    });
    // The management key's type map reaches no type, so the item's type gate
    // refuses it before the namespace is asked; either way nothing lands.
    const res = await request(
      ctx.app,
      "PUT",
      `/items/${item.id}/extensions/system`,
      { key: ctx.managementKey, body: { ok: true } },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "type_not_permitted",
    );
    expect(await ctx.storage.metadata.getExtensions(item.id)).toEqual({});
  });
});
