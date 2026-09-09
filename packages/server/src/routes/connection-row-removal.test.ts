/**
 * A connection row cannot be removed out from under its credentials.
 *
 * `api_keys.connection_id` carries no foreign key, so a runtime credential
 * whose connection has been deleted is standing privilege that nothing can
 * attribute — the row naming its owner is gone. Both removal doors used to
 * allow exactly that: `DELETE /items/{id}` and `DELETE /items/{id}/purge`
 * removed the row and revoked nothing, and the purge door never even read
 * the item, so it could not have told a connection from a note.
 *
 * The doors refuse rather than revoking, and that is the design rather than
 * the cheap option. Revoking here would be a second teardown beside
 * `performUninstall`, which also drops leased tokens, the proxy's cached
 * upstream tokens and inbound webhook subscriptions. Two teardowns drift,
 * and the one reached by an ordinary `DELETE` is the one nobody would think
 * to keep in step.
 *
 * **How a caller reaches the delete door at all is the fixture's whole
 * problem.** `DELETE /items/{id}` asks for write on the target row's type
 * before it looks at what the row is, and the reserved namespace admits no
 * credential the product can mint: a space key is refused by the operator
 * gate, and the operator key's own permission maps are empty. What is left
 * is the cascade. `parent-of` cascades on delete and admits any type at
 * either end, so deleting an ordinary row that parents a connection aims the
 * same door at the connection — which is why the handler guards every row
 * the cascade reaches and not only the one named in the URL. The purge door
 * is reached directly, because it reads the row and refuses before it asks
 * the write question.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * A `system.connection` row, seeded through the storage layer because no
 * credential writes one: the reserved-namespace gate admits only the operator
 * key and the operator key's own permission maps are empty, so the platform's
 * own machinery writes these rows through storage rather than through a door.
 */
async function seedConnection(properties: {
  kind: "integration" | "app";
  status: string;
  revoked_at?: string;
}): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: { granted_at: new Date().toISOString(), ...properties },
    },
    ctx.spaceId,
  );
  return item.id;
}

/**
 * An ordinary row the caller may delete, parenting `childId`. Deleting it
 * runs the cascade onto the child, which is how the delete door is put in
 * front of a connection by a credential that cannot name one directly.
 */
async function parentOf(childId: string): Promise<string> {
  const parent = await ctx.storage.items.create(
    { type: "core.note", properties: { body: "parent of a connection" } },
    ctx.spaceId,
  );
  const edge = await request(ctx.app, "POST", "/edges", {
    key: ctx.spaceKey,
    body: {
      source_id: parent.id,
      target_id: childId,
      edge_type: "parent-of",
    },
  });
  expect(edge.status).toBe(201);
  return parent.id;
}

describe("removing a system.connection row", () => {
  it("refuses to delete one that is still live, and says where to go", async () => {
    const id = await seedConnection({ kind: "integration", status: "active" });

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${await parentOf(id)}`,
      {
        key: ctx.spaceKey,
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("validation_error");
    // The message has to name the door that does it properly, because a
    // refusal that does not is a dead end rather than a redirection.
    expect(body.error.message).toContain(`/connections/${id}/uninstall`);

    // And the row is still there — a refusal that half-deleted would be
    // worse than the behavior it replaced.
    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    expect(after.status).toBe(200);
  });

  it("refuses to purge one that is still live, for the connection reason", async () => {
    // The sharper of the two: purge is irreversible, and this door never
    // read the item at all before refusing was added to it.
    //
    // **Asserted on the message rather than the status, and that is the
    // whole point of this case.** `/purge` already answers 400 for an
    // untrashed item, so a status-only assertion passes identically with
    // this guard deleted — which it did, and a mutation run is what said
    // so. Two refusals that share a status and differ in reason are
    // indistinguishable to a test that reads only the status.
    const id = await seedConnection({ kind: "integration", status: "active" });

    const res = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key: ctx.spaceKey,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(`/connections/${id}/uninstall`);
    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    expect(after.status).toBe(200);
  });

  it("allows both once the connection has been revoked", async () => {
    // Uninstall has run by then, so the credentials are gone and the row is
    // ordinary history. Refusing here would strand it instead of protecting
    // anything.
    const deletable = await seedConnection({
      kind: "integration",
      status: "revoked",
    });
    const deleted = await request(
      ctx.app,
      "DELETE",
      `/items/${await parentOf(deletable)}`,
      { key: ctx.spaceKey },
    );
    expect(deleted.status).toBe(200);
    // The cascade took the connection with it rather than stopping at the
    // guard, which is the half a 200 on the parent alone would not show. A
    // soft delete lands the row in its own type's soft-delete state, and for
    // a bounded lifecycle that is `revoked` rather than `trashed`.
    const swept = await ctx.storage.items.get(deletable, ctx.spaceId);
    expect(swept?.state).toBe("revoked");

    // Soft-deleted first, because `/purge` refuses a row that is not — a rule
    // this guard has nothing to do with, and one that answers with the same
    // 400. Purging directly would pass or fail for the wrong reason. The
    // state that counts is the type's own soft-delete state, which the store
    // derives per type: `revoked` here, never `trashed`.
    const purgeable = await seedConnection({
      kind: "integration",
      status: "revoked",
    });
    const trashed = await request(
      ctx.app,
      "DELETE",
      `/items/${await parentOf(purgeable)}`,
      { key: ctx.spaceKey },
    );
    expect(trashed.status).toBe(200);
    const purged = await request(
      ctx.app,
      "DELETE",
      `/items/${purgeable}/purge`,
      { key: ctx.spaceKey },
    );
    expect(purged.status).toBe(200);
  });

  it("refuses a live app connection and names the grant routes, not the uninstall pipeline", async () => {
    // `system.connection` covers two kinds and only `integration` has a
    // runtime credential minted for it. An `app` connection is an OAuth
    // grant: no uninstall pipeline to be sent to, but two records and the
    // app's tokens hanging off the pair, so removing the row here would
    // leave the tokens live and the consent row standing with nothing
    // listing them. The refusal sends the caller to the grant routes, whose
    // cascade drops all of it first.
    const id = await seedConnection({ kind: "app", status: "active" });

    const deleted = await request(
      ctx.app,
      "DELETE",
      `/items/${await parentOf(id)}`,
      { key: ctx.spaceKey },
    );
    expect(deleted.status).toBe(400);
    const refusal = (await deleted.json()) as {
      error: { code: string; message: string };
    };
    expect(refusal.error.code).toBe("validation_error");
    expect(refusal.error.message).toContain(`DELETE /auth/grants/${id}`);
    expect(refusal.error.message).not.toContain("/uninstall");

    // The row is still there.
    const still = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    expect(still.status).toBe(200);
  });

  it("deletes a revoked app connection freely: the tombstone is history", async () => {
    // Once the grant cascade has run, `status` reads revoked and the row is
    // ordinary history. Nothing is left to strand, and the integration
    // uninstall gate must not fire on it either.
    const id = await seedConnection({
      kind: "app",
      status: "revoked",
      revoked_at: new Date().toISOString(),
    });

    const deleted = await request(
      ctx.app,
      "DELETE",
      `/items/${await parentOf(id)}`,
      { key: ctx.spaceKey },
    );
    expect(deleted.status).toBe(200);
    const swept = await ctx.storage.items.get(id, ctx.spaceId);
    expect(swept?.state).toBe("revoked");
  });

  it("leaves every other type alone", async () => {
    // The guard keys on the type. `core.task` carries a real `status`, so
    // this is an item that looks like a connection to a guard reading
    // properties rather than the type — the mistake worth pinning.
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.task",
        properties: { title: "ordinary", status: "active" },
      },
    });
    const body = (await res.json()) as { item?: { id: string } };
    expect(res.status, JSON.stringify(body)).toBe(201);
    const item = body.item!;

    const deleted = await request(ctx.app, "DELETE", `/items/${item.id}`, {
      key: ctx.spaceKey,
    });
    expect(deleted.status).toBe(200);
  });
});
