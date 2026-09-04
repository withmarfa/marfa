/**
 * A proxied call must not hold a pooled connection across the upstream
 * request.
 *
 * `/connections/:id/proxy/*` awaits a third party mid-handler. Wrapped in
 * the request-wide RLS transaction, that wait is spent holding one of the
 * web container's three application connections, so three slow proxied
 * calls are the whole tier's concurrency and everything else queues
 * behind somebody else's API.
 *
 * **What is observed, and why it is the connection rather than the
 * clock.** Both tests act from inside the stubbed upstream call, which is
 * the one moment the handler is provably parked on the network. The first
 * asks Postgres, through `pg_stat_activity`, how many application-pool
 * backends are sitting inside an open transaction right then; the second
 * asks whether an unrelated space-scoped request can still be served
 * against a pool with one connection in it. Neither measures elapsed
 * time, so neither reports on how busy this machine is: a held connection
 * is held whether the box is idle or saturated, and a released one is
 * released just as unconditionally.
 *
 * **The exemption is only half the change, and this file pins the other
 * half.** Taking the route out of the transaction wrapper without fencing
 * its phases would leave every read running as the connection owner with
 * no `marfa.space_id` set — faster, and reading every space. The last
 * test holds that line: another space's connection id must still 404
 * through the proxy route.
 *
 * Postgres only. SQLite has no pool to exhaust (`@libsql/client`, one
 * client) and no RLS, and the middleware returns early for it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { pgRequestContext } from "../storage/pg/request-context.js";
import { encryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";
import type { Storage } from "../storage/interface.js";

const isPg = (process.env.DB_DIALECT ?? "sqlite") === "pg";

/**
 * Application-pool backends currently inside an open transaction.
 *
 * `state = 'idle in transaction'` is Postgres's own account of a backend
 * that has begun a transaction and is not running a statement — exactly
 * the shape a handler parked on `fetch()` inside `db.transaction` leaves
 * behind. The reader's own backend is running this query and so reports
 * `active`, which keeps it out of its own count.
 *
 * Scoped to this file's cloned database and to the application pool by
 * its `application_name` suffix, so a sibling test file's connections and
 * this process's own session and lock pools cannot be mistaken for the
 * one under test.
 *
 * Deliberately NOT issued through Drizzle. The storage proxy consults an
 * `AsyncLocalStorage`, and the transaction this is trying to see would be
 * the very one it got substituted onto — the observation would move the
 * backend to `active` and report zero however the code behaves.
 */
async function openAppPoolTransactions(storage: Storage): Promise<number> {
  const pg = storage as unknown as {
    __pgClient: (q: string, p?: unknown[]) => Promise<unknown[]>;
  };
  const rows = (await pg.__pgClient(
    `SELECT count(*)::int AS n
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name LIKE '%:app'
        AND state = 'idle in transaction'`,
  )) as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** A space-bound `space_admin` key, which is what makes RLS engage. */
async function mintSpaceKey(storage: Storage, space: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_proxypool_${suffix}`;
  await storage.keys.create(
    {
      label: `proxy-pool-${suffix}`,
      source: `proxy-pool-${suffix}`,
      role: "space_admin",
      type_permissions: { "*": "write" },
      default_tier: "library",
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    space,
  );
  return raw;
}

/**
 * Seed a proxy-ready connection directly through storage.
 *
 * Storage calls from a test carry no request context, so they run as the
 * connection owner and can place rows in a space the caller does not
 * hold. That is what lets the cross-space test below own one space and
 * probe another.
 */
async function seedConnection(
  storage: Storage,
  space: string,
): Promise<string> {
  const credential = await storage.items.create(
    {
      type: "system.credential",
      properties: {
        label: "proxy-pool-cred",
        kind: "oauth_token",
        oauth_provider_config: {
          upstream_base_url: "https://upstream.test",
          oauth_token_url: "https://upstream.test/oauth/token",
          oauth_client_id: "test-client",
        },
        secret_encrypted: encryptSecret(
          "test-secret",
          SECRET_INFO.connectionOauthToken,
        ),
      },
    },
    space,
  );
  const connection = await storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: "acme.demo",
        credential_ref: credential.id,
      },
    },
    space,
  );
  await storage.connectionOauthTokens.upsert({
    connection_id: connection.id,
    space_id: space,
    access_token_encrypted: encryptSecret(
      "access-original",
      SECRET_INFO.connectionOauthToken,
    ),
    refresh_token_encrypted: encryptSecret(
      "refresh-original",
      SECRET_INFO.connectionOauthToken,
    ),
    // Well outside the proactive-refresh leeway, so the happy path makes
    // exactly one upstream call and the observation below is unambiguous
    // about which one it was taken during.
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    scopes: ["read", "write"],
  });
  return connection.id;
}

describe.skipIf(!isPg)("a proxied call and the connection pool", () => {
  describe("the pool during the upstream call", () => {
    let ctx: TestContext;
    let spaceKey: string;
    let connectionId: string;
    let realFetch: typeof globalThis.fetch;
    const space = `space-proxy-pool-${Math.random().toString(36).slice(2, 8)}`;

    beforeAll(async () => {
      ctx = await createTestContext({ rlsEnforce: true });
      realFetch = globalThis.fetch;
      spaceKey = await mintSpaceKey(ctx.storage, space);
      connectionId = await seedConnection(ctx.storage, space);
    });

    afterAll(async () => {
      globalThis.fetch = realFetch;
      await ctx.cleanup();
    });

    it("holds no application-pool transaction while the upstream call is in flight", async () => {
      let openDuringUpstream = -1;
      globalThis.fetch = () => {
        // Inside the stub, the handler is suspended on the network. What
        // the database reports about the pool here is what it would
        // report for however long the upstream took to answer.
        return openAppPoolTransactions(ctx.storage).then((n) => {
          openDuringUpstream = n;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        });
      };

      const res = await request(
        ctx.app,
        "GET",
        `/connections/${connectionId}/proxy/things`,
        { key: spaceKey },
      );

      expect(res.status).toBe(200);
      expect(openDuringUpstream).toBe(0);
    });

    it("still fences its reads to the caller's space", async () => {
      // The other half of the exemption. An unfenced handler would find
      // this connection through the owner connection and proxy for it.
      const otherSpace = `space-proxy-other-${Math.random().toString(36).slice(2, 8)}`;
      const otherConnectionId = await seedConnection(ctx.storage, otherSpace);

      let upstreamCalls = 0;
      globalThis.fetch = () => {
        upstreamCalls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      };

      const res = await request(
        ctx.app,
        "GET",
        `/connections/${otherConnectionId}/proxy/things`,
        { key: spaceKey },
      );

      expect(res.status).toBe(404);
      expect(upstreamCalls).toBe(0);
    });
  });

  describe("against a pool of one", () => {
    let ctx: TestContext;
    let spaceKey: string;
    let connectionId: string;
    let realFetch: typeof globalThis.fetch;
    const space = `space-proxy-one-${Math.random().toString(36).slice(2, 8)}`;

    beforeAll(async () => {
      // One connection, so "the proxy is holding one" and "nothing else
      // can be served" are the same statement. At the default of three a
      // held connection leaves two, and the assertion below would pass
      // whether or not the fix is present.
      ctx = await createTestContext({ rlsEnforce: true, dbPoolSize: 1 });
      realFetch = globalThis.fetch;
      spaceKey = await mintSpaceKey(ctx.storage, space);
      connectionId = await seedConnection(ctx.storage, space);
    });

    afterAll(async () => {
      globalThis.fetch = realFetch;
      await ctx.cleanup();
    });

    it("serves an unrelated space-scoped request while a proxied call is parked upstream", async () => {
      let unrelatedStatus = 0;
      globalThis.fetch = () =>
        // `exit` is what makes this an unrelated request rather than a
        // nested one. A real second caller arrives on its own connection
        // with its own async context; issued inside this one, it would
        // inherit the proxy request's storage context and open a
        // savepoint on the connection it is supposed to be competing
        // for — which succeeds whatever the pool is doing, and would
        // report a fix that is not there.
        pgRequestContext
          .exit(() =>
            request(ctx.app, "GET", "/items?limit=1", { key: spaceKey }),
          )
          .then((res) => {
            unrelatedStatus = res.status;
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          });

      const res = await request(
        ctx.app,
        "GET",
        `/connections/${connectionId}/proxy/things`,
        { key: spaceKey },
      );

      expect(res.status).toBe(200);
      expect(unrelatedStatus).toBe(200);
    });
  });
});
