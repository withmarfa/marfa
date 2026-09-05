/**
 * A grant lookup only finds a grant a person can see.
 *
 * A `system.connection { kind: "app" }` row carries two lifecycle axes, and
 * both read surfaces that offer a Disconnect button require both: `GET
 * /grants` and the security page each list with `state: "active"` and then
 * skip anything whose `properties.status` is not `"active"`. A row failing
 * either axis is listed by neither and cannot be revoked through any
 * interface the product has.
 *
 * `DELETE /items/{id}` with a platform credential produces exactly one such
 * row on its own. `softDeleteState` resolves `revoked` rather than `trashed`
 * for a `system.*` type, so `state` moves and `properties` does not — the
 * row now reads active on the status axis and revoked on the state axis.
 * `findGrantItemId` had no `state` predicate and `items.get` hides only
 * trashed rows, so a later re-approval found it, flipped `status` back to
 * `"active"` (already its value) and stamped a fresh `granted_at`, leaving a
 * record the token step would happily mint against and nobody could reach.
 *
 * The fix is a `state = 'active'` predicate on `findGrantItemId` itself, in
 * both dialects. That makes the fresh insert the only branch a soft-deleted
 * grant can reach, and it fixes the code-flow twin at the same time, since
 * `projectGrantOnConsent` resolves through the same method.
 *
 * Driven through the real routes rather than store writes, because the
 * disagreement under test is one a real route produces and a hand-stamped
 * `state` would prove only that the predicate reads the field.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// Each case signs a user up and in (two password hashes) and drives at
// least one full device flow before it asserts anything. That is a lot of
// real work for the default budget on a machine running the rest of the
// suite beside it, and an overrun reports as a timeout — a result that says
// nothing about the property under test.
vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

/** Seed an `auth_oauth_client` registered for the device grant. Initiation
 *  refuses a client whose registration does not name it, and an
 *  unregistered `grant_types` reads as `authorization_code` alone per
 *  RFC 7591 §2. */
async function seedClient(c: TestContext): Promise<string> {
  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  if (!c.storage.betterAuthDb) {
    throw new Error("seedClient: storage.betterAuthDb missing");
  }
  const schemaModule =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const asColumn = (v: readonly string[]): unknown =>
    c.storage.betterAuthDialect === "pg" ? [...v] : JSON.stringify(v);
  const now = new Date();
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: `pk_${Math.random().toString(36).slice(2, 10)}`,
    clientId,
    name: "Visibility Test CLI",
    redirectUris: asColumn([`${ORIGIN}/callback`]),
    grantTypes: asColumn(["urn:ietf:params:oauth:grant-type:device_code"]),
    disabled: false,
    createdAt: now,
    updatedAt: now,
    public: true,
    tokenEndpointAuthMethod: "none",
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}

/** Sign up + verify + sign in; returns the session cookie header value. */
async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Tester" },
    headers: { origin: ORIGIN },
  });
  await markEmailVerified(c.storage, email);
  const signIn = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  expect(signIn.status).toBe(200);
  const setCookie = signIn.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
  for (const entry of setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/)) {
    const head = entry.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("sign-in: session_token cookie not found");
}

/** Initiate and approve one device flow, so a projected grant exists. */
async function approveDeviceFlow(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
): Promise<void> {
  const init = await request(c.app, "POST", "/auth/device", {
    body: { client_id: clientId, scope },
    headers: { origin: ORIGIN },
  });
  expect(init.status).toBe(200);
  const { user_code } = (await init.json()) as { user_code: string };
  const consent = await request(c.app, "POST", "/auth/device/consent", {
    form: { user_code, decision: "approve" },
    headers: { origin: ORIGIN, cookie },
  });
  expect(consent.status).toBe(200);
}

/** Move a grant to `state: revoked` without touching its properties, the
 *  shape an operator soft-delete produced before the door refused it. */
async function softDeleteGrantRow(c: TestContext, id: string): Promise<void> {
  const row = await c.storage.items.get(id);
  if (!row) throw new Error(`softDeleteGrantRow: no item ${id}`);
  await c.storage.items.transition(id, "revoked", row.space_id ?? undefined);
}

/** Every projected grant row, whatever either axis says. */
async function allGrantRows(c: TestContext) {
  const listed = await c.storage.items.list({ type: "system.connection" });
  return listed.data;
}

/** `GET /auth/grants` as the platform credential, which is unbound and so
 *  sees every space's grants. This is the surface the Disconnect button
 *  reads from, so it is what "the user can see it" means here. */
async function listedGrants(
  c: TestContext,
): Promise<{ id: string; client_id: string; status: string }[]> {
  const res = await request(c.app, "GET", "/auth/grants", { key: c.adminKey });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    id: string;
    client_id: string;
    status: string;
  }[];
}

/** Resolve the grant the way every production caller does. */
function resolveGrantItemId(
  c: TestContext,
  spaceId: string | null,
  clientId: string,
  authUserId: string,
): Promise<string | null | undefined> {
  return Promise.resolve(
    c.storage.oauthProvider?.findGrantItemId({
      spaceId,
      clientId,
      authUserId,
    }),
  );
}

describe("a soft-deleted grant is not resurrected by a re-approval", () => {
  it("REGRESSION: a re-approval inserts a fresh grant and leaves the unreachable row revoked", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(
      c,
      "grant-visibility-softdelete@example.com",
    );

    await approveDeviceFlow(c, clientId, cookie, "core.note:read");

    // The baseline. An empty list at the end proves nothing unless the
    // grant was listed to begin with, and this is also what pins that the
    // platform credential can read this surface at all.
    const before = await listedGrants(c);
    expect(before.length).toBe(1);
    const originalId = before[0]!.id;
    expect(before[0]!.client_id).toBe(clientId);

    // The shape that produces the disagreement: revoked on the state axis
    // and active on the status axis. `DELETE /items/{id}` used to produce it
    // with a platform credential; that door now refuses a live grant (pinned
    // below), so the row is put into the shape directly, as any earlier
    // deployment's data or a future door could.
    await softDeleteGrantRow(c, originalId);

    // The fixture only means anything if it is the shape the predicate was
    // added to exclude: revoked on the state axis, still active on the
    // status axis, and therefore listed by neither read surface.
    const hidden = await c.storage.items.get(originalId);
    expect(hidden?.state).toBe("revoked");
    expect(hidden?.properties.status).toBe("active");
    expect(await listedGrants(c)).toEqual([]);
    const hiddenGrantedAt = hidden?.properties.granted_at;

    await approveDeviceFlow(c, clientId, cookie, "core.note:read");

    // Exactly one grant, and it is not the one an operator deleted.
    const after = await listedGrants(c);
    expect(after.length).toBe(1);
    expect(after[0]!.id).not.toBe(originalId);
    expect(after[0]!.client_id).toBe(clientId);
    expect(after[0]!.status).toBe("active");

    // The tombstone was never touched. Both halves matter: a row still at
    // `state: revoked` cannot mint or be merged against, and an unchanged
    // `granted_at` is what says the approval never reached it rather than
    // reaching it and writing the same values back.
    const tombstone = await c.storage.items.get(originalId);
    expect(tombstone?.state).toBe("revoked");
    expect(tombstone?.properties.granted_at).toBe(hiddenGrantedAt);

    // Two rows exist in storage; only the reachable one is a grant.
    const rows = await allGrantRows(c);
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.state === "active").length).toBe(1);
  });

  it("findGrantItemId returns null for a grant no read surface will list", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c, "grant-visibility-lookup@example.com");

    await approveDeviceFlow(c, clientId, cookie, "core.note:read");
    const grant = (await allGrantRows(c))[0]!;
    const spaceId = grant.space_id ?? null;
    const authUserId = grant.properties.user_id as string;

    // The lookup resolves it while it is reachable, so a null afterwards is
    // the predicate and not a mis-keyed probe.
    expect(await resolveGrantItemId(c, spaceId, clientId, authUserId)).toBe(
      grant.id,
    );

    // The door that produced this shape now refuses a live grant; shape the

    // row through the store instead.

    await softDeleteGrantRow(c, grant.id);
    expect((await c.storage.items.get(grant.id))?.state).toBe("revoked");

    expect(
      await resolveGrantItemId(c, spaceId, clientId, authUserId),
    ).toBeNull();
  });
});

describe("an ordinary revoke still re-establishes on re-approval", () => {
  it("keeps updating the same row when only properties.status was revoked", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(
      c,
      "grant-visibility-reapprove@example.com",
    );

    await approveDeviceFlow(c, clientId, cookie, "core.note:read");
    const listed = await listedGrants(c);
    expect(listed.length).toBe(1);
    const grantId = listed[0]!.id;

    // The user's own Disconnect button. It moves `properties.status` and
    // deliberately leaves `state: "active"`, precisely so a later approval
    // has a row to reactivate — an app grant is a re-grantable
    // relationship, unlike an integration connection's terminal uninstall.
    const revoked = await request(
      c.app,
      "POST",
      `/auth/grants/${grantId}/revoke`,
      { headers: { origin: ORIGIN, cookie } },
    );
    expect(revoked.status).toBe(302);
    expect(revoked.headers.get("location") ?? "").toContain(
      "notice=grant_revoked",
    );
    const afterRevoke = await c.storage.items.get(grantId);
    expect(afterRevoke?.state).toBe("active");
    expect(afterRevoke?.properties.status).toBe("revoked");
    expect(await listedGrants(c)).toEqual([]);

    await approveDeviceFlow(c, clientId, cookie, "core.note:read");

    // Re-established in place, not forked. The predicate narrows on
    // `state`, so a row the user revoked is still the row the approval
    // reaches, and the projection stays single-row per (space, client,
    // user).
    const reapproved = await listedGrants(c);
    expect(reapproved.length).toBe(1);
    expect(reapproved[0]!.id).toBe(grantId);
    expect(reapproved[0]!.status).toBe("active");

    const row = await c.storage.items.get(grantId);
    expect(row?.state).toBe("active");
    expect(row?.properties.revoked_at).toBeUndefined();
    expect((await allGrantRows(c)).length).toBe(1);
  });
});

describe("an operator cannot strand a live grant through the item doors", () => {
  it("DELETE /items/{id} refuses a grant live on both axes and names the grant routes", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c, "grant-visibility-refuse@example.com");
    await approveDeviceFlow(c, clientId, cookie, "core.note:read");
    const [grant] = await listedGrants(c);
    expect(grant).toBeDefined();

    const res = await request(c.app, "DELETE", `/items/${grant!.id}`, {
      key: c.adminKey,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain(`/auth/grants/${grant!.id}/revoke`);

    // Nothing moved: still listed, still live on both axes.
    expect((await listedGrants(c)).map((g) => g.id)).toEqual([grant!.id]);
    const row = await c.storage.items.get(grant!.id);
    expect(row?.state).toBe("active");
    expect(row?.properties.status).toBe("active");
  });

  it("DELETE /items/{id}/purge refuses the same grant before the trash gate can answer", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c, "grant-visibility-purge@example.com");
    await approveDeviceFlow(c, clientId, cookie, "core.note:read");
    const [grant] = await listedGrants(c);

    const res = await request(c.app, "DELETE", `/items/${grant!.id}/purge`, {
      key: c.adminKey,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // The refusal is the grant one, not the ordering one about trashing
    // first, which would send the caller to a step that is itself refused.
    expect(body.error.message).toContain("still live");
    expect((await listedGrants(c)).map((g) => g.id)).toEqual([grant!.id]);
  });

  it("a grant revoked through the grants surface deletes freely", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(
      c,
      "grant-visibility-tombstone@example.com",
    );
    await approveDeviceFlow(c, clientId, cookie, "core.note:read");
    const [grant] = await listedGrants(c);

    const revoke = await request(
      c.app,
      "POST",
      `/auth/grants/${grant!.id}/revoke`,
      { headers: { origin: ORIGIN, cookie } },
    );
    expect(revoke.status).toBe(302);
    expect(revoke.headers.get("location")).toContain("notice=grant_revoked");

    const res = await request(c.app, "DELETE", `/items/${grant!.id}`, {
      key: c.adminKey,
    });
    expect(res.status).toBe(200);
    expect(await listedGrants(c)).toEqual([]);
  });
});
