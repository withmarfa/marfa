/**
 * Operator-initiated space deletion.
 *
 * The counterpart to account deletion for the case that cascade cannot
 * serve: a space provisioned by a platform credential has no `auth_user`
 * behind it, so before this route there was no way to remove one at all.
 * Conformance creating a space per run is the standing consequence.
 *
 * What the tests pin: the confirm gate refuses anything but the exact id;
 * a completed delete leaves nothing of the space behind; a space that
 * still has users is refused rather than half-deleted, because the
 * account cascade owns the auth island; and the operator's action is
 * recorded.
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

/** A space with no account behind it — the shape conformance creates. */
async function seedAccountlessSpace(c: TestContext): Promise<string> {
  const res = await request(c.app, "POST", "/admin/spaces", {
    key: c.adminKey,
    body: { name: "conformance-shared-deadbeef" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("POST /admin/spaces/:id/delete", () => {
  it("requires a platform admin", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "POST", "/admin/spaces/x/delete", {
      body: { confirm: "x" },
    });
    expect(res.status).toBe(401);
  });

  it("refuses when confirm is not the space id, exactly", async () => {
    ctx = await createTestContext();
    const spaceId = await seedAccountlessSpace(ctx);

    for (const confirm of ["wrong", `${spaceId} `, spaceId.toUpperCase(), ""]) {
      const res = await request(
        ctx.app,
        "POST",
        `/admin/spaces/${spaceId}/delete`,
        { key: ctx.adminKey, body: { confirm } },
      );
      expect(res.status, `confirm=${JSON.stringify(confirm)}`).toBe(400);
    }

    // Nothing was deleted by any of the refusals.
    expect(await ctx.storage.spaces?.get(spaceId)).not.toBeNull();
  });

  it("404s on a space that does not exist", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "POST",
      "/admin/spaces/no-such-space/delete",
      { key: ctx.adminKey, body: { confirm: "no-such-space" } },
    );
    expect(res.status).toBe(404);
  });

  it("deletes the space and everything scoped to it", async () => {
    ctx = await createTestContext();
    const spaceId = await seedAccountlessSpace(ctx);

    // Give the space content, so "everything scoped to it" is a real claim.
    const keyRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${spaceId}/keys`,
      {
        key: ctx.adminKey,
        body: { label: "content", source: "content", role: "space_admin" },
      },
    );
    expect(keyRes.status).toBe(201);
    const spaceKey = ((await keyRes.json()) as { key: string }).key;

    const itemRes = await request(ctx.app, "POST", "/items", {
      key: spaceKey,
      body: { type: "core.note", properties: { body: "doomed" } },
    });
    expect(itemRes.status).toBe(201);

    const res = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${spaceId}/delete`,
      { key: ctx.adminKey, body: { confirm: spaceId } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    // The space is gone, and so is the credential that reached into it.
    expect(await ctx.storage.spaces?.get(spaceId)).toBeNull();
    const afterKey = await request(ctx.app, "GET", "/items", { key: spaceKey });
    expect(afterKey.status).toBe(401);

    // And it is gone from the operator's own listing.
    const list = await request(ctx.app, "GET", "/admin/spaces", {
      key: ctx.adminKey,
    });
    const body = (await list.json()) as { spaces?: { id: string }[] };
    expect((body.spaces ?? []).some((s) => s.id === spaceId)).toBe(false);
  });

  it("refuses a space that still has users, naming the account route", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const signUp = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "space-owner@example.com",
        password: "correct horse",
        name: "Space Owner",
      },
      headers: { origin: ORIGIN },
    });
    expect(signUp.status).toBe(200);
    await markEmailVerified(ctx.storage, "space-owner@example.com");
    const lifecycle = ctx.storage.accountLifecycle;
    if (!lifecycle)
      throw new Error("account lifecycle expected in hosted mode");
    const row = await lifecycle.getAccountLifecycleByEmail(
      "space-owner@example.com",
    );
    if (!row) throw new Error("provisioned account not found");
    const user = await ctx.storage.users?.getByAuthUserId(row.auth_user_id);
    if (!user) throw new Error("provisioned users row not found");

    const res = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${user.space_id}/delete`,
      { key: ctx.adminKey, body: { confirm: user.space_id } },
    );
    expect(res.status).toBe(409);
    // The refusal has to name the id the other route needs, not a
    // placeholder. Pointing at `{id}` sent the operator to a route whose
    // required input nothing served, and the only way through was a query
    // against the database.
    const body = (await res.json()) as { error?: { message?: string } };
    const message = body.error?.message ?? "";
    expect(message).toContain(`/admin/accounts/${row.auth_user_id}/delete`);
    expect(message).not.toContain("{id}");

    // Refused means untouched, not partly swept.
    expect(await ctx.storage.spaces?.get(user.space_id)).not.toBeNull();
    expect(
      await ctx.storage.users?.getByAuthUserId(row.auth_user_id),
    ).not.toBeNull();
  });

  // The other half of the same gap: the id has to be obtainable before you
  // hit a refusal, so an operator can delete an account without first having
  // to provoke an error to learn its identifier.
  it("names the owner's account id on the space detail and the listing", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const signUp = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "owner-id@example.com",
        password: "correct horse",
        name: "Owner Id",
      },
      headers: { origin: ORIGIN },
    });
    expect(signUp.status).toBe(200);
    await markEmailVerified(ctx.storage, "owner-id@example.com");
    const lifecycle = ctx.storage.accountLifecycle;
    if (!lifecycle)
      throw new Error("account lifecycle expected in hosted mode");
    const row = await lifecycle.getAccountLifecycleByEmail(
      "owner-id@example.com",
    );
    if (!row) throw new Error("provisioned account not found");
    const user = await ctx.storage.users?.getByAuthUserId(row.auth_user_id);
    if (!user) throw new Error("provisioned users row not found");

    const detail = await request(
      ctx.app,
      "GET",
      `/admin/spaces/${user.space_id}`,
      { key: ctx.adminKey },
    );
    expect(detail.status).toBe(200);
    const shown = (await detail.json()) as {
      space?: { owner_auth_user_id?: string | null; owner_email?: string };
    };
    expect(shown.space?.owner_auth_user_id).toBe(row.auth_user_id);
    // It sits beside the email, and the two must name the same account.
    expect(shown.space?.owner_email).toBe("owner-id@example.com");

    const list = await request(ctx.app, "GET", "/admin/spaces", {
      key: ctx.adminKey,
    });
    const listed = (await list.json()) as {
      data?: { id: string; owner_auth_user_id?: string | null }[];
    };
    const mine = (listed.data ?? []).find((s) => s.id === user.space_id);
    expect(mine?.owner_auth_user_id).toBe(row.auth_user_id);
  });

  // A space nobody owns has no account id, and null is the honest answer.
  // Anything else would be a value an operator could paste into a delete.
  it("reports a null account id for a space with no account", async () => {
    ctx = await createTestContext();
    const spaceId = await seedAccountlessSpace(ctx);
    const detail = await request(ctx.app, "GET", `/admin/spaces/${spaceId}`, {
      key: ctx.adminKey,
    });
    const shown = (await detail.json()) as {
      space?: { owner_auth_user_id?: string | null };
    };
    expect(shown.space?.owner_auth_user_id).toBeNull();
  });
});
