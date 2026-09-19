/**
 * Regression suite for authority checks that were hand-rolled instead of
 * going through the shared auth helpers.
 *
 * Every route that spelled a gate itself rather than asking the shared
 * predicate drifted from it, readmitting exactly the credential the gate
 * exists to exclude on surfaces whose lookups are unfenced.
 *
 * Each site is covered twice: the credential that must be refused, and a
 * control proving the legitimate caller still gets through.
 */

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
// Unit — the predicates the routes now share
// ---------------------------------------------------------------------------

describe("isReservedCredentialSource", () => {
  it("claims the two reserved prefixes", () => {
    expect(isReservedCredentialSource("oauth:conn-1")).toBe(true);
    expect(isReservedCredentialSource("connector:conn-1")).toBe(true);
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

let mintCounter = 0;

async function mintKey(opts: {
  permissions?: Permission[];
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
      permissions: opts.permissions ?? [],
      default_tier: "library",
      type_permissions: opts.type_permissions ?? {},
      extension_permissions: opts.extension_permissions,
      is_operator: opts.is_operator ?? false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return raw;
}

/** A `system.connection` of kind connector, seeded through storage so
 *  the test doesn't depend on the install pipeline. */
async function seedConnection(): Promise<string> {
  const conn = await ctx.storage.items.create({
    type: "system.connection",
    properties: {
      kind: "connector",
      status: "active",
      granted_at: new Date().toISOString(),
      connector_id: "acme.demo",
    },
  });
  return conn.id;
}

// ---------------------------------------------------------------------------
// /keys — list / revoke / update
// ---------------------------------------------------------------------------

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

  it("refuses the connector prefix itself, and the one it replaced", async () => {
    // The `oauth:` case above is the only door-level cover this family had,
    // so removing `connector:` from the reserved list reddened one assertion
    // in the whole suite and no door test at all. Both prefixes belong here:
    // `connector:` because a minted credential must not be able to claim a
    // connector's provenance, and `integration:` because it is the spelling
    // `connector:` replaced — a prefix that once meant connector provenance
    // must not become claimable by falling out of the list.
    const caller = await mintKey({ permissions: ["keys.mint"] });

    for (const source of ["connector:acme/thing", "integration:acme/thing"]) {
      const res = await request(ctx.app, "POST", "/keys", {
        key: caller,
        body: { label: `forged-${source}`, source },
      });
      expect(res.status, `${source} was accepted`).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_error");
    }
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
      // Granted the namespace outright, so the refusal below can only be the
      // reserved-namespace gate rather than a missing map entry.
      extension_permissions: { "*": "write" },
    });
    const item = await ctx.storage.items.create({
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

  it("refuses an operator key on a reserved namespace too", async () => {
    const item = await ctx.storage.items.create({
      type: "core.note",
      properties: { body: "reserved-control" },
    });
    // The gate used to admit the operator tier and then ask the namespace
    // map. The operator key holds no map at all, and the namespace is closed
    // to every credential anyway: the platform writes it through the storage
    // layer as it writes a `system.*` row.
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
