import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import type { TestContext } from "../test-utils.js";

/**
 * Subtree resolution consults the type registry, and the registry is
 * tenant-scoped because custom types are. That makes tenant isolation a
 * property of the matcher itself rather than only of the query around it: a
 * resolver that reached the global set would let one space's declared
 * descendants widen another space's reads.
 *
 * Registering a type cannot make existing rows visible either — an item's type
 * is fixed when it is written, so expanding which *types* a pattern matches
 * never retypes a row. The second test pins that, because it is the property
 * that makes the widening safe rather than merely narrow.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

let counter = 0;
function childSchema(): { id: string; [k: string]: unknown } {
  counter += 1;
  return {
    id: `user.isolation_child_${String(counter)}`,
    name: "Isolation child",
    description: "Declares core.note as its parent from another namespace.",
    parent: "core.note",
    version: 1,
    fields: {
      body: { type: "string", required: true, description: "The body." },
    },
  };
}

async function newTenant(
  c: TestContext,
  label: string,
  permissions: Record<string, "read" | "write" | "none">,
  role: "tenant_admin" | "member" = "tenant_admin",
): Promise<{ tenantId: string; key: string }> {
  const tenants = c.storage.tenants;
  // Hosted mode always wires the tenant store; a keys-mode context would not,
  // and this suite is meaningless without two spaces to keep apart.
  if (!tenants) throw new Error("tenant store unavailable in this context");
  const tenant = await tenants.create(
    `${label}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const suffix = Math.random().toString(36).slice(2, 10);
  const raw = `marfa_k1_test_${suffix}`;
  await c.storage.keys.create(
    {
      label: `${label}-${suffix}`,
      source: `test-${suffix}`,
      role,
      type_permissions: permissions,
      metadata_permissions: { types: "write" },
      default_tier: "library",
      is_platform: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    tenant.id,
  );
  return { tenantId: tenant.id, key: raw };
}

describe("declared descendants stay inside their own space", () => {
  it("does not let one space's declared child widen another space's subtree read", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const alpha = await newTenant(ctx, "alpha", { "*": "write" });
    const beta = await newTenant(ctx, "beta", { "*": "write" });

    // Alpha registers a child of core.note named outside that namespace, and
    // writes one item of it.
    const schema = childSchema();
    const reg = await request(ctx.app, "POST", "/types", {
      key: alpha.key,
      body: schema,
    });
    expect(
      reg.status,
      `POST /types -> ${String(reg.status)}: ${await reg.clone().text()}`,
    ).toBe(201);
    const wrote = await request(ctx.app, "POST", "/items", {
      key: alpha.key,
      body: { type: schema.id, properties: { body: "alpha only" } },
    });
    expect(wrote.status).toBe(201);

    // Alpha sees it through the parent subtree, which is the whole point.
    const alphaSees = await request(ctx.app, "GET", "/items?type=core.note", {
      key: alpha.key,
    });
    expect(alphaSees.status).toBe(200);
    const alphaTypes = (
      (await alphaSees.json()) as { data: { type: string }[] }
    ).data.map((i) => i.type);
    expect(alphaTypes).toContain(schema.id);

    // Beta must not, and the reason matters: beta's registry never resolves
    // alpha's custom type, so the matcher cannot even name it.
    const betaSees = await request(ctx.app, "GET", "/items?type=core.note", {
      key: beta.key,
    });
    expect(betaSees.status).toBe(200);
    const betaRows = ((await betaSees.json()) as { data: { type: string }[] })
      .data;
    expect(betaRows.map((i) => i.type)).not.toContain(schema.id);
    expect(betaRows).toHaveLength(0);
  });

  it("registering a type does not make an existing row readable", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const alpha = await newTenant(ctx, "alpha", { "*": "write" });

    // A row written before any custom type exists.
    const note = await request(ctx.app, "POST", "/items", {
      key: alpha.key,
      body: { type: "core.bookmark", properties: { url: "https://a.test" } },
    });
    expect(note.status).toBe(201);

    // A credential that may read notes and nothing else.
    const suffix = Math.random().toString(36).slice(2, 10);
    const scoped = `marfa_k1_test_scoped_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `notes-only-${suffix}`,
        source: `test-scoped-${suffix}`,
        role: "member",
        type_permissions: { "core.note.*": "read" },
        metadata_permissions: { types: "write" },
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(scoped, TEST_API_KEY_SALT),
      alpha.tenantId,
    );

    // It registers a type under the subtree it holds. Widening which types a
    // pattern matches must not widen which rows exist under those types: the
    // bookmark was written as a bookmark and stays one.
    const reg = await request(ctx.app, "POST", "/types", {
      key: scoped,
      body: childSchema(),
    });
    expect(reg.status).toBe(201);

    const sees = await request(ctx.app, "GET", "/items", { key: scoped });
    expect(sees.status).toBe(200);
    const types = (
      (await sees.json()) as { data: { type: string }[] }
    ).data.map((i) => i.type);
    expect(types).not.toContain("core.bookmark");
  });
});

describe("a permission map is resolved by name, and the gate agrees", () => {
  it("keeps an explicit deny winning over a subtree grant", async () => {
    ctx = await createTestContext();
    const child = childSchema();
    const reg = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: child,
    });
    expect(
      reg.status,
      `POST /types -> ${String(reg.status)}: ${await reg.clone().text()}`,
    ).toBe(201);

    const note = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "granted" } },
    });
    expect(note.status).toBe(201);
    const denied = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: child.id, properties: { body: "denied" } },
    });
    expect(denied.status).toBe(201);
    const deniedId = ((await denied.json()) as { item: { id: string } }).item
      .id;

    // The map denies the `user` namespace outright and grants notes. The
    // registered type is named under `user` and declares `core.note` as its
    // parent, so it is reachable by one pattern and refused by the other.
    const suffix = Math.random().toString(36).slice(2, 10);
    const scoped = `marfa_k1_test_deny_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `deny-${suffix}`,
        source: `test-deny-${suffix}`,
        role: "member",
        type_permissions: { "user.*": "none", "core.note.*": "read" },
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(scoped, TEST_API_KEY_SALT),
    );

    // Expanding grants through declared parentage put these two in
    // disagreement: the listing returned the denied row while fetching it by id
    // returned 403. A list that shows what a fetch refuses is the fail-open
    // direction, so permission patterns resolve names only.
    const list = await request(ctx.app, "GET", "/items", { key: scoped });
    expect(list.status).toBe(200);
    const types = (
      (await list.json()) as { data: { type: string }[] }
    ).data.map((i) => i.type);
    expect(types).toContain("core.note");
    expect(types).not.toContain(child.id);

    const single = await request(ctx.app, "GET", `/items/${deniedId}`, {
      key: scoped,
    });
    expect(single.status).toBe(403);
  });
});
