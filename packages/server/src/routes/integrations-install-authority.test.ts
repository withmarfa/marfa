/**
 * Installing an integration needs `space.connections` on the bearer path.
 *
 * An install commits a space to running the integration's code, and every
 * credential the Connection is later minted takes its permission maps from
 * that manifest rather than from the caller's own key
 * (`connections/manifest-permissions.ts`). The install is where a caller
 * chooses the manifest, so it is where authority the caller may not itself
 * hold gets committed to, which is the axis `auth/mint-ceiling.ts` states:
 * no minting path may issue a credential whose authority exceeds the
 * principal that authorized it. Installing mints nothing itself; it decides
 * what every later mint may reach, which is the same authority one step
 * earlier.
 *
 * Every sibling operation agrees — `POST /connections/install`,
 * `POST /connections/:id/configure` and `POST /connections/:id/uninstall`
 * are all `requireAuth`, and the configure route's own comment says
 * it matches the install routes. The HTML install pair was the one that
 * never got the gate, so a space-bound key holding nothing but
 * `system.integration: read` could provision an integration into its own
 * space and then be unable to configure or remove the thing it had just
 * created.
 *
 * The browser-session half of the route is deliberately untouched: there
 * the principal is the signed-in account holder approving a connection for
 * their own space, the same principal `/auth/authorize` serves.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { SpacePermission } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
});

afterAll(async () => {
  await ctx.cleanup();
});

interface RegisterResponse {
  id: string;
}

function manifest(name: string) {
  return {
    name,
    version: "1.0.0",
    publisher: "acme",
    description: "Fixture manifest for the install authority gate.",
    direction: "read" as const,
    triggers: [{ type: "schedule" as const, config: { cron: "*/15 * * * *" } }],
    // Deliberately wider than the installing key's own permissions: a
    // credential minted for this Connection could write types the member
    // cannot.
    target_types: ["core.note", "core.task"],
    manifest_schema_version: "2.0.0",
    permissions: { extension: { "acme.cursor": "write" as const } },
  };
}

async function registerIntegration(name: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/integrations", {
    key: ctx.adminKey,
    body: { manifest: manifest(name) },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as RegisterResponse).id;
}

async function mintKey(
  spaceId: string,
  name: string,
  spacePermissions: SpacePermission[],
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const res = await request(ctx.app, "POST", `/admin/spaces/${spaceId}/keys`, {
    key: ctx.adminKey,
    body: {
      label: `install-authority-${name}-${suffix}`,
      source: `install-authority-${name}-${suffix}`,
      space_permissions: spacePermissions,
      default_tier: "library",
      type_permissions: { "system.integration": "read" },
      extension_permissions: {},
      edge_permissions: {},
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

function installRequest(integrationId: string, key: string): Request {
  return new Request(`http://localhost/integrations/${integrationId}/install`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      decision: "approve",
    }).toString(),
  });
}

describe("the bearer install path refuses a key without `space.connections`", () => {
  it("refuses a key holding no space permissions installing an integration", async () => {
    if (!ctx.storage.spaces) return;
    const id = await registerIntegration("acme/install-authority-refused");
    const space = await ctx.storage.spaces.create("install-authority-refused");
    const memberKey = await mintKey(space.id, "narrow", []);

    const res = await ctx.app.fetch(installRequest(id, memberKey));
    expect(res.status).toBe(403);

    // Nothing was provisioned: a refused install must not half-apply.
    const connections = await ctx.storage.items.list({
      type: "system.connection",
      spaceId: space.id,
    });
    expect(connections.data).toHaveLength(0);
  });

  it("still admits a caller holding it, whose job installing is", async () => {
    if (!ctx.storage.spaces) return;
    const id = await registerIntegration("acme/install-authority-allowed");
    const space = await ctx.storage.spaces.create("install-authority-allowed");
    const adminKey = await mintKey(space.id, "granted", ["space.connections"]);

    const res = await ctx.app.fetch(installRequest(id, adminKey));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Connection installed");

    const connections = await ctx.storage.items.list({
      type: "system.connection",
      spaceId: space.id,
    });
    expect(connections.data).toHaveLength(1);
  });
});
