/**
 * Operator-initiated account deletion: the same cascade the grace-window
 * purger runs, minus the grace window, behind a confirm-the-email gate.
 *
 * What the tests pin: the fat-finger gate refuses anything but the exact
 * email; a completed delete leaves nothing of the account behind (the
 * lifecycle row, the space, the space's items); the operator's action is
 * recorded as its own audit event alongside the cascade's in-transaction
 * `auth.account.hard_deleted`; and a deployment with no user accounts
 * refuses with a stated reason rather than a crash.
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

const ORIGIN = "http://localhost:0";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

async function seedAccount(
  c: TestContext,
  email: string,
): Promise<{ authUserId: string; spaceId: string }> {
  const res = await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password: "correct horse", name: email.split("@")[0] },
    headers: { origin: ORIGIN },
  });
  expect(res.status).toBe(200);
  await markEmailVerified(c.storage, email);
  const lifecycle = c.storage.accountLifecycle;
  if (!lifecycle) throw new Error("account lifecycle expected in hosted mode");
  const row = await lifecycle.getAccountLifecycleByEmail(email);
  if (!row) throw new Error("provisioned account not found");
  const user = await c.storage.users?.getByAuthUserId(row.auth_user_id);
  if (!user) throw new Error("provisioned users row not found");
  return { authUserId: row.auth_user_id, spaceId: user.space_id };
}

describe("POST /admin/accounts/:id/delete", () => {
  it("requires a platform admin", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const res = await request(ctx.app, "POST", "/admin/accounts/x/delete", {
      body: { confirm: "a@test.marfa.so" },
    });
    expect(res.status).toBe(401);
  });

  it("refuses when confirm is not the account's email, exactly", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { authUserId } = await seedAccount(ctx, "delete-me@example.com");

    for (const confirm of ["wrong@example.com", "Delete-Me@example.com ", ""]) {
      const res = await request(
        ctx.app,
        "POST",
        `/admin/accounts/${authUserId}/delete`,
        { key: ctx.adminKey, body: { confirm } },
      );
      expect(res.status, `confirm=${JSON.stringify(confirm)}`).toBe(400);
    }
    // And a right email against the wrong id refuses too — both halves
    // must name the same account.
    const other = await seedAccount(ctx, "someone-else@example.com");
    const crossed = await request(
      ctx.app,
      "POST",
      `/admin/accounts/${other.authUserId}/delete`,
      { key: ctx.adminKey, body: { confirm: "delete-me@example.com" } },
    );
    expect(crossed.status).toBe(400);
    // Nothing was deleted by any of the refusals.
    expect(
      await ctx.storage.accountLifecycle?.getAccountLifecycle(authUserId),
    ).not.toBeNull();
  });

  it("deletes the account and everything it owns, and records who did it", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { authUserId, spaceId } = await seedAccount(
      ctx,
      "operator-target@example.com",
    );

    // Give the space content, so "everything it owns" is a real claim.
    const spaceKeyRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${spaceId}/keys`,
      {
        key: ctx.adminKey,
        body: { label: "content", source: "content", role: "space_admin" },
      },
    );
    expect(spaceKeyRes.status).toBe(201);
    const spaceKey = ((await spaceKeyRes.json()) as { key: string }).key;
    const itemRes = await request(ctx.app, "POST", "/items", {
      key: spaceKey,
      body: { type: "core.note", properties: { body: "owned content" } },
    });
    expect(itemRes.status).toBe(201);
    const itemId = ((await itemRes.json()) as { item: { id: string } }).item.id;

    const res = await request(
      ctx.app,
      "POST",
      `/admin/accounts/${authUserId}/delete`,
      {
        key: ctx.adminKey,
        body: { confirm: "operator-target@example.com" },
      },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    // Gone: the lifecycle row, the space's items, the space's keys.
    expect(
      await ctx.storage.accountLifecycle?.getAccountLifecycle(authUserId),
    ).toBeNull();
    expect(await ctx.storage.items.get(itemId, spaceId)).toBeNull();
    const keyProbe = await request(ctx.app, "GET", "/items", {
      key: spaceKey,
    });
    expect(keyProbe.status).toBe(401);

    // Both audit rows: the cascade's own in-transaction record, and the
    // operator attribution this route adds.
    const audit = await ctx.storage.audit.list({ resource_id: authUserId });
    const actions = audit.data.map((r) => r.action);
    expect(actions).toContain("auth.account.hard_deleted");
    expect(actions).toContain("admin.account.deleted");
    const operatorRow = audit.data.find(
      (r) => r.action === "admin.account.deleted",
    );
    expect(operatorRow?.key_id).toBeTruthy();

    // Idempotence is a refusal, not a second delete: the account is gone,
    // so the email resolves to nothing.
    const again = await request(
      ctx.app,
      "POST",
      `/admin/accounts/${authUserId}/delete`,
      {
        key: ctx.adminKey,
        body: { confirm: "operator-target@example.com" },
      },
    );
    expect(again.status).toBe(400);
  });

  it("refuses on a deployment with no accounts, not crashes", async () => {
    // Keys-mode storage still wires the lifecycle store; with no accounts
    // in it, no email can resolve, so every ask lands on the same
    // mismatch refusal the fat-finger gate gives.
    ctx = await createTestContext();
    const res = await request(ctx.app, "POST", "/admin/accounts/x/delete", {
      key: ctx.adminKey,
      body: { confirm: "a@test.marfa.so" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("email address");
  });
});
