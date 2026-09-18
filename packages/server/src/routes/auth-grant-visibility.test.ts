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
 * `DELETE /items/{id}` with the operator key produced exactly one such
 * row on its own, before that door refused a live grant; every item door
 * refuses it now, so the fixture below is written through the store.
 * `softDeleteState` resolves `revoked` rather than `trashed`
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
 * The disagreement was driven through the real routes while a route still
 * produced the shape. None does now, so the shape is written onto the row,
 * and what that proves, that the predicate reads the field, is the point.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createTestContext,
  createTestAccount,
  mintSpaceKey,
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
  const schemaModule = await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const asColumn = (v: readonly string[]): unknown => JSON.stringify(v);
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

/**
 * Sign up + verify + sign in.
 *
 * Returns the session cookie, the space the provisioning hook put the new
 * account in, and a working key inside it. The space is the load-bearing
 * half: a grant is projected into the account's own space, so every read and
 * every item door below has to be asked from inside that space or it is
 * asking about somewhere else.
 */
async function signInUser(
  c: TestContext,
  email: string,
): Promise<{ cookie: string; spaceId: string; key: string }> {
  const password = "correct horse battery";
  await createTestAccount(c, email, password, "Tester");
  const signIn = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  expect(signIn.status).toBe(200);
  const spaceId = c.spaceId;
  const key = await mintSpaceKey(c, spaceId);
  const setCookie = signIn.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
  for (const entry of setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/)) {
    const head = entry.split(";")[0];
    if (head?.includes("session_token")) return { cookie: head, spaceId, key };
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
    form: {
      user_code,
      decision: "approve",
      // Everything ticked, which is what the screen submits untouched:
      // the approval form carries a checkbox per requested scope, so a
      // post with none is a denial rather than a full approval.
      scopes: scope.split(" ").filter(Boolean),
    },
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

/** `GET /auth/grants` from inside the account's own space, which is where its
 *  grants are projected. This is the surface the Disconnect button reads
 *  from, so it is what "the user can see it" means here. */
async function listedGrants(
  c: TestContext,
  key: string,
): Promise<{ id: string; client_id: string; status: string }[]> {
  const res = await request(c.app, "GET", "/auth/grants", { key });
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
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const { cookie, key } = await signInUser(
      c,
      "grant-visibility-softdelete@example.com",
    );

    await approveDeviceFlow(c, clientId, cookie, "core.note:read");

    // The baseline. An empty list at the end proves nothing unless the
    // grant was listed to begin with, and this is also what pins that the
    // operator key can read this surface at all.
    const before = await listedGrants(c, key);
    expect(before.length).toBe(1);
    const originalId = before[0]!.id;
    expect(before[0]!.client_id).toBe(clientId);

    // The shape that produces the disagreement: revoked on the state axis
    // and active on the status axis. `DELETE /items/{id}` used to produce it
    // with the operator key; that door now refuses a live grant (pinned
    // below), so the row is put into the shape directly, as any earlier
    // deployment's data or a future door could.
    await softDeleteGrantRow(c, originalId);

    // The fixture only means anything if it is the shape the predicate was
    // added to exclude: revoked on the state axis, still active on the
    // status axis, and therefore listed by neither read surface.
    const hidden = await c.storage.items.get(originalId);
    expect(hidden?.state).toBe("revoked");
    expect(hidden?.properties.status).toBe("active");
    expect(await listedGrants(c, key)).toEqual([]);
    const hiddenGrantedAt = hidden?.properties.granted_at;

    await approveDeviceFlow(c, clientId, cookie, "core.note:read");

    // Exactly one grant, and it is not the one an operator deleted.
    const after = await listedGrants(c, key);
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
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const { cookie } = await signInUser(
      c,
      "grant-visibility-lookup@example.com",
    );

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
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const { cookie, key } = await signInUser(
      c,
      "grant-visibility-reapprove@example.com",
    );

    await approveDeviceFlow(c, clientId, cookie, "core.note:read");
    const listed = await listedGrants(c, key);
    expect(listed.length).toBe(1);
    const grantId = listed[0]!.id;

    // The grants door. It moves `properties.status` and
    // deliberately leaves `state: "active"`, precisely so a later approval
    // has a row to reactivate — an app grant is a re-grantable
    // relationship, unlike an integration connection's terminal uninstall.
    const revoked = await request(c.app, "DELETE", `/auth/grants/${grantId}`, {
      key: c.spaceKey,
    });
    expect(revoked.status).toBe(204);
    const afterRevoke = await c.storage.items.get(grantId);
    expect(afterRevoke?.state).toBe("active");
    expect(afterRevoke?.properties.status).toBe("revoked");
    expect(await listedGrants(c, key)).toEqual([]);

    await approveDeviceFlow(c, clientId, cookie, "core.note:read");

    // Re-established in place, not forked. The predicate narrows on
    // `state`, so a row the user revoked is still the row the approval
    // reaches, and the projection stays single-row per (space, client,
    // user).
    const reapproved = await listedGrants(c, key);
    expect(reapproved.length).toBe(1);
    expect(reapproved[0]!.id).toBe(grantId);
    expect(reapproved[0]!.status).toBe("active");

    const row = await c.storage.items.get(grantId);
    expect(row?.state).toBe("active");
    expect(row?.properties.revoked_at).toBeUndefined();
    expect((await allGrantRows(c)).length).toBe(1);
  });
});

/**
 * A live grant cannot be stranded through the item doors, and which door
 * refuses depends on which gate the door reaches first.
 *
 * **Two of these doors never reach the grant refusal.** `DELETE /items/{id}`
 * and `POST /items/{id}/transition` both run `requireTypeAccess(item.type,
 * "write")` first, and a grant is a `system.connection`: the
 * reserved-namespace fence admits only the operator key, whose own type map
 * is empty, so no credential the product can mint writes one. Both answer 403
 * `type_not_permitted` and never consult liveness at all. The refusal that
 * used to sit behind that gate was removed rather than reordered, because a
 * refusal nobody can reach reads as a protection somebody is relying on; what
 * these cases pin is the gate that does the work, and that the grant is
 * untouched afterwards.
 *
 * **Two doors do reach it**, and keep their cases: the purge door reads the
 * row and refuses before it asks the write question, and the delete cascade
 * carries rows the type gate never saw, because the gate ran against the row
 * named in the URL.
 */
describe("a live grant cannot be stranded through the item doors", () => {
  it("DELETE /items/{id} never reaches the grant: the type gate answers first", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const { cookie, key } = await signInUser(
      c,
      "grant-visibility-refuse@example.com",
    );
    await approveDeviceFlow(c, clientId, cookie, "core.note:read");
    const [grant] = await listedGrants(c, key);
    expect(grant).toBeDefined();

    const res = await request(c.app, "DELETE", `/items/${grant!.id}`, {
      key,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("type_not_permitted");

    // Nothing moved: still listed, still live on both axes.
    expect((await listedGrants(c, key)).map((g) => g.id)).toEqual([grant!.id]);
    const row = await c.storage.items.get(grant!.id);
    expect(row?.state).toBe("active");
    expect(row?.properties.status).toBe("active");
  });

  it("DELETE /items/{id}/purge refuses the same grant before the trash gate can answer", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const { cookie, key } = await signInUser(
      c,
      "grant-visibility-purge@example.com",
    );
    await approveDeviceFlow(c, clientId, cookie, "core.note:read");
    const [grant] = await listedGrants(c, key);

    const res = await request(c.app, "DELETE", `/items/${grant!.id}/purge`, {
      key,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // The refusal is the grant one, not the ordering one about trashing
    // first, which would send the caller to a step that is itself refused.
    expect(body.error.message).toContain("still live");
    expect((await listedGrants(c, key)).map((g) => g.id)).toEqual([grant!.id]);
  });

  it("a revoked grant meets the same type gate, and the cascade is what removes it", async () => {
    // The type gate reads the row's type and nothing else, so revoking
    // first does not change its answer: a tombstone is refused at this door
    // exactly as a live grant is. Removing one is the cascade's job, which
    // is the second half of this case rather than a separate file, because
    // the pair is the whole story of how a grant row ever leaves.
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const { cookie, key } = await signInUser(
      c,
      "grant-visibility-tombstone@example.com",
    );
    await approveDeviceFlow(c, clientId, cookie, "core.note:read");
    const [grant] = await listedGrants(c, key);

    const revoke = await request(c.app, "DELETE", `/auth/grants/${grant!.id}`, {
      key: c.spaceKey,
    });
    expect(revoke.status).toBe(204);

    const direct = await request(c.app, "DELETE", `/items/${grant!.id}`, {
      key,
    });
    expect(direct.status).toBe(403);
    expect(
      ((await direct.json()) as { error: { code: string } }).error.code,
    ).toBe("type_not_permitted");
    expect((await c.storage.items.get(grant!.id))?.state).toBe("active");

    // Through a `parent-of` edge the cascade reaches the row the type gate
    // never saw, and with the grant revoked there is nothing left to refuse.
    const note = await request(c.app, "POST", "/items", {
      key,
      body: { type: "core.note", properties: { body: "holds the tombstone" } },
    });
    expect(note.status).toBe(201);
    const noteId = ((await note.json()) as { item: { id: string } }).item.id;
    const edge = await request(c.app, "POST", "/edges", {
      key,
      body: { source_id: noteId, target_id: grant!.id, edge_type: "parent-of" },
    });
    expect(edge.status).toBe(201);

    const cascaded = await request(c.app, "DELETE", `/items/${noteId}`, {
      key,
    });
    expect(cascaded.status).toBe(200);
    // The soft delete took: the row moved on the state axis, into the state
    // its own bounded lifecycle names rather than into `trashed`.
    expect((await c.storage.items.get(grant!.id))?.state).toBe("revoked");
  });

  it("a grant revoked on the state axis alone is the strand, and both doors still refuse it", async () => {
    // The revoke cascade writes `status` and never `state`, so this shape is
    // not a tombstone: tokens live, consent row standing, listed by neither
    // read surface. Purging it would make the strand permanent, since
    // nothing could ever run the cascade for it again.
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const { cookie, key } = await signInUser(
      c,
      "grant-visibility-strand@example.com",
    );
    await approveDeviceFlow(c, clientId, cookie, "core.note:read");
    const [grant] = await listedGrants(c, key);
    await softDeleteGrantRow(c, grant!.id);
    const row = await c.storage.items.get(grant!.id);
    expect(row?.state).toBe("revoked");
    expect(row?.properties.status).toBe("active");

    // Two doors, two different refusals, and both leave the row standing.
    // The delete door never gets as far as liveness; the purge door reads
    // the row first and names the strand.
    const del = await request(c.app, "DELETE", `/items/${grant!.id}`, {
      key,
    });
    expect(del.status).toBe(403);
    expect(((await del.json()) as { error: { code: string } }).error.code).toBe(
      "type_not_permitted",
    );
    const purge = await request(c.app, "DELETE", `/items/${grant!.id}/purge`, {
      key,
    });
    expect(purge.status).toBe(400);
    expect(
      ((await purge.json()) as { error: { message: string } }).error.message,
    ).toContain("still live");
    expect(await c.storage.items.get(grant!.id)).not.toBeNull();
  });

  it("POST /items/{id}/transition never reaches the grant either", async () => {
    // The type gate runs before anything reads the row's liveness, so this
    // door answers the same way the delete door does. Behind it the
    // lifecycle table would refuse anyway: a `system.*` type admits only
    // `revoked` and this route's schema cannot name it. Neither of those is
    // what a caller meets, and the one that answers is the one pinned.
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const { cookie, key } = await signInUser(
      c,
      "grant-visibility-transition@example.com",
    );
    await approveDeviceFlow(c, clientId, cookie, "core.note:read");
    const [grant] = await listedGrants(c, key);

    const res = await request(c.app, "POST", `/items/${grant!.id}/transition`, {
      key,
      body: { state: "archived" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "type_not_permitted",
    );
    const row = await c.storage.items.get(grant!.id);
    expect(row?.state).toBe("active");
    expect(row?.properties.status).toBe("active");
  });

  it("the delete cascade refuses a live grant reached through an edge, and the whole delete rolls back", async () => {
    // `parent-of` cascades on delete and admits any type at either end, so
    // a row anyone can write could otherwise carry the grant out with it.
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const { cookie, key } = await signInUser(
      c,
      "grant-visibility-cascade@example.com",
    );
    await approveDeviceFlow(c, clientId, cookie, "core.note:read");
    const [grant] = await listedGrants(c, key);

    const note = await request(c.app, "POST", "/items", {
      key,
      body: {
        type: "core.note",
        properties: { title: "parent", body: "holds the grant" },
      },
    });
    expect(note.status).toBe(201);
    const noteId = ((await note.json()) as { item: { id: string } }).item.id;
    const edge = await request(c.app, "POST", "/edges", {
      key,
      body: { source_id: noteId, target_id: grant!.id, edge_type: "parent-of" },
    });
    expect(edge.status).toBe(201);

    const res = await request(c.app, "DELETE", `/items/${noteId}`, {
      key,
    });
    expect(res.status).toBe(400);
    expect(
      ((await res.json()) as { error: { message: string } }).error.message,
    ).toContain("still live");
    // Rolled back as a whole: the parent is untouched too.
    expect((await c.storage.items.get(noteId))?.state).toBe("active");
    expect((await c.storage.items.get(grant!.id))?.state).toBe("active");
    expect((await listedGrants(c, key)).map((g) => g.id)).toEqual([grant!.id]);
  });
});
