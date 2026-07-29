import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Starter-content seeding on sign-up.
 *
 * The provisioning hook seeds a fresh tenant with three core items + one
 * typed edge when `MARFA_SEED_STARTER_CONTENT` is on, and leaves the space
 * empty when it's off (the default). Exercised through the real sign-up path
 * so the gating, the owner-connection write, and the edge all run as they do
 * in production.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

async function signUpAndGetTenant(
  c: TestContext,
  email: string,
): Promise<string> {
  const res = await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password: "correct horse battery", name: "Sam" },
    headers: { origin: ORIGIN },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user?: { id?: string } };
  const row = await c.storage.users?.getByAuthUserId(body.user?.id ?? "");
  expect(row?.tenant_id).toBeTruthy();
  return row?.tenant_id ?? "";
}

describe("starter content seeding on sign-up", () => {
  it("seeds three typed items + a references edge when enabled", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
      seedStarterContent: true,
    });
    const tenantId = await signUpAndGetTenant(ctx, "sam@example.com");

    // Every space is provisioned with the account holder's `system.*` graph
    // handle regardless of this setting, so the reads here narrow to the
    // user-facing content the seeder owns.
    const items = await ctx.storage.items.list({
      tenantId,
      exclude_system_types: true,
    });
    expect(items.data.length).toBe(3);
    const types = items.data.map((i) => i.type).sort();
    expect(types).toEqual(["core.bookmark", "core.note", "core.task"]);

    // The welcome note references the docs bookmark — the space reads as a
    // graph, not a flat list.
    const note = items.data.find((i) => i.type === "core.note");
    const bookmark = items.data.find((i) => i.type === "core.bookmark");
    expect(note && bookmark).toBeTruthy();
    const edges = await ctx.storage.edges.listFromSource(note?.id ?? "");
    const ref = edges.data.find((e) => e.edge_type === "references");
    expect(ref?.target_id).toBe(bookmark?.id);

    // Tags persist through the create path.
    const tagged = await ctx.storage.items.list({
      tenantId,
      tags: ["welcome"],
    });
    expect(tagged.data.length).toBe(1);
    expect(tagged.data[0]?.type).toBe("core.note");
  });

  it("leaves the tenant empty when disabled (the default)", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
      // seedStarterContent omitted — defaults to false.
    });
    const tenantId = await signUpAndGetTenant(ctx, "lee@example.com");

    const items = await ctx.storage.items.list({
      tenantId,
      exclude_system_types: true,
    });
    expect(items.data.length).toBe(0);
  });
});
