import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPgTestStorage,
  createTestContext,
  request,
  seedOauthBearer,
  waitForAudit,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { Storage } from "../storage/interface.js";
import { hashApiKey } from "../middleware/auth.js";
import { ensureBootstrapSecret } from "../auth/bootstrap-secret.js";
import { KeyResponseSchema } from "./_schemas.js";
import { extensionLabelOf } from "../auth/extension-label.js";
import { generateId, SPACE_PERMISSIONS } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createKey(overrides: Record<string, unknown> = {}): Promise<{
  id: string;
  key: string;
  source: string;
}> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.spaceKey,
    body: {
      label: `subject-${suffix}`,
      source: `subject-${suffix}`,
      default_tier: "feed",
      type_permissions: { "core.note": "read" },
      extension_permissions: {},
      edge_permissions: {},
      ...overrides,
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    id: string;
    key: string;
    source: string;
  };
  return body;
}

describe("the key a create route returns", () => {
  // Two tests, because the defect has two halves and one assertion cannot
  // reach both. This one pins the HANDLER: an expiry is settable only through
  // `createRuntimeCredential`, which no route reaches, so a key minted through
  // a door has none by construction and the response must not carry the field.
  //
  // It says nothing about the declaration. Re-adding `expires_at` to the
  // shared schema leaves this green, because a declaration does not put a
  // field into a response — which is the whole reason the two drifted apart
  // in the first place. The declaration is pinned separately, below.
  it("carries no expiry, because a create route cannot mint one", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: `expiry-${suffix}`,
        source: `expiry-${suffix}`,
        default_tier: "feed",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    // The field itself, not a falsy value: a response sending `null` would
    // satisfy an optional-chained read and still contradict the declaration.
    expect(
      Object.hasOwn(body, "expires_at"),
      "a create response carried an expiry field, so the declaration and the handler disagree about what a minted key can have",
    ).toBe(false);
    // A control, so the assertion above cannot pass on an empty body.
    expect(body.id).toBeTruthy();
    expect(body.key).toBeTruthy();
  });
});

describe("the declaration a create route publishes", () => {
  // The other half. This one reddens when the schema regains a field the
  // handler cannot fill, which is the regression the consolidation exists to
  // prevent and which the response-body test above cannot see.
  //
  // Asserted against the schema rather than the generated specification so it
  // fails at the declaration rather than three steps downstream of it, where
  // the message would be about a large JSON artifact instead of about a line
  // somebody wrote.
  it("does not promise an expiry the handler cannot send", () => {
    const shape = Object.keys(KeyResponseSchema.shape);
    expect(
      shape,
      "the create response declares an expiry, which no key a create route can mint will ever carry, so the published specification promises generated clients a property that cannot arrive",
    ).not.toContain("expires_at");
    // A control: a wrong import or an emptied schema would otherwise satisfy
    // the assertion above by containing nothing at all.
    expect(shape).toContain("created_at");
    expect(shape).toContain("last_used_at");
  });
});

describe("PATCH /keys/{id}", () => {
  it("updates label, permissions, and defaults in place", async () => {
    const { id, source } = await createKey();

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.spaceKey,
      body: {
        label: "renamed",
        default_tier: "library",
        type_permissions: { "core.note": "write" },
        extension_permissions: { "my-app.prefs": "read" },
        edge_permissions: { "parent-of": "write" },
      },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;

    expect(updated.id).toBe(id);
    expect(updated.label).toBe("renamed");
    // source is immutable — it must not have changed
    expect(updated.source).toBe(source);
    expect(updated.default_tier).toBe("library");
    expect(updated.type_permissions).toEqual({ "core.note": "write" });
    expect(updated.extension_permissions).toEqual({ "my-app.prefs": "read" });
    expect(updated.edge_permissions).toEqual({ "parent-of": "write" });
  });

  it("leaves untouched fields alone on a partial patch", async () => {
    const { id } = await createKey({
      label: "before",
      default_tier: "feed",
      type_permissions: { "core.note": "read" },
    });

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.spaceKey,
      body: { label: "after" },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;

    expect(updated.label).toBe("after");
    expect(updated.default_tier).toBe("feed");
    expect(updated.type_permissions).toEqual({ "core.note": "read" });
  });

  it("returns 403 for a caller that does not hold `space.keys`", async () => {
    const { id } = await createKey();
    const suffix = Math.random().toString(36).slice(2, 10);
    const narrow = `marfa_k1_patcher_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `patcher-narrow-${suffix}`,
        source: `patcher-narrow-${suffix}`,
        // The whole point of the fixture: it reaches content and nothing
        // administrative, which is what the keys doors now ask about. Not an
        // operator key either — that one reaches these doors by being the
        // operator key, and a fixture carrying the flag would prove the
        // carve-out rather than the permission.
        space_permissions: [],
        type_permissions: { "*": "read" },
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(narrow, TEST_API_KEY_SALT),
      // Bound to the instance's space, because an unbound non-operator key is
      // the one shape the row constraint refuses: a space-less credential is
      // the operator key and nothing else.
      ctx.spaceId,
    );

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: narrow,
      body: { label: "nope" },
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when attempting to change the immutable `source`", async () => {
    const { id } = await createKey();

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.spaceKey,
      body: { source: "something-else" },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/source.*immutable/i);
  });

  // The one response here that can carry an expiry, and it declared the field
  // without ever sending it. Any key is patchable, a runtime credential
  // included, and those always carry a hard lifetime bound — so a caller
  // updating a credential's permissions got the credential back with the one
  // field saying when it stops working missing from it.
  //
  // Minted through the store, because `createRuntimeCredential` is the only
  // mint that can stamp an expiry and no route reaches it. A key made through
  // a create door has none by construction, so patching one of those would
  // leave this green whatever the handler did.
  it("returns the expiry the stored row carries", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const minted = await ctx.storage.keys.createRuntimeCredential(
      {
        label: `runtime-${suffix}`,
        source: `runtime-${suffix}`,
        type_permissions: {},
        connection_id: `conn-${suffix}`,
        expires_at: expiresAt,
        item_source: null,
      },
      hashApiKey(`marfa_k1_runtime_${suffix}`, TEST_API_KEY_SALT),
      ctx.spaceId,
    );
    expect(minted.expires_at).toBe(expiresAt);

    const res = await request(ctx.app, "PATCH", `/keys/${minted.id}`, {
      key: ctx.spaceKey,
      body: { label: "renamed runtime" },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;

    expect(updated.label).toBe("renamed runtime");
    // Against the stored row rather than against the literal alone, so the
    // assertion is that the response says what the key says.
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.expires_at).toBe(expiresAt);
    expect(updated.expires_at).toBe(stored?.expires_at);
  });

  it("returns 404 for an unknown key id", async () => {
    // Valid UUIDv7 shape, guaranteed not to exist in the store.
    const ghostId = "00000000-0000-7000-8000-000000000000";
    const res = await request(ctx.app, "PATCH", `/keys/${ghostId}`, {
      key: ctx.spaceKey,
      body: { label: "ghost" },
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /keys/{id} — a space-less target", () => {
  /** A spare credential at the instance tier: no space, and nothing held. */
  async function mintSpacelessKey(suffix: string): Promise<string> {
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.operatorKey,
      body: {
        label: `spaceless-patch-${suffix}`,
        source: `spaceless-patch-${suffix}`,
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.space_id ?? null).toBeNull();
    return minted.id;
  }

  // The control, so the case below cannot pass by the guard having been
  // removed rather than by the write having been forced empty.
  it("refuses a request naming reach", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const id = await mintSpacelessKey(suffix);

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.operatorKey,
      body: { type_permissions: { "core.note": "read" } },
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/POST \/admin\/spaces\/\{id\}\/keys/);
  });

  // **A body of denials is a non-empty map that names nothing.** The guard
  // skips a `none` entry, exactly as the creator ceiling does, so such a body
  // reached the store and the store wrote `{"core.note":"none"}` onto a row
  // the constraint says holds `{}`. The caller read a database refusal where
  // a route answer belongs. The mint forces the same families empty for the
  // same reason and this is that door a moment later, so it forces too.
  //
  // `type_permissions` is the one family the body schema lets a `none` into,
  // so it is the one that reaches the store. The forcing is written across
  // all five because the guard is: a schema that admitted `none` on a second
  // family would otherwise reopen this on that family alone.
  it("writes a denial-only map empty rather than sending it at the row constraint", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const id = await mintSpacelessKey(suffix);

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.operatorKey,
      body: {
        label: `renamed-${suffix}`,
        type_permissions: { "core.note": "none" },
      },
    });
    expect(res.status).toBe(200);

    const stored = await ctx.storage.keys.get(id);
    expect(stored?.type_permissions).toEqual({});
    // The rest of the edit still lands: forcing the family empty is not a
    // refusal of the request, and a caller renaming a key gets the rename.
    expect(stored?.label).toBe(`renamed-${suffix}`);
    // Families the body never named are left alone rather than rewritten.
    expect(stored?.edge_permissions).toEqual({});
    expect(stored?.space_permissions).toEqual([]);
  });
});

describe("DELETE /keys/{id} — the answer is what happened", () => {
  /** How many `key.revoke` rows the audit log holds for one key id. */
  async function revokeAudits(id: string): Promise<number> {
    const page = await ctx.storage.audit.list({
      action: "key.revoke",
      resource_type: "key",
      resource_id: id,
    });
    return page.data.length;
  }

  /**
   * Revoke a freshly created key and wait for its audit row, so a later
   * count is read after the writer has demonstrably drained rather than
   * after a guess at how long it takes. Both rows are issued on the same
   * store in call order, so a row the earlier request had in flight has
   * landed by the time this one has.
   */
  async function auditedRevoke(): Promise<void> {
    const { id } = await createKey();
    const res = await request(ctx.app, "DELETE", `/keys/${id}`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const rows = await waitForAudit(
      () => revokeAudits(id),
      (count) => count >= 1,
    );
    expect(rows).toBe(1);
  }

  // **The operator key skips the space fence, so nothing stood between it and
  // a revoke that did nothing.** A space-bound caller is refused earlier by
  // the cross-space 404: `keys.get` drops revoked rows, so a revoked key and
  // an unknown one both read as a miss there. The operator carries no space,
  // takes neither branch, and reached the store with any id at all — a
  // production key was revoked twice by the wrong id and answered ok both
  // times, and the row read back unchanged is the only reason anyone noticed.
  it("refuses an unknown id rather than answering ok", async () => {
    const unknown = generateId();

    const res = await request(ctx.app, "DELETE", `/keys/${unknown}`, {
      key: ctx.operatorKey,
    });
    expect(
      res.status,
      "a revoke that changed no row answered success, so somebody believing it walks away with a live credential they think is dead",
    ).toBe(404);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("api_key_not_found");

    await auditedRevoke();
    expect(
      await revokeAudits(unknown),
      "an audit row records a revocation that never happened",
    ).toBe(0);
  });

  it("tells the operator a key was already revoked rather than answering ok", async () => {
    const { id } = await createKey();

    const first = await request(ctx.app, "DELETE", `/keys/${id}`, {
      key: ctx.operatorKey,
    });
    expect(first.status).toBe(200);
    await waitForAudit(
      () => revokeAudits(id),
      (count) => count >= 1,
    );

    const second = await request(ctx.app, "DELETE", `/keys/${id}`, {
      key: ctx.operatorKey,
    });
    expect(
      second.status,
      "a second revoke of the same key answered success, which reads exactly like a revoke that worked",
    ).toBe(404);
    const err = (await second.json()) as {
      error: { code: string; message: string };
    };
    expect(err.error.code).toBe("api_key_not_found");
    // One status and one code for both misses, because a caller must not be
    // able to tell an id nobody holds from one in another space. The message
    // is what separates them for the caller who does hold the key, and an
    // operator reaches every space, so it costs nothing there.
    expect(err.error.message).toMatch(/already revoked/i);

    await auditedRevoke();
    expect(
      await revokeAudits(id),
      "the second revoke wrote an audit row for a revocation that changed nothing",
    ).toBe(1);
  });

  // The control on both cases above, so neither can pass by the route having
  // stopped revoking anything at all.
  it("still answers ok, and audits, when a row changes", async () => {
    const { id } = await createKey();

    const res = await request(ctx.app, "DELETE", `/keys/${id}`, {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await waitForAudit(
      () => revokeAudits(id),
      (count) => count >= 1,
    );
    expect(rows).toBe(1);
    expect(await ctx.storage.keys.get(id)).toBeNull();
  });
});

describe("bootstrap sentinel", () => {
  // Builds a fresh app with NO existing key and NO sentinel set —
  // mirrors a brand-new installation. Dialect-aware: under
  // PG: cloned from the test-template, so tables are empty and the
  // `bootstrapped` sentinel isn't set — bootstrap path can fire cleanly.
  // SQLite: fresh tmp DB. Cannot use `createTestContext` because that
  // pre-creates the bootstrap credential and stamps the bootstrapped sentinel.
  async function freshApp(overrides?: {
    authMode?: "keys" | "hosted";
  }): Promise<{
    app: ReturnType<typeof createApp>;
    storage: Storage;
    /**
     * The one-time secret the first mint must present, obtained the way boot
     * obtains it. **Generated here rather than by the app**, because these
     * tests build the app directly and never run the boot path that prints
     * it — and a fixture that skipped the secret would be testing a door the
     * product no longer has.
     */
    bootstrapSecret: string;
    /** Removed by the caller alongside `storage.close()`; nothing else
     *  removes it. */
    tmpDir: string;
  }> {
    const dialect = process.env.DB_DIALECT ?? "sqlite";
    let storage: Storage;
    let blobPath: string;
    let tmpDir: string;
    if (dialect === "pg") {
      const pg = await createPgTestStorage();
      storage = pg.storage;
      // pg.cleanup leaks here intentionally — `freshApp` doesn't have
      // a returned-cleanup contract with its callers; the leaked clone
      // is mopped up by the next test-run's dropStaleClones pass.
      tmpDir = mkdtempSync(join(tmpdir(), "marfa-bootstrap-pg-"));
      blobPath = join(tmpDir, "blobs");
    } else {
      tmpDir = mkdtempSync(join(tmpdir(), "marfa-bootstrap-"));
      storage = await createSqliteStorage(join(tmpDir, "test.db"));
      blobPath = join(tmpDir, "blobs");
    }
    const blobBackend = new FilesystemBlobBackend(blobPath);
    const app = createApp(storage, blobBackend, {
      port: 0,
      storageDialect: dialect as "sqlite" | "pg",
      sqlitePath: "",
      databaseUrl: "",
      blobPath,
      blobBackend: "fs",
      maxBlobSize: 50 * 1024 * 1024,
      maxRequestBytes: 1_048_576,
      s3Bucket: "",
      s3Region: "us-east-1",
      s3Endpoint: "",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      apiKeySalt: "test-salt",
      corsOrigins: [],
      cdnBaseUrl: "",
      authMode: "keys",
      rateLimitEnabled: false,
      enableHsts: false,
      auditRetentionDays: 90,
      auditCleanupIntervalMs: 86_400_000,
      eventLogRetentionHours: 168,
      versionThinningIntervalMs: 3_600_000,
      versionRecentDays: 30,
      versionDailySnapshotDays: 90,
      versionWeeklySnapshotDays: 365,
      versionMaxVersions: 500,
      trashRetentionDays: 60,
      trashPurgeIntervalMs: 3_600_000,
      errorWebhookUrl: "",
      trustedProxyCidrs: [],
      authBaseUrl: "http://localhost:0",
      authAllowSignup: true,
      seedStarterContent: false,
      authSecret: "test-auth-secret",
      oidcProviders: [],
      rateLimitDefaultLimit: 1000,
      rateLimitWindowMs: 60_000,
      mcpEnabled: false,
      ...overrides,
    });
    const bootstrapSecret = await ensureBootstrapSecret(storage);
    return { app, storage, bootstrapSecret, tmpDir };
  }

  it("admits the first unauthenticated POST /keys as bootstrap", async () => {
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      const res = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: {
          label: "first-admin",
          source: "first-admin",
          default_tier: "feed",
          type_permissions: { "*": "write" },
          extension_permissions: {},
          edge_permissions: {},
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { is_operator: boolean; id: string };
      // The first credential on an instance is the operator key, whatever the
      // request asked for.
      expect(body.is_operator).toBe(true);
      // Sentinel must now be stamped.
      const stamped = await storage.settings.get("bootstrapped");
      expect(stamped).toBe("true");

      // Bootstrap mint emits the distinct `key.bootstrap` action, not
      // `key.create`, so operators can identify the first-mint event
      // in audit logs without ambiguity.
      const audits = await waitForAudit(
        () => storage.audit.list({ action: "key.bootstrap" }),
        (r) => r.data.some((row) => row.resource_id === body.id),
      );
      const row = audits.data.find((r) => r.resource_id === body.id);
      expect(row).toBeTruthy();
      expect(row?.action).toBe("key.bootstrap");
      expect(row?.resource_type).toBe("key");
      // Bootstrap mint has no calling credential — `key_id` is null.
      expect(row?.key_id).toBeNull();

      // Negative: no `key.create` row for this id.
      const createRows = await storage.audit.list({ action: "key.create" });
      expect(createRows.data.some((r) => r.resource_id === body.id)).toBe(
        false,
      );
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("provisions the keys-mode space and a key that works in it", async () => {
    // **The operator key is not a working key**, so a self-host handed only
    // that has a credential it cannot use: no space, no permissions, because
    // running the instance sits outside the permission model. The design's
    // setup story is mint the operator key, create a space, mint a key into
    // it, work with that key — and this is that story shipped rather than
    // written down.
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      const res = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        is_operator: boolean;
        space?: { id: string; name: string | null };
        space_key?: {
          key: string;
          is_operator: boolean;
          space_permissions?: string[];
        };
      };

      expect(body.is_operator).toBe(true);
      expect(body.space?.id).toBeTruthy();
      expect(body.space_key?.key).toBeTruthy();
      // The working key is an ordinary credential holding the whole space.
      expect(body.space_key?.is_operator).toBe(false);
      expect(body.space_key?.space_permissions).toEqual(
        expect.arrayContaining(["space.keys", "space.settings"]),
      );

      // The row is bound to the space that was just made.
      const keys = await storage.keys.list();
      const spaceKey = keys.find((k) => k.source === "default-space");
      expect(spaceKey?.space_id).toBe(body.space?.id);

      // **And it works.** A key bound to a space that holds nothing it can
      // reach would satisfy every assertion above and be useless, so the
      // round trip is the assertion that matters.
      const created = await request(app, "POST", "/items", {
        key: body.space_key?.key ?? "",
        body: { type: "core.note", properties: { body: "hello" } },
      });
      expect(created.status).toBe(201);
      const listed = await request(app, "GET", "/items?type=core.note", {
        key: body.space_key?.key ?? "",
      });
      expect(listed.status).toBe(200);
      const page = (await listed.json()) as { data: unknown[] };
      expect(page.data).toHaveLength(1);
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("takes no content reach on bootstrap, whatever the body asks for", async () => {
    // **The operator key holds nothing on any axis.** The space permissions
    // are forced empty and the clamp refuses anything requested, but the four
    // content maps used to come straight off the body — and bootstrap is
    // unauthenticated with no creator to clamp against. A space-less
    // credential applies no space predicate at all, so `*: write` here is
    // read and write over every space at once, in the one row shape the
    // constraint exists to make unwritable.
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp({
      authMode: "hosted",
    });
    try {
      const res = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: {
          label: "greedy",
          source: "greedy",
          type_permissions: { "*": "write" },
          edge_permissions: { "*": "write" },
          metadata_permissions: { "*": "write" },
          profile_permissions: { "*": "write" },
          extension_permissions: { "*": "write" },
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        key: string;
        is_operator: boolean;
        type_permissions: Record<string, string>;
        edge_permissions: Record<string, string>;
        metadata_permissions: Record<string, string>;
        profile_permissions: Record<string, string>;
        extension_permissions: Record<string, string>;
      };
      expect(body.is_operator).toBe(true);
      expect(body.type_permissions).toEqual({});
      expect(body.edge_permissions).toEqual({});
      expect(body.metadata_permissions).toEqual({});
      expect(body.profile_permissions).toEqual({});
      expect(body.extension_permissions).toEqual({});

      // The stored row, not just the response: a map echoed empty and
      // persisted wide would satisfy everything above.
      const stored = (await storage.keys.list()).find(
        (k) => k.source === "greedy",
      );
      expect(stored?.type_permissions).toEqual({});

      // And it cannot write. This is the assertion with teeth — a map is
      // only interesting because of what it admits, and an echoed-empty map
      // over a stored wide one would pass every check above.
      const written = await request(app, "POST", "/items", {
        key: body.key,
        body: { type: "core.note", properties: { body: "hello" } },
      });
      expect(written.status).toBe(403);
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps the claim once a credential exists, whatever fails after it", async () => {
    // **The release is only safe while there is nothing to protect.** An
    // instance that has minted its operator key and then failed must not
    // reopen unauthenticated minting: a stranger winning the reopened window
    // would hold an operator key, and an operator key reaches
    // `POST /admin/spaces/{id}/keys`, which is deliberately unclamped and
    // hands out the whole of a space. That is a takeover where the problem
    // being solved was a lockout.
    //
    // The failure is injected after the key insert, which is the half the
    // release-on-any-failure shape got wrong.
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      const list = storage.spaces!.list.bind(storage.spaces);
      storage.spaces!.list = () => {
        throw new Error("storage is having a moment");
      };

      const res = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "first-admin", source: "first-admin" },
      });

      // The operator key is the deliverable and its plaintext lives only in
      // this response, so a convenience failing after it must not take the
      // response with it.
      expect(res.status).toBe(201);
      const body = (await res.json()) as { key: string; space?: unknown };
      expect(body.key).toBeTruthy();
      expect(body.space).toBeUndefined();

      // And the window is shut.
      expect(await storage.settings.get("bootstrapped")).toBe("true");
      storage.spaces!.list = list;
      const second = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "stranger", source: "stranger" },
      });
      expect(second.status).toBe(401);
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps the claim when a failure does reach the release, with a key already minted", async () => {
    // The second lock, tested where the first one is deliberately absent.
    // Nothing in the handler currently throws past the key insert — the
    // provisioning above is caught, and the audit write is fire-and-forget —
    // so this reaches the release the only way left, by making the audit
    // write throw synchronously. The point is not that path; it is that a
    // future step added after the insert cannot reopen the window by failing.
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp({
      authMode: "hosted",
    });
    try {
      storage.audit.log = () => {
        throw new Error("storage is having a moment");
      };

      const res = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(res.status).toBe(500);

      // The key was written before the throw, so the claim stands and the
      // door stays shut even though the caller lost the plaintext.
      expect(await storage.keys.list()).toHaveLength(1);
      expect(await storage.settings.get("bootstrapped")).toBe("true");
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("mints the working key into a space that is already there", async () => {
    // A keys-mode instance migrated from before spaces arrives here with the
    // migration's space in place. Creating a second is refused everywhere
    // downstream, but returning nothing would hand back an operator key and
    // call it setup — and the operator key is not a working key.
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      const existing = await storage.spaces!.create("Already here");

      const res = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        space?: { id: string };
        space_key?: { key: string; is_operator: boolean };
      };
      expect(body.space?.id).toBe(existing.id);
      expect(body.space_key?.is_operator).toBe(false);
      expect(await storage.spaces!.list()).toHaveLength(1);

      // And it works in that space.
      const created = await request(app, "POST", "/items", {
        key: body.space_key?.key ?? "",
        body: { type: "core.note", properties: { body: "hello" } },
      });
      expect(created.status).toBe(201);
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("gives the one-shot claim back when the mint itself fails", async () => {
    // The claim has to come first or two concurrent callers both mint, and it
    // is also what stops the middleware admitting an unauthenticated mint. A
    // throw after it used to leave a sentinel with no operator key behind it:
    // an instance nobody can reach and no route can repair. The failure is
    // injected at the key insert because that is the write, and any of the
    // several after it fail the same way.
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      const create = storage.keys.create.bind(storage.keys);
      storage.keys.create = () => {
        throw new Error("storage is having a moment");
      };

      const failed = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(failed.status).toBe(500);
      expect(await storage.settings.get("bootstrapped")).toBeNull();

      // The premise, and the point: the retry works, **presenting the same
      // secret**. Releasing the claim while spending the secret would be no
      // retry at all — the door would be open and the only thing that opens
      // it would be gone.
      storage.keys.create = create;
      const retried = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(retried.status).toBe(201);
      expect(await storage.settings.get("bootstrapped")).toBe("true");
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("provisions nothing in hosted mode, where a space belongs to an account", async () => {
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp({
      authMode: "hosted",
    });
    try {
      const res = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { space?: unknown };
      expect(body.space).toBeUndefined();
      // A stray space owned by nobody is the thing to avoid here.
      expect(await storage.spaces?.list()).toEqual([]);
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses the first mint without the secret this instance printed", async () => {
    // **The window this closes.** A fresh instance accepts one unauthenticated
    // write, and until the secret existed that door was open to whoever
    // reached the port first between `up` and the operator's first call.
    const { app, storage, tmpDir } = await freshApp();
    try {
      const res = await request(app, "POST", "/keys", {
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(res.status).toBe(401);
      // And the one-shot claim is intact, so the real operator can still
      // bootstrap. A refused attempt that burned it would lock the instance
      // out for good.
      expect(await storage.settings.get("bootstrapped")).toBeNull();
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses a secret that is not this instance's", async () => {
    const { app, storage, tmpDir } = await freshApp();
    try {
      const res = await request(app, "POST", "/keys", {
        key: "not-the-secret",
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(res.status).toBe(401);
      expect(await storage.settings.get("bootstrapped")).toBeNull();
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("consumes the secret, so it cannot mint a second time", async () => {
    // The log line stays on somebody's screen long after the mint. What stops
    // a second use is the claim, and this is the belt beside it: the row is
    // gone the moment the operator key exists.
    //
    // Deleted, not blanked. A blanked row reads as absent to `get` and as an
    // empty string to a comparison, and `bootstrapSecretMatches("", "")` is
    // true — so a request with no `Authorization` header at all presents the
    // empty string and matches. `null` is the one state every reader agrees
    // about.
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      const first = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(first.status).toBe(201);
      expect(await storage.settings.get("bootstrap.secret")).toBeNull();

      const second = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "second", source: "second" },
      });
      expect(second.status).toBe(401);
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns the same secret across a restart before the first mint", async () => {
    // An operator who copied the line and then restarted the container must
    // not find it invalidated. Idempotence is what makes re-printing at every
    // boot safe rather than confusing.
    const { storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      expect(await ensureBootstrapSecret(storage)).toBe(bootstrapSecret);
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("a rejected body does not burn the one-shot bootstrap claim", async () => {
    // The sentinel claim is irreversible. If a request that can never
    // mint consumed it, a single stray field would lock a brand-new
    // instance out of bootstrap permanently.
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      const rejected = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: {
          label: "stray-field",
          source: "stray-field",
          space_id: "some-space",
        },
      });
      expect(rejected.status).toBe(400);
      expect(await storage.settings.get("bootstrapped")).toBeNull();

      // Bootstrap still available to the corrected request.
      const retry = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(retry.status).toBe(201);
      expect(await storage.settings.get("bootstrapped")).toBe("true");
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("operator-issued POST /keys emits `key.create`, not `key.bootstrap`", async () => {
    // Self-contained — bootstrap a fresh app, then use the first key it
    // mints to mint a second on the now-closed (non-bootstrap) branch.
    // Avoids depending on the shared `ctx` because freshApp() tests under
    // PG truncate the shared container, which would wipe the ctx's key and
    // sentinel between tests.
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      const bootstrapRes = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: {
          label: "bootstrap-key",
          source: "bootstrap-key",
          type_permissions: { "*": "write" },
        },
      });
      expect(bootstrapRes.status).toBe(201);
      const bootstrap = (await bootstrapRes.json()) as {
        id: string;
        key: string;
      };

      // Second POST authenticated as the bootstrap credential — this is the
      // non-bootstrap branch (sentinel is now stamped).
      // Naming no reach, because the caller is the operator key: a
      // space-less credential holds nothing and may give nothing, so the
      // body that used to name a type map is refused now. What this case is
      // about is which audit action the non-bootstrap branch writes.
      const followUpRes = await request(app, "POST", "/keys", {
        key: bootstrap.key,
        body: {
          label: "routine-operator-mint",
          source: "routine-operator-mint",
          default_tier: "feed",
        },
      });
      expect(followUpRes.status).toBe(201);
      const followUp = (await followUpRes.json()) as { id: string };

      const audits = await waitForAudit(
        () => storage.audit.list({ action: "key.create" }),
        (r) => r.data.some((row) => row.resource_id === followUp.id),
      );
      const row = audits.data.find((r) => r.resource_id === followUp.id);
      expect(row).toBeTruthy();
      expect(row?.action).toBe("key.create");
      expect(row?.resource_type).toBe("key");
      // Caller is the bootstrap credential — `key_id` is its id.
      expect(row?.key_id).toBe(bootstrap.id);

      // Negative: no `key.bootstrap` row for the second-mint id.
      const bootstrapRows = await storage.audit.list({
        action: "key.bootstrap",
      });
      expect(
        bootstrapRows.data.some((r) => r.resource_id === followUp.id),
      ).toBe(false);
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does NOT re-open bootstrap after every key is revoked", async () => {
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      // First unauthenticated POST succeeds as bootstrap.
      const firstRes = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: {
          label: "first-admin",
          source: "first-admin",
          default_tier: "feed",
          type_permissions: { "*": "write" },
          extension_permissions: {},
          edge_permissions: {},
        },
      });
      expect(firstRes.status).toBe(201);
      const { id: firstId } = (await firstRes.json()) as { id: string };

      // Revoke every key.
      await storage.keys.revoke(firstId);

      // Next unauthenticated POST must be rejected — this is the
      // regression the persistent sentinel prevents.
      const secondRes = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: {
          label: "takeover",
          source: "takeover",
          default_tier: "feed",
          type_permissions: { "*": "write" },
          extension_permissions: {},
          edge_permissions: {},
        },
      });
      expect(secondRes.status).toBe(401);
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("concurrent unauthenticated POST /keys mints exactly one operator key", async () => {
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      const N = 8;
      const bodies = Array.from({ length: N }, (_, i) => ({
        label: `race-${String(i)}`,
        source: `race-${String(i)}`,
        type_permissions: { "*": "write" },
      }));
      const results = await Promise.all(
        bodies.map((body) =>
          request(app, "POST", "/keys", { key: bootstrapSecret, body }),
        ),
      );
      const statuses = results.map((r) => r.status);
      const successes = statuses.filter((s) => s === 201).length;
      const unauthorized = statuses.filter((s) => s === 401).length;
      expect(successes).toBe(1);
      expect(unauthorized).toBe(N - 1);

      // Sentinel must be stamped exactly once.
      const stamped = await storage.settings.get("bootstrapped");
      expect(stamped).toBe("true");

      // **Exactly one operator key**, which is the property. A bootstrap call
      // also provisions the keys-mode space and mints a working key into it,
      // so the store holds two rows and counting rows would have stopped
      // saying anything about the race.
      const keys = await storage.keys.list();
      expect(keys.filter((k) => k.is_operator)).toHaveLength(1);
      expect(keys.filter((k) => !k.is_operator)).toHaveLength(1);
      // And one space, so seven losing callers provisioned nothing.
      expect(await storage.spaces?.list()).toHaveLength(1);
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // The following assertions exercise SQLite-specific introspection
  // (`__sqliteAll`, `runSqliteMigrations`). The PG side is exercised by
  // the production server boot path under `DB_DIALECT=pg` and by the
  // SCHEMA_SQL diff itself; running these on PG would require parallel
  // PG-flavored queries for marginal additional coverage.
  const SKIP_SQLITE_ONLY = (process.env.DB_DIALECT ?? "sqlite") !== "sqlite";

  it.skipIf(SKIP_SQLITE_ONLY)(
    "bootstrap stamps __drizzle_migrations so a follow-up migrate is a no-op (sqlite)",
    async () => {
      const { storage, tmpDir } = (await freshApp()) as unknown as {
        storage: Awaited<ReturnType<typeof createSqliteStorage>>;
        tmpDir: string;
      };
      try {
        const rows = (await storage.__sqliteAll(
          "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC",
        )) as { hash: string; created_at: number }[];
        // At least one stamped row exists, hashes are non-empty, timestamps
        // are positive — the row shape Drizzle's migrator writes after each
        // applied migration. Drizzle's skip-decision is "if any row's
        // created_at >= migration.folderMillis, skip", so a single row with
        // the latest timestamp would suffice; we stamp every entry to keep
        // the table identical to a normally-migrated DB.
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash))).toBe(true);
        expect(rows.every((r) => r.created_at > 0)).toBe(true);
      } finally {
        await storage.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(SKIP_SQLITE_ONLY)(
    "bootstrap then `pnpm migrate` is a no-op — no DROP errors (sqlite)",
    async () => {
      // Bootstrap a fresh DB at a known path, close it, then drive Drizzle's
      // migrate runner against the same path. Pre-fix, the runner replays
      // 0000 → latest and several DROP/ALTER migrations error against
      // tables / objects the bootstrap shape never had. Post-fix the runner
      // sees stamped rows and short-circuits.
      const tmpDir = mkdtempSync(join(tmpdir(), "marfa-bootstrap-migrate-"));
      const dbPath = join(tmpDir, "bootstrap-then-migrate.db");
      const storage = await createSqliteStorage(dbPath);
      const before = (await storage.__sqliteAll(
        "SELECT COUNT(*) AS n FROM __drizzle_migrations",
      )) as { n: number }[];
      const beforeCount = before[0]?.n ?? 0;
      expect(beforeCount).toBeGreaterThan(0);
      await storage.close();

      const { runSqliteMigrations } = await import("../storage/migrate.js");
      await expect(runSqliteMigrations(dbPath)).resolves.toBeUndefined();

      const reopened = await createSqliteStorage(dbPath);
      try {
        const after = (await reopened.__sqliteAll(
          "SELECT COUNT(*) AS n FROM __drizzle_migrations",
        )) as { n: number }[];
        expect(after[0]?.n ?? 0).toBe(beforeCount);
      } finally {
        await reopened.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(SKIP_SQLITE_ONLY)(
    "bootstrap creates idx_api_keys_connection_id (sqlite)",
    async () => {
      const { storage, tmpDir } = (await freshApp()) as unknown as {
        storage: Awaited<ReturnType<typeof createSqliteStorage>>;
        tmpDir: string;
      };
      try {
        const indexes = (await storage.__sqliteAll(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_api_keys_connection_id'",
        )) as { name: string }[];
        expect(indexes.length).toBe(1);

        // EXPLAIN must show the index is consulted on the runtime-credential
        // lookup path. SQLite's planner reports `USING INDEX <name>` when it
        // chooses an index; partial indexes need the WHERE predicate to match
        // for the planner to pick them.
        const plan = (await storage.__sqliteAll(
          "EXPLAIN QUERY PLAN SELECT * FROM api_keys WHERE connection_id = 'x'",
        )) as { detail: string }[];
        const usesIndex = plan.some((row) =>
          row.detail.includes("idx_api_keys_connection_id"),
        );
        expect(usesIndex).toBe(true);
      } finally {
        await storage.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});

describe("POST /keys — a session mints, clamped to its own grant", () => {
  // The blanket refusal that used to stand here did two jobs: it withheld the
  // permission, and it prevented the escalation a mint makes possible. Both
  // still hold, through two things that can fail independently — the
  // space permission gate and the breadth clamp — so each gets its own case
  // rather than one test standing for both.
  let hostedCtx: TestContext;
  let spaceId: string;

  const KEYS = "space.keys";
  const grantScopes = (...extra: string[]) => ["openid", KEYS, ...extra];

  beforeAll(async () => {
    hostedCtx = await createTestContext({ authMode: "hosted" });
    const space = await hostedCtx.storage.spaces!.create("oauth-keys-space");
    spaceId = space.id;
  });

  afterAll(async () => {
    await hostedCtx.cleanup();
  });

  it("refuses every keys door to a session that was not granted the space permission", async () => {
    const { token } = await seedOauthBearer(hostedCtx.storage, ["openid"], {
      seedUserRow: true,
      spaceId,
    });
    const doors: [string, string, unknown?][] = [
      ["GET", "/keys"],
      ["POST", "/keys", { label: "x", source: "x" }],
      ["DELETE", "/keys/key_whatever"],
      ["PATCH", "/keys/key_whatever", { label: "renamed" }],
    ];
    for (const [method, path, body] of doors) {
      const res = await request(hostedCtx.app, method, path, {
        key: token,
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      const err = (await res.json()) as {
        error: { code: string; details?: { required_scope?: string } };
      };
      expect(err.error.code).toBe("forbidden");
      // The refusal names the literal. A client told only "forbidden" on an
      // administrative surface cannot narrow toward a scope nobody named.
      expect(err.error.details?.required_scope).toBe(KEYS);
    }
  });

  it("lets a granted session mint, and the key matches the session's own reach", async () => {
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { seedUserRow: true, spaceId },
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "like me", source: "like-me" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      type_permissions: Record<string, string>;
    };
    // The no-input case is "a key like this session". The alternative default
    // is `{}`, which reads nothing at all.
    expect(created.type_permissions["core.note"]).toBe("read");

    const stored = await hostedCtx.storage.keys.get(created.id);
    expect(stored?.space_id).toBe(spaceId);
    expect(stored?.is_operator).toBe(false);
  });

  it("refuses reach the grant does not cover, and names the literal", async () => {
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { seedUserRow: true, spaceId },
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "wider",
        source: "wider",
        type_permissions: { "core.note": "write" },
      },
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as {
      error: { details?: { required_scope?: string } };
    };
    // `core.note:read` does not cover `core.note:write`: the verb ranks.
    expect(err.error.details?.required_scope).toBe("core.note:write");
  });

  it("accepts reach a wildcard in the grant covers", async () => {
    // The clamp asks `grantCoversScope`, not a string comparison. Five earlier
    // hand-rolled versions of this question disagreed with the real rule, so
    // the case that would pass a naive membership test is the one worth
    // pinning.
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.*:write"),
      { seedUserRow: true, spaceId },
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "under a wildcard",
        source: "under-wildcard",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(res.status).toBe(201);
  });

  it("never mints an operator key from a session, whatever the body asks", async () => {
    const { token } = await seedOauthBearer(hostedCtx.storage, grantScopes(), {
      seedUserRow: true,
      spaceId,
    });
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "platform",
        source: "platform",
        is_operator: true,
      },
    });
    // Running the instance sits outside the permission model, so no scope can
    // reach it and the ask is refused rather than quietly downgraded. The
    // synthetic OAuth principal never carries the flag, so no session can
    // satisfy this whatever it was granted.
    expect(res.status).toBe(403);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("forbidden");
    expect(
      (await hostedCtx.storage.keys.list()).some((k) => k.label === "platform"),
    ).toBe(false);
  });

  it("records the grant on the audit row, so a revoked app leads to its keys", async () => {
    const { token, clientId } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { seedUserRow: true, spaceId },
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "audited", source: "audited" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const audits = await waitForAudit(
      () => hostedCtx.storage.audit.list({ action: "key.create" }),
      (r) => r.data.some((row) => row.resource_id === created.id),
    );
    const row = audits.data.find((r) => r.resource_id === created.id);
    expect(row).toBeTruthy();
    const details = row?.details;
    // The key outlives the token that minted it, and `key_id` names the
    // synthetic principal — whose id is the access token's. These are the
    // identifiers still resolvable an hour later.
    expect(details?.client_id).toBe(clientId);
    expect(details?.user_id).toBeTruthy();
    expect("grant_item_id" in (details ?? {})).toBe(true);
  });

  it("lets a granted session read, revoke and rename", async () => {
    const { token } = await seedOauthBearer(hostedCtx.storage, grantScopes(), {
      seedUserRow: true,
      spaceId,
    });
    const raw = "marfa_k1_sess_" + Math.random().toString(36).slice(2);
    const target = await hostedCtx.storage.keys.create(
      {
        label: "target",
        source: "target-" + Math.random().toString(36).slice(2),
        type_permissions: {},
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      spaceId,
    );

    const list = await request(hostedCtx.app, "GET", "/keys", { key: token });
    expect(list.status).toBe(200);

    const renamed = await request(
      hostedCtx.app,
      "PATCH",
      `/keys/${target.id}`,
      { key: token, body: { label: "renamed" } },
    );
    expect(renamed.status).toBe(200);

    const revoked = await request(
      hostedCtx.app,
      "DELETE",
      `/keys/${target.id}`,
      { key: token },
    );
    expect(revoked.status).toBe(200);
  });

  it("hands a session-minted key no more than the session held", async () => {
    // **The second half of the two-step escalation.** A mint is the one way a
    // credential can outlive the clamp that bounded it, so the key a session
    // produces has to carry the session's own bounds — otherwise the refusals
    // above last exactly until the app mints its way past them.
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { seedUserRow: true, spaceId },
    );
    const minted = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "step one", source: "step-one" },
    });
    expect(minted.status).toBe(201);
    const first = (await minted.json()) as { id: string; key: string };
    const stored = await hostedCtx.storage.keys.get(first.id);
    // The grant carried `space.keys`, so the key carries it and no more: the
    // other ten are absent even though the account holder holds them all.
    expect(stored?.space_permissions).toEqual(["space.keys"]);

    // And the second hop cannot widen what the first was clamped to.
    const stepTwo = await request(hostedCtx.app, "POST", "/keys", {
      key: first.key,
      body: {
        label: "step two",
        source: "step-two",
        space_permissions: ["space.credentials"],
      },
    });
    expect(stepTwo.status).toBe(403);
    const err = (await stepTwo.json()) as {
      error: { details?: { required_scope?: string } };
    };
    expect(err.error.details?.required_scope).toBe("space.credentials");
  });

  it("clamps the update door, which reaches keys the session never minted", async () => {
    // A clamp at the mint alone is not a clamp: the maps are writable a moment
    // later, and this door addresses every key in the space.
    const raw = "marfa_k1_victim_" + Math.random().toString(36).slice(2);
    const victim = await hostedCtx.storage.keys.create(
      {
        label: "someone else's key",
        source: "victim-" + Math.random().toString(36).slice(2),
        type_permissions: {},
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      spaceId,
    );

    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { seedUserRow: true, spaceId },
    );
    const widen = await request(hostedCtx.app, "PATCH", `/keys/${victim.id}`, {
      key: token,
      body: { type_permissions: { "*": "write" } },
    });
    expect(widen.status).toBe(403);

    // At the ceiling, the same door still works.
    const within = await request(hostedCtx.app, "PATCH", `/keys/${victim.id}`, {
      key: token,
      body: { type_permissions: { "core.note": "read" } },
    });
    expect(within.status).toBe(200);
  });

  it("refuses an extension map from a session, at both doors", async () => {
    // Nothing can measure one: no scope names an extension namespace, so the
    // only answers are refuse and let-through-unchecked. Unchecked is real
    // reach — the extension read door consults this map alone, with no
    // type-permission check beside it.
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { seedUserRow: true, spaceId },
    );
    const minted = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "ext",
        source: "ext",
        type_permissions: {},
        extension_permissions: { "*": "write" },
      },
    });
    expect(minted.status).toBe(403);

    const raw = "marfa_k1_extt_" + Math.random().toString(36).slice(2);
    const target = await hostedCtx.storage.keys.create(
      {
        label: "ext target",
        source: "ext-target-" + Math.random().toString(36).slice(2),
        type_permissions: {},
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      spaceId,
    );
    const patched = await request(
      hostedCtx.app,
      "PATCH",
      `/keys/${target.id}`,
      {
        key: token,
        body: { extension_permissions: { "*": "write" } },
      },
    );
    expect(patched.status).toBe(403);
  });

  it("names one family and still gets none of the other three for free", async () => {
    // `namesNoReach` reads all four families. The grant below projects a
    // non-empty edge map as well as a type map, so the derive path has
    // something to hand over — without which this assertion would pass
    // whether or not the condition were right, which is what the first
    // version of it did.
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read", "edge.about:read"),
      { seedUserRow: true, spaceId },
    );

    // The derive path does hand the edge map over when nothing is named.
    const derived = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "derived", source: "derived-edges" },
    });
    expect(derived.status).toBe(201);
    const derivedKey = await hostedCtx.storage.keys.get(
      ((await derived.json()) as { id: string }).id,
    );
    expect(derivedKey?.edge_permissions?.about).toBe("read");

    // Naming one family takes the derive path off for all of them.
    const partial = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "partial",
        source: "partial",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(partial.status).toBe(201);
    const partialKey = await hostedCtx.storage.keys.get(
      ((await partial.json()) as { id: string }).id,
    );
    expect(partialKey?.type_permissions["core.note"]).toBe("read");
    expect(partialKey?.edge_permissions ?? {}).toEqual({});
    expect(partialKey?.metadata_permissions ?? {}).toEqual({});
    expect(partialKey?.extension_permissions ?? {}).toEqual({});
  });

  it("takes the derive path off whichever family is named", async () => {
    // Symmetric to the case above, and it is the one that catches a term
    // going missing from `namesNoReach`: naming only the edge family must
    // stop the type map deriving too, or a caller asking for a narrow key
    // silently receives the session's own reach instead.
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read", "edge.about:read"),
      { seedUserRow: true, spaceId },
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "edges only",
        source: "edges-only",
        edge_permissions: {},
      },
    });
    expect(res.status).toBe(201);
    const stored = await hostedCtx.storage.keys.get(
      ((await res.json()) as { id: string }).id,
    );
    expect(stored?.type_permissions ?? {}).toEqual({});
    expect(stored?.edge_permissions ?? {}).toEqual({});
  });

  it("does not let a session-minted key claim a namespace by its label", async () => {
    // `label` is read as identity, the same way `source` is: a namespace
    // equal to the key's label is granted write implicitly. A session chooses
    // its key's label, so without the stamp being consulted an app could name
    // another vendor's namespace and read it on every item in the space,
    // durably and after the app was revoked.
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { seedUserRow: true, spaceId },
    );
    const minted = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "com.othervendor.sync",
        source: "vendor-probe",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(minted.status).toBe(201);
    const key = await hostedCtx.storage.keys.get(
      ((await minted.json()) as { id: string }).id,
    );
    // The stored map is empty, and the label must not stand in for one.
    expect(key?.extension_permissions ?? {}).toEqual({});
    expect(extensionLabelOf(key ?? undefined)).toBe("");
  });

  it("measures a metadata wildcard on the metadata axis, not the type axis", async () => {
    // `metadata.*:write` is well-formed on the WRONG axis: it misses the
    // sub-resource matcher, clears `isValidTypePattern` because `metadata` is
    // a valid root, and parses as an item-type grant. A plain content grant
    // then covers it, so this case is a fail-open unless the bare form is
    // used — and `"*"` is the ordinary key, since it is what a bare
    // `metadata:<verb>` grant projects to.
    const contentOnly = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("content:write"),
      { seedUserRow: true, spaceId },
    );
    const refused = await request(hostedCtx.app, "POST", "/keys", {
      key: contentOnly.token,
      body: {
        label: "meta up",
        source: "meta-up",
        metadata_permissions: { "*": "write" },
      },
    });
    expect(refused.status).toBe(403);
    const err = (await refused.json()) as {
      error: { details?: { required_scope?: string } };
    };
    expect(err.error.details?.required_scope).toBe("metadata:write");

    // And the honest holder is not refused, which the broken literal also got
    // wrong — in the other direction.
    const metaHolder = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("metadata:write"),
      { seedUserRow: true, spaceId },
    );
    const allowed = await request(hostedCtx.app, "POST", "/keys", {
      key: metaHolder.token,
      body: {
        label: "meta ok",
        source: "meta-ok",
        metadata_permissions: { "*": "write" },
      },
    });
    expect(allowed.status).toBe(201);
  });

  it("lets an API key holding `space.keys` mint, with no grant anywhere", async () => {
    // The gate reads the key's own list when the caller is not a session, so
    // a keys-mode or API-key deployment reaches this door with no OAuth
    // principal involved at all. This is the case that says so.
    const raw = "marfa_k1_ta_" + Math.random().toString(36).slice(2);
    await hostedCtx.storage.keys.create(
      {
        label: "ta-key",
        source: "ta-key",
        space_permissions: [...SPACE_PERMISSIONS],
        type_permissions: {},
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      spaceId,
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: raw,
      body: { label: "minted", source: "minted" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    const stored = await hostedCtx.storage.keys.get(created.id);
    // An API-key mint that names no maps keeps `{}` rather than deriving from
    // a grant, because there is no grant to derive from.
    expect(stored?.type_permissions).toEqual({});
  });
});

describe("POST /keys — space binding", () => {
  // `POST /keys` mints into the caller's space, and the operator key has none
  // to give. A space-less credential is the instance tier — NULL space is the
  // universal "all spaces" signal to the RLS policies and to the storage
  // layer's space predicate — so the one credential this route can mint from
  // an operator key is another operator key. Everything space-bound goes
  // through `POST /admin/spaces/{id}/keys`, which names the space in the path.
  let hostedCtx: TestContext;
  let spaceId: string;

  beforeAll(async () => {
    hostedCtx = await createTestContext({ authMode: "hosted" });
    const space = await hostedCtx.storage.spaces!.create("space-binding");
    spaceId = space.id;
  });

  afterAll(async () => {
    await hostedCtx.cleanup();
  });

  it("refuses a space-bound mint from an operator key, naming the route that does it", async () => {
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.operatorKey,
      body: {
        label: "null-space-bound",
        source: "null-space-bound",
        is_operator: false,
      },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(err.error.code).toBe("validation_error");
    // The message must name the route that does the space-scoped mint,
    // otherwise the caller's only recourse is to guess.
    expect(err.error.message).toMatch(/POST \/admin\/spaces\/\{id\}\/keys/);
  });

  it("refuses to give the operator key it mints any reach at all", async () => {
    // A space-less credential is the instance tier, and running the instance
    // is not a permission: the storage layer applies no space predicate to
    // one, so a single map entry on it is read or write over every space at
    // once, reached without a space ever being named. The creator ceiling
    // does not catch this, because the operator key is exempt from it by
    // having nothing to be measured against.
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.operatorKey,
      body: {
        label: `null-space-narrow-${suffix}`,
        source: `null-space-narrow-${suffix}`,
        type_permissions: { "core.note": "read" },
      },
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as { error: { message: string } };
    // The refusal names the route that mints a working key, so the caller's
    // recourse is not a guess.
    expect(err.error.message).toMatch(/POST \/admin\/spaces\/\{id\}\/keys/);
  });

  it("mints a spare operator key when the body names nothing", async () => {
    // The one thing this door still does for an operator caller: a second
    // key at the same tier, carrying the same nothing.
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.operatorKey,
      body: {
        label: `null-space-spare-${suffix}`,
        source: `null-space-spare-${suffix}`,
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await hostedCtx.storage.keys.get(minted.id);
    expect(stored?.space_id ?? null).toBeNull();
    expect(stored?.is_operator).toBe(true);
    expect(stored?.type_permissions).toEqual({});
    expect(stored?.space_permissions).toEqual([]);

    const audits = await waitForAudit(
      () => hostedCtx.storage.audit.list({ action: "key.create" }),
      (r) => r.data.some((row) => row.resource_id === minted.id),
    );
    const row = audits.data.find((r) => r.resource_id === minted.id);
    expect(row?.details).toMatchObject({ operator_tier: true });
  });

  it("mints one from a body that names only denials, forcing the map empty", async () => {
    // **The one non-empty body this door still admits from an operator
    // caller.** A `none` entry is a denial rather than a request, so it names
    // nothing and the refusal above skips it, exactly as the creator ceiling
    // skips it. Nothing between that guard and the insert would then have
    // emptied the map: the route's own forcing is what turns
    // `{"core.note": "none"}` into `{}`, and without it a non-empty map would
    // arrive at a row the constraint says holds nothing and the mint would
    // fail as a database error rather than succeed as a mint.
    //
    // The sibling above covers the empty body, where the forcing has nothing
    // to do; this is the case where it does the work.
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.operatorKey,
      body: {
        label: `null-space-denials-${suffix}`,
        source: `null-space-denials-${suffix}`,
        type_permissions: { "core.note": "none" },
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await hostedCtx.storage.keys.get(minted.id);
    expect(stored?.space_id ?? null).toBeNull();
    expect(stored?.is_operator).toBe(true);
    // Empty, not the denial that was sent. `{"core.note": "none"}` grants
    // nothing either, so the difference is not what a door would read off it:
    // the constraint compares bytes, and those are not the bytes `{}` takes.
    expect(stored?.type_permissions).toEqual({});
    expect(stored?.space_permissions).toEqual([]);
  });

  it("cannot even be handed a widened operator key to mint from", async () => {
    // This used to seed a space-less operator key carrying every map and then
    // assert that a mint from it inherited nothing, because the row
    // constraint tied `space_id` to `is_operator` and said nothing about the
    // maps. The database says both halves now, so the caller this case needed
    // is a row nothing can write and the route's forcing is unreachable from
    // below rather than merely unused.
    //
    // Kept, and pointed at the refusal instead: the reason the forcing above
    // can no longer be exercised is worth a failing test of its own, so a
    // constraint dropped in some later rebuild is noticed here rather than
    // leaving a silently dead assertion behind.
    const suffix = Math.random().toString(36).slice(2, 10);
    const rawWide = `marfa_k1_wide_operator_${suffix}`;
    await expect(
      hostedCtx.storage.keys.create(
        {
          label: `wide-operator-${suffix}`,
          source: `wide-operator-${suffix}`,
          default_tier: "library",
          is_operator: true,
          type_permissions: { "*": "write" },
          edge_permissions: { "*": "write" },
          metadata_permissions: { "*": "write" },
          extension_permissions: { "*": "write" },
          profile_permissions: { "*": "write" },
          space_permissions: ["space.keys"],
        },
        hashApiKey(rawWide, TEST_API_KEY_SALT),
        undefined,
      ),
    ).rejects.toThrow();
    // Asserted on the row rather than on the message: the driver wraps a
    // check violation differently on each dialect, and what matters is that
    // nothing landed. `api_keys_space_less_holds_nothing` is the constraint,
    // and the migration suite pins its name and its two directions.
    expect(
      (await hostedCtx.storage.keys.list()).some(
        (k) => k.label === `wide-operator-${suffix}`,
      ),
    ).toBe(false);

    // And the operator key the instance really holds mints a credential that
    // inherits nothing, which is what the forcing is for.
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.operatorKey,
      body: {
        label: `inherits-nothing-${suffix}`,
        source: `inherits-nothing-${suffix}`,
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await hostedCtx.storage.keys.get(minted.id);
    expect(stored?.space_id ?? null).toBeNull();
    expect(stored?.type_permissions).toEqual({});
    expect(stored?.edge_permissions).toEqual({});
    expect(stored?.metadata_permissions).toEqual({});
    expect(stored?.extension_permissions).toEqual({});
    expect(stored?.profile_permissions).toEqual({});
    expect(stored?.space_permissions).toEqual([]);
  });

  it("mints the two-hop credential chain a black-box client relies on", async () => {
    // The conformance suite provisions with the operator key and then runs as
    // a space-bound credential minted into the run's own space, which mints
    // narrower ones from itself. Pinned here because that suite runs against a
    // deployed server, so a regression would only surface after release.
    //
    // It used to run every hop space-less, minting a wide key straight from
    // the operator key through this route. That shape is refused now, and the
    // suite inverted to this one first: a space-less credential is the
    // instance tier and reads no row at all.
    const suffix = Math.random().toString(36).slice(2, 10);
    const firstHop = await request(
      hostedCtx.app,
      "POST",
      `/admin/spaces/${spaceId}/keys`,
      {
        key: hostedCtx.operatorKey,
        body: {
          label: `harness-${suffix}`,
          source: `harness-${suffix}`,
          type_permissions: { "*": "write" },
        },
      },
    );
    expect(firstHop.status).toBe(201);
    const harness = (await firstHop.json()) as { key: string };

    const secondHop = await request(hostedCtx.app, "POST", "/keys", {
      key: harness.key,
      body: {
        label: `scoped-${suffix}`,
        source: `scoped-${suffix}`,
        type_permissions: { "core.note": "read" },
      },
    });
    expect(secondHop.status).toBe(201);
    const scoped = (await secondHop.json()) as { id: string };
    const stored = await hostedCtx.storage.keys.get(scoped.id);
    expect(stored?.space_id).toBe(spaceId);
    expect(stored?.is_operator).toBe(false);
    expect(stored?.type_permissions).toEqual({ "core.note": "read" });
  });

  it("still lets a space-bound key holding `space.keys` mint into its own space", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const raw = `marfa_k1_bound_admin_${suffix}`;
    await hostedCtx.storage.keys.create(
      {
        label: `bound-admin-${suffix}`,
        source: `bound-admin-${suffix}`,
        space_permissions: [...SPACE_PERMISSIONS],
        type_permissions: {},
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      spaceId,
    );

    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: raw,
      body: { label: `child-${suffix}`, source: `child-${suffix}` },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await hostedCtx.storage.keys.get(minted.id);
    expect(stored?.space_id).toBe(spaceId);
    expect(stored?.is_operator).toBe(false);
  });

  it("rejects a body `space_id` instead of silently dropping it", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.spaceKey,
      body: {
        label: `body-space-${suffix}`,
        source: `body-space-${suffix}`,
        space_id: spaceId,
      },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(err.error.code).toBe("validation_error");
    expect(err.error.message).toMatch(/space_id/);
  });
});

describe("POST /keys — single-space deployments keep minting space-less keys", () => {
  // An instance with no space plane has no space rows at all (they are only ever
  // created by the hosted sign-up flow), so every key it mints is legitimately
  // space-less — which is to say every key it mints is an operator key. The
  // space-bound refusal still applies here, and is not conditioned on the
  // deployment's auth mode, so it cannot be switched off by an env var going
  // stale.
  it("mints a space-less key in keys mode", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.operatorKey,
      body: {
        label: `self-host-${suffix}`,
        source: `self-host-${suffix}`,
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.space_id ?? null).toBeNull();
    expect(stored?.is_operator).toBe(true);
  });

  it("refuses a space-bound mint here too, where no space can exist", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.operatorKey,
      body: {
        label: `self-host-bound-${suffix}`,
        source: `self-host-bound-${suffix}`,
        is_operator: false,
      },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("validation_error");
  });

  it("still rejects a body `space_id` in keys mode", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: `self-host-body-${suffix}`,
        source: `self-host-body-${suffix}`,
        space_id: "some-space",
      },
    });
    expect(res.status).toBe(400);
  });
});
