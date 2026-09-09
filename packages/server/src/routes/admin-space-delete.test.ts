/**
 * Operator-initiated space deletion.
 *
 * The counterpart to account deletion for the case that cascade cannot
 * serve: a space provisioned by the operator key has no `auth_user`
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
import { initEventLog, __resetCycleDetectionForTests } from "../pubsub.js";

const ORIGIN = "http://localhost:0";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

/** A space with no account behind it — the shape conformance creates. */
async function seedAccountlessSpace(c: TestContext): Promise<string> {
  const res = await request(c.app, "POST", "/admin/spaces", {
    key: c.operatorKey,
    body: { name: "conformance-shared-deadbeef" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("POST /admin/spaces/:id/delete", () => {
  it("requires the operator key", async () => {
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
        { key: ctx.operatorKey, body: { confirm } },
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
      { key: ctx.operatorKey, body: { confirm: "no-such-space" } },
    );
    expect(res.status).toBe(404);
  });

  it("takes the space's own type vocabulary with it", async () => {
    // The sweep listed nine kinds of row and not this one, in both dialects,
    // so every space deletion left its registrations behind — addressable
    // only through a credential scoped to a space that no longer exists, and
    // re-registered into the in-memory overlay on every subsequent boot.
    //
    // Registered through the routes rather than written to the store, because
    // registration is what a space actually does and a hand-written row would
    // test a fiction of it.
    ctx = await createTestContext();
    const spaceId = await seedAccountlessSpace(ctx);
    const keyRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${spaceId}/keys`,
      {
        key: ctx.operatorKey,
        body: {
          label: "types",
          source: "types",
          metadata_permissions: { "*": "write" },
        },
      },
    );
    expect(keyRes.status).toBe(201);
    const spaceKey = ((await keyRes.json()) as { key: string }).key;

    const typeRes = await request(ctx.app, "POST", "/types", {
      key: spaceKey,
      body: {
        id: "user.doomed",
        label: "Doomed",
        fields: { note: { type: "string" } },
      },
    });
    expect(typeRes.status).toBe(201);

    const edgeRes = await request(ctx.app, "POST", "/edge-types", {
      key: spaceKey,
      body: {
        id: "doomed-link",
        label: "Doomed link",
        cardinality: "many-to-many",
      },
    });
    expect(edgeRes.status).toBe(201);

    // Present before, or the assertion after proves nothing.
    expect(
      (await ctx.storage.types.listCustom(spaceId)).map((t) => t.id),
    ).toContain("user.doomed");

    const res = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${spaceId}/delete`,
      { key: ctx.operatorKey, body: { confirm: spaceId } },
    );
    expect(res.status).toBe(200);

    expect(await ctx.storage.types.listCustom(spaceId)).toEqual([]);
    expect(await ctx.storage.edgeTypes.list(spaceId)).toEqual([]);
  });

  it("takes the space's event-log rows with it", async () => {
    // The one space-scoped table the sweep did not name, in both dialects.
    // The retention sweep ages the rows out eventually, so nothing leaked
    // permanently — but a teardown that is exhaustive except for one table
    // reads as an oversight to whoever extends it next, and the hole is what
    // makes the next table likelier to be missed too.
    ctx = await createTestContext();
    const spaceId = await seedAccountlessSpace(ctx);
    const keyRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${spaceId}/keys`,
      {
        key: ctx.operatorKey,
        body: {
          label: "events",
          source: "events",
          type_permissions: { "*": "write" },
        },
      },
    );
    expect(keyRes.status).toBe(201);
    const spaceKey = ((await keyRes.json()) as { key: string }).key;

    // Persistence is wired at server startup, which a test context does not
    // do, so the rows a real deployment writes have to be switched on here.
    // Detached again afterwards: the wiring is module state, and leaving it
    // bound to this context would follow every test after it in this file.
    initEventLog(ctx.storage.eventLog);
    try {
      // A write through the routes, because that is what appends an
      // event-log row; a hand-written row would test a fiction of it.
      const itemRes = await request(ctx.app, "POST", "/items", {
        key: spaceKey,
        body: { type: "core.note", properties: { body: "announced" } },
      });
      expect(itemRes.status).toBe(201);

      // Present before, or the assertion after proves nothing.
      expect(
        (await ctx.storage.eventLog.getAfter(0n, 100, spaceId)).length,
      ).toBeGreaterThan(0);

      const res = await request(
        ctx.app,
        "POST",
        `/admin/spaces/${spaceId}/delete`,
        { key: ctx.operatorKey, body: { confirm: spaceId } },
      );
      expect(res.status).toBe(200);

      expect(await ctx.storage.eventLog.getAfter(0n, 100, spaceId)).toEqual([]);
    } finally {
      __resetCycleDetectionForTests();
    }
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
        key: ctx.operatorKey,
        body: {
          label: "content",
          source: "content",
          type_permissions: { "*": "write" },
        },
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
      { key: ctx.operatorKey, body: { confirm: spaceId } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    // The space is gone, and so is the credential that reached into it.
    expect(await ctx.storage.spaces?.get(spaceId)).toBeNull();
    const afterKey = await request(ctx.app, "GET", "/items", { key: spaceKey });
    expect(afterKey.status).toBe(401);

    // And it is gone from the operator's own listing.
    const list = await request(ctx.app, "GET", "/admin/spaces", {
      key: ctx.operatorKey,
    });
    // `data`, not `spaces`. The route has always returned `data`, so the
    // previous shape made this assertion pass against an undefined array
    // whatever the listing contained.
    const body = (await list.json()) as { data?: { id: string }[] };
    expect(body.data).toBeDefined();
    expect((body.data ?? []).some((s) => s.id === spaceId)).toBe(false);
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
      { key: ctx.operatorKey, body: { confirm: user.space_id } },
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
      { key: ctx.operatorKey },
    );
    expect(detail.status).toBe(200);
    const shown = (await detail.json()) as {
      space?: { owner_auth_user_id?: string | null; owner_email?: string };
    };
    expect(shown.space?.owner_auth_user_id).toBe(row.auth_user_id);
    // It sits beside the email, and the two must name the same account.
    expect(shown.space?.owner_email).toBe("owner-id@example.com");

    const list = await request(ctx.app, "GET", "/admin/spaces", {
      key: ctx.operatorKey,
    });
    const listed = (await list.json()) as {
      data?: { id: string; owner_auth_user_id?: string | null }[];
    };
    const mine = (listed.data ?? []).find((s) => s.id === user.space_id);
    expect(mine?.owner_auth_user_id).toBe(row.auth_user_id);
  });

  // A space nobody owns has no account id, and null is the honest answer.
  // Anything else would be a value an operator could paste into a delete.
  //
  // Hosted mode on purpose. `createTestContext()` defaults to keys, where
  // `storage.users` is not wired at all, so `withOwner` takes its first branch
  // and returns a hardcoded null — which means the branch that actually
  // computes this value was executed by no test, and changing it to return the
  // space id would have passed.
  it("reports a null account id for a space with no account", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const spaceId = await seedAccountlessSpace(ctx);
    const detail = await request(ctx.app, "GET", `/admin/spaces/${spaceId}`, {
      key: ctx.operatorKey,
    });
    const shown = (await detail.json()) as {
      space?: {
        owner_auth_user_id?: string | null;
        owner_email?: string | null;
      };
    };
    expect(shown.space?.owner_auth_user_id).toBeNull();
    // And the email is null too, which is what makes the pair coherent: this
    // space has no account, rather than an account whose id we failed to read.
    expect(shown.space?.owner_email).toBeNull();
  });

  // The point of the whole change: the id the detail hands you drives the
  // delete. Nothing tested that the loop actually closes.
  it("the id from the space detail drives the account delete", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const signUp = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "end-to-end@example.com",
        password: "correct horse",
        name: "End To End",
      },
      headers: { origin: ORIGIN },
    });
    expect(signUp.status).toBe(200);
    await markEmailVerified(ctx.storage, "end-to-end@example.com");
    const lifecycle = ctx.storage.accountLifecycle;
    if (!lifecycle)
      throw new Error("account lifecycle expected in hosted mode");
    const row = await lifecycle.getAccountLifecycleByEmail(
      "end-to-end@example.com",
    );
    if (!row) throw new Error("provisioned account not found");
    const user = await ctx.storage.users?.getByAuthUserId(row.auth_user_id);
    if (!user) throw new Error("provisioned users row not found");

    // Read the id the way an operator would, from the API rather than the store.
    const detail = await request(
      ctx.app,
      "GET",
      `/admin/spaces/${user.space_id}`,
      { key: ctx.operatorKey },
    );
    const shown = (await detail.json()) as {
      space?: {
        owner_auth_user_id?: string | null;
        owner_email?: string | null;
      };
    };
    const id = shown.space?.owner_auth_user_id;
    const email = shown.space?.owner_email;
    expect(id).toBeTruthy();

    // And drive the delete with exactly those two values, nothing else.
    const deleted = await request(
      ctx.app,
      "POST",
      `/admin/accounts/${String(id)}/delete`,
      { key: ctx.operatorKey, body: { confirm: String(email) } },
    );
    expect(deleted.status).toBe(200);

    // The account and its space are gone, which is what makes this the whole
    // loop rather than two halves that happen to agree.
    expect(
      await ctx.storage.users?.getByAuthUserId(row.auth_user_id),
    ).toBeNull();
    expect(await ctx.storage.spaces?.get(user.space_id)).toBeNull();
  });

  // The refusal must survive the lookup failing. Resolving the owner is a
  // convenience on an error path, and letting it turn a 409 into an opaque 500
  // would trade a clear refusal for a worse one. The same branch is what a
  // keys-mode deployment takes, where the user store is not wired at all while
  // the refusal still comes from a direct query against the table.
  it("still names the route when the owner lookup fails", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const signUp = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "lookup-fails@example.com",
        password: "correct horse",
        name: "Lookup Fails",
      },
      headers: { origin: ORIGIN },
    });
    expect(signUp.status).toBe(200);
    await markEmailVerified(ctx.storage, "lookup-fails@example.com");
    const lifecycle = ctx.storage.accountLifecycle;
    if (!lifecycle)
      throw new Error("account lifecycle expected in hosted mode");
    const row = await lifecycle.getAccountLifecycleByEmail(
      "lookup-fails@example.com",
    );
    if (!row) throw new Error("provisioned account not found");
    const user = await ctx.storage.users?.getByAuthUserId(row.auth_user_id);
    if (!user) throw new Error("provisioned users row not found");

    const users = ctx.storage.users;
    if (!users) throw new Error("user store expected in hosted mode");
    const original = users.getBySpaceId.bind(users);
    users.getBySpaceId = () => {
      throw new Error("the store is unavailable");
    };
    try {
      const res = await request(
        ctx.app,
        "POST",
        `/admin/spaces/${user.space_id}/delete`,
        { key: ctx.operatorKey, body: { confirm: user.space_id } },
      );
      // A refusal, not a server error.
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error?: { message?: string } };
      const message = body.error?.message ?? "";
      // And it still points somewhere followable rather than asserting that
      // something impossible has happened.
      expect(message).toContain("/admin/accounts/{id}/delete");
      expect(message).not.toContain("That should not happen");
    } finally {
      users.getBySpaceId = original;
    }
  });
});
