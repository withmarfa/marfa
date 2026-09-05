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

async function createConnection(status: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "system.connection",
      properties: {
        kind: "integration",
        status,
        granted_at: new Date().toISOString(),
      },
    },
  });
  // Read once. `await res.text()` inside the assertion message consumes the
  // body, and the `res.json()` after it then throws "Body is unusable" —
  // which reports as a failure of the case rather than of its setup.
  const body = (await res.json()) as { item?: { id: string } };
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body.item!.id;
}

describe("removing a system.connection row", () => {
  it("refuses to delete one that is still live, and says where to go", async () => {
    const id = await createConnection("active");

    const res = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.adminKey,
    });

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
      key: ctx.adminKey,
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
    const id = await createConnection("active");

    const res = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key: ctx.adminKey,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(`/connections/${id}/uninstall`);
    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
    });
    expect(after.status).toBe(200);
  });

  it("allows both once the connection has been revoked", async () => {
    // Uninstall has run by then, so the credentials are gone and the row is
    // ordinary history. Refusing here would strand it instead of protecting
    // anything.
    const deletable = await createConnection("revoked");
    const deleted = await request(ctx.app, "DELETE", `/items/${deletable}`, {
      key: ctx.adminKey,
    });
    expect(deleted.status).toBe(200);

    // Trashed first, because `/purge` refuses an item that is not — a rule
    // this guard has nothing to do with, and one that answers with the same
    // 400. Purging directly would pass or fail for the wrong reason.
    const purgeable = await createConnection("revoked");
    const trashed = await request(ctx.app, "DELETE", `/items/${purgeable}`, {
      key: ctx.adminKey,
    });
    expect(trashed.status).toBe(200);
    const purged = await request(
      ctx.app,
      "DELETE",
      `/items/${purgeable}/purge`,
      { key: ctx.adminKey },
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
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "app",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
    });
    const body = (await res.json()) as { item?: { id: string } };
    expect(res.status, JSON.stringify(body)).toBe(201);
    const id = body.item!.id;

    const deleted = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.adminKey,
    });
    expect(deleted.status).toBe(400);
    const refusal = (await deleted.json()) as {
      error: { code: string; message: string };
    };
    expect(refusal.error.code).toBe("validation_error");
    expect(refusal.error.message).toContain(`DELETE /auth/grants/${id}`);
    expect(refusal.error.message).not.toContain("/uninstall");
  });

  it("deletes a revoked app connection freely: the tombstone is history", async () => {
    // Once the grant cascade has run, `status` reads revoked and the row is
    // ordinary history. Nothing is left to strand, and the integration
    // uninstall gate must not fire on it either.
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "app",
          status: "revoked",
          granted_at: new Date().toISOString(),
          revoked_at: new Date().toISOString(),
        },
      },
    });
    const body = (await res.json()) as { item?: { id: string } };
    expect(res.status, JSON.stringify(body)).toBe(201);

    const deleted = await request(
      ctx.app,
      "DELETE",
      `/items/${body.item!.id}`,
      { key: ctx.adminKey },
    );
    expect(deleted.status).toBe(200);
  });

  it("leaves every other type alone", async () => {
    // The guard keys on the type. `core.task` carries a real `status`, so
    // this is an item that looks like a connection to a guard reading
    // properties rather than the type — the mistake worth pinning.
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.task",
        properties: { title: "ordinary", status: "active" },
      },
    });
    const body = (await res.json()) as { item?: { id: string } };
    expect(res.status, JSON.stringify(body)).toBe(201);
    const item = body.item!;

    const deleted = await request(ctx.app, "DELETE", `/items/${item.id}`, {
      key: ctx.adminKey,
    });
    expect(deleted.status).toBe(200);
  });
});
