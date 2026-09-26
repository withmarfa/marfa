import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { ensureInstanceId } from "../storage/instance-id.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { createBlobLayer } from "../storage/blob-layer.js";
import { Housekeeping } from "../housekeeping/scheduler.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
  TEST_API_KEY_SALT,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { Storage } from "../storage/interface.js";
import { hashApiKey } from "../middleware/auth.js";
import { ensureBootstrapSecret } from "../auth/bootstrap-secret.js";
import { KeyResponseSchema } from "./_schemas.js";
import { extensionLabelOf } from "../auth/extension-label.js";
import { generateId, PERMISSIONS } from "@withmarfa/shared";

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
    key: ctx.workingKey,
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
  // reach both. This one pins the HANDLER: no route can mint an expiry, so a
  // key minted through a door has none by construction and the response must
  // not carry the field.
  //
  // It says nothing about the declaration. Re-adding `expires_at` to the
  // shared schema leaves this green, because a declaration does not put a
  // field into a response — which is the whole reason the two drifted apart
  // in the first place. The declaration is pinned separately, below.
  it("carries no expiry, because a create route cannot mint one", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
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
  // The other half. This one reddens when the schema declares a field the
  // handler cannot fill, which the response-body test above cannot see.
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
      key: ctx.workingKey,
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
      key: ctx.workingKey,
      body: { label: "after" },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;

    expect(updated.label).toBe("after");
    expect(updated.default_tier).toBe("feed");
    expect(updated.type_permissions).toEqual({ "core.note": "read" });
  });

  it("returns 403 for a caller that does not hold `keys.mint`", async () => {
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
        permissions: [],
        type_permissions: { "*": "read" },
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(narrow, TEST_API_KEY_SALT),
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
      key: ctx.workingKey,
      body: { source: "something-else" },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/source.*immutable/i);
  });

  it("returns 404 for an unknown key id", async () => {
    // Valid UUIDv7 shape, guaranteed not to exist in the store.
    const ghostId = "00000000-0000-7000-8000-000000000000";
    const res = await request(ctx.app, "PATCH", `/keys/${ghostId}`, {
      key: ctx.workingKey,
      body: { label: "ghost" },
    });
    expect(res.status).toBe(404);
  });
});

describe("enforcement_override — the per-credential levers", () => {
  it("is stored on a mint, listed with the key, applied to the key's writes, and cleared by null", async () => {
    // Documented for a long time and silently dropped: a create carrying
    // the field answered 201 with no override on the row, so a caller
    // believed they had tightened validation and had not.
    const override = { strict_mode: { types: ["core.note"] } };
    const minted = await createKey({
      type_permissions: { "core.note": "write" },
      enforcement_override: override,
    });
    const echoed = await request(ctx.app, "GET", "/keys", {
      key: ctx.workingKey,
    });
    expect(echoed.status).toBe(200);
    const listed = (
      (await echoed.json()) as {
        data: { id: string; enforcement_override?: unknown }[];
      }
    ).data.find((k) => k.id === minted.id);
    expect(listed?.enforcement_override).toEqual(override);

    // Applied: an undeclared property is refused under this key and admitted
    // under a key that inherits the instance config, which sets no lever.
    const undeclared = {
      type: "core.note",
      properties: { body: "strict", not_a_field: "x" },
    };
    const refused = await request(ctx.app, "POST", "/items", {
      key: minted.key,
      body: undeclared,
    });
    expect(refused.status).toBe(400);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_properties");
    const plain = await createKey({
      type_permissions: { "core.note": "write" },
    });
    const admitted = await request(ctx.app, "POST", "/items", {
      key: plain.key,
      body: undeclared,
    });
    expect(admitted.status).toBe(201);

    // Replaced whole by a PATCH, and cleared by null.
    const narrowed = await request(ctx.app, "PATCH", `/keys/${minted.id}`, {
      key: ctx.workingKey,
      body: {
        enforcement_override: {
          source_filter: { types: ["core.note"], sources: ["elsewhere"] },
        },
      },
    });
    expect(narrowed.status).toBe(200);
    expect(
      ((await narrowed.json()) as { enforcement_override?: unknown })
        .enforcement_override,
    ).toEqual({
      source_filter: { types: ["core.note"], sources: ["elsewhere"] },
    });
    // The filter narrows this key's reads: nothing it wrote came from
    // `elsewhere`.
    const filtered = await request(ctx.app, "GET", "/items?type=core.note", {
      key: minted.key,
    });
    expect(filtered.status).toBe(200);
    expect(((await filtered.json()) as { data: unknown[] }).data).toEqual([]);

    const cleared = await request(ctx.app, "PATCH", `/keys/${minted.id}`, {
      key: ctx.workingKey,
      body: { enforcement_override: null },
    });
    expect(cleared.status).toBe(200);
    expect(
      "enforcement_override" in
        ((await cleared.json()) as Record<string, unknown>),
    ).toBe(false);
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.enforcement_override).toBeUndefined();
  });
});

describe("PATCH /keys/{id} — an operator target", () => {
  /** A spare credential at the instance tier, holding nothing. */
  async function mintOperatorKey(suffix: string): Promise<string> {
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.operatorKey,
      body: {
        label: `operator-patch-${suffix}`,
        source: `operator-patch-${suffix}`,
        is_operator: true,
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.is_operator).toBe(true);
    return minted.id;
  }

  // The control, so the case below cannot pass by the guard having been
  // removed rather than by the write having been forced empty.
  it("refuses a request naming reach", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const id = await mintOperatorKey(suffix);

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.operatorKey,
      body: { type_permissions: { "core.note": "read" } },
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/POST \/keys/);
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
    const id = await mintOperatorKey(suffix);

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
    expect(stored?.permissions).toEqual([]);
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

  // **Nothing stood between the operator key and a revoke that did
  // nothing.** `keys.get` drops revoked rows, so a revoked key and an
  // unknown one both read as a miss, and the store was reached with any id
  // at all. The route handler carries what that cost.
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

    // A barrier rather than a deadline: the absence below is read once the
    // audit writer has settled, so a loaded machine cannot turn it red.
    await ctx.storage.audit.drain();
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
    await ctx.storage.audit.drain();
    expect(await revokeAudits(id)).toBe(1);

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
    // able to tell an id nobody holds from one already revoked. The message
    // is what separates them for the caller who does hold the key.
    expect(err.error.message).toMatch(/already revoked/i);

    await ctx.storage.audit.drain();
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

    await ctx.storage.audit.drain();
    expect(await revokeAudits(id)).toBe(1);
    expect(await ctx.storage.keys.get(id)).toBeNull();
  });
});

describe("bootstrap sentinel", () => {
  // Builds a fresh app with NO existing key and NO sentinel set —
  // mirrors a brand-new installation: a fresh tmp DB, so the
  // `bootstrapped` sentinel isn't set and the bootstrap path can fire
  // cleanly. Cannot use `createTestContext` because that
  // pre-creates the bootstrap credential and stamps the bootstrapped sentinel.
  async function freshApp(): Promise<{
    app: ReturnType<typeof createApp>;
    storage: Storage;
    /**
     * The one-time secret the first mint must present, obtained the way boot
     * obtains it. **Generated here rather than by the app**, because these
     * tests build the app directly and never run the boot path that prints
     * it — and a fixture that skipped the secret would be testing a door the
     * product does not have.
     */
    bootstrapSecret: string;
    /** Removed by the caller alongside `storage.close()`; nothing else
     *  removes it. */
    tmpDir: string;
  }> {
    const tmpDir = mkdtempSync(join(tmpdir(), "marfa-bootstrap-"));
    const storage = await createSqliteStorage(join(tmpDir, "test.db"));
    const instanceId = await ensureInstanceId(storage.settings);
    const blobPath = join(tmpDir, "blobs");
    const blobs = await createBlobLayer(storage, {
      blobPath: blobPath,
      s3Bucket: "",
      s3Region: "us-east-1",
      s3Endpoint: "",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
    });
    const app = createApp(
      storage,
      blobs,
      new Housekeeping(storage.housekeeping, { pollIntervalMs: 1_000 }),
      {
        port: 0,
        sqlitePath: "",
        blobPath,
        maxRequestBytes: 1_048_576,
        s3Bucket: "",
        s3Region: "us-east-1",
        s3Endpoint: "",
        s3AccessKeyId: "",
        s3SecretAccessKey: "",
        apiKeySalt: "test-salt",
        corsOrigins: [],
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
        authSecret: "test-auth-secret",
        rateLimitDefaultLimit: 1000,
        rateLimitWindowMs: 60_000,
      },
      instanceId,
    );
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

  it("returns the operator key only, and the operator mints the key that works", async () => {
    // **The operator key is not a working key**, so an operator handed only
    // that has a credential it cannot use: no permissions, because running
    // the instance sits outside the permission model. The setup story is
    // mint the operator key, then mint a working key with it — and a body
    // naming nothing takes everything, because the operator key is a seed
    // rather than a ceiling.
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      const res = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        key: string;
        is_operator: boolean;
      };
      expect(body.is_operator).toBe(true);

      const working = await request(app, "POST", "/keys", {
        key: body.key,
        body: { label: "working", source: "working" },
      });
      expect(working.status).toBe(201);
      const workingBody = (await working.json()) as {
        key: string;
        is_operator: boolean;
        permissions: string[];
        type_permissions: Record<string, string>;
      };
      // The working key is an ordinary credential holding the whole instance.
      expect(workingBody.is_operator).toBe(false);
      expect(workingBody.permissions).toEqual(
        expect.arrayContaining(["keys.mint", "config.manage"]),
      );
      expect(workingBody.type_permissions).toEqual({ "*": "write" });

      // **And it works.** A key holding nothing it can reach would satisfy
      // every assertion above and be useless, so the round trip is the
      // assertion that matters.
      const created = await request(app, "POST", "/items", {
        key: workingBody.key,
        body: { type: "core.note", properties: { body: "hello" } },
      });
      expect(created.status).toBe(201);
      const listed = await request(app, "GET", "/items?type=core.note", {
        key: workingBody.key,
      });
      expect(listed.status).toBe(200);
      const page = (await listed.json()) as { data: unknown[] };
      expect(page.data).toHaveLength(1);
      // The store holds the two rows the story produced.
      const keys = await storage.keys.list();
      expect(keys.filter((k) => k.is_operator)).toHaveLength(1);
      expect(keys.filter((k) => !k.is_operator)).toHaveLength(1);
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("takes no content reach on bootstrap, whatever the body asks for", async () => {
    // **The operator key holds nothing on any axis.** The permissions
    // are forced empty and the clamp refuses anything requested; the four
    // content maps must not come off the body either, because bootstrap is
    // unauthenticated with no creator to clamp against, so `*: write` here
    // would be read and write over everything, in the one row shape the
    // constraint exists to make unwritable.
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
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

  it("refuses a claim on bootstrap, as on any operator key, and the secret still mints", async () => {
    // The key bootstrap mints is the operator key, which holds nothing, so a
    // claim named on it is refused rather than dropped: a mint that answered
    // `201` with the claim gone would not be the key the caller asked for.
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
    try {
      const refused = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: {
          label: "first-admin",
          source: "first-admin",
          sources: ["shared-notes"],
        },
      });
      expect(refused.status).toBe(403);
      const body = (await refused.json()) as {
        error: { code: string; details?: { source?: string } };
      };
      expect(body.error.code).toBe("forbidden");
      expect(body.error.details?.source).toBe("shared-notes");
      expect(await storage.keys.list()).toHaveLength(0);

      // The witness, and the point of refusing inside the claim's window:
      // the same secret mints once the body names no claim.
      const minted = await request(app, "POST", "/keys", {
        key: bootstrapSecret,
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(minted.status).toBe(201);
      const operator = (await minted.json()) as {
        is_operator: boolean;
        sources: string[];
      };
      expect(operator.is_operator).toBe(true);
      expect(operator.sources).toEqual([]);
      // The listing that held no key after the refusal holds this one.
      expect(
        (await storage.keys.list()).map((k) => k.source),
        "the listing does not surface a minted key, so its emptiness above proves nothing",
      ).toEqual(["first-admin"]);
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
    const { app, storage, bootstrapSecret, tmpDir } = await freshApp();
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

  it("gives the one-shot claim back when the mint itself fails", async () => {
    // The claim has to come first or two concurrent callers both mint, and it
    // is also what stops the middleware admitting an unauthenticated mint. A
    // throw after it must not leave a sentinel with no operator key behind it:
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
          label: "reserved-source",
          // A source claiming a connector's identity is refused, so the
          // request can never mint.
          source: "oauth:stray",
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
    // Uses its own app rather than the shared `ctx` so the closed branch is
    // reached from a known state.
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
      // Naming no reach, because the caller is the operator key: an
      // operator key holds nothing and may give nothing, so a body naming
      // a type map is refused. What this case is about is which audit
      // action the non-bootstrap branch writes.
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

      // Next unauthenticated POST must be rejected: the sentinel persists
      // past the key it was set for.
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

      // **Exactly one operator key**, which is the property.
      const keys = await storage.keys.list();
      expect(keys.filter((k) => k.is_operator)).toHaveLength(1);
      expect(keys.filter((k) => !k.is_operator)).toHaveLength(0);
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("POST /keys — a session mints, clamped to its own grant", () => {
  // Two things hold here and can fail independently: the permission gate,
  // and the breadth clamp that prevents the escalation a mint makes
  // possible. Each gets its own case rather than one test standing for
  // both.
  let oauthCtx: TestContext;

  const KEYS = "keys.mint";
  const grantScopes = (...extra: string[]) => ["openid", KEYS, ...extra];

  beforeAll(async () => {
    oauthCtx = await createTestContext({});
  });

  afterAll(async () => {
    await oauthCtx.cleanup();
  });

  it("refuses every keys door to a session that was not granted the permission", async () => {
    const { token } = await seedOauthBearer(oauthCtx.storage, ["openid"], {});
    const doors: [string, string, unknown?][] = [
      ["GET", "/keys"],
      ["POST", "/keys", { label: "x", source: "x" }],
      ["DELETE", "/keys/key_whatever"],
      ["PATCH", "/keys/key_whatever", { label: "renamed" }],
    ];
    for (const [method, path, body] of doors) {
      const res = await request(oauthCtx.app, method, path, {
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

  it("refuses a session reading itself as a key, whatever it was granted", async () => {
    const { token } = await seedOauthBearer(
      oauthCtx.storage,
      grantScopes("types:*:write"),
      {},
    );
    const res = await request(oauthCtx.app, "GET", "/keys/current", {
      key: token,
    });
    expect(res.status).toBe(403);
    // The witness: the same token reaches the keys doors it was granted.
    const list = await request(oauthCtx.app, "GET", "/keys", { key: token });
    expect(list.status).toBe(200);
  });

  it("lets a granted session mint, and the key matches the session's own reach", async () => {
    const { token } = await seedOauthBearer(
      oauthCtx.storage,
      grantScopes("core.note:read"),
      {},
    );
    const res = await request(oauthCtx.app, "POST", "/keys", {
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

    const stored = await oauthCtx.storage.keys.get(created.id);
    expect(stored?.is_operator).toBe(false);
  });

  it("refuses reach the grant does not cover, and names the literal", async () => {
    const { token } = await seedOauthBearer(
      oauthCtx.storage,
      grantScopes("core.note:read"),
      {},
    );
    const res = await request(oauthCtx.app, "POST", "/keys", {
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
      oauthCtx.storage,
      grantScopes("core.*:write"),
      {},
    );
    const res = await request(oauthCtx.app, "POST", "/keys", {
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
    const { token } = await seedOauthBearer(
      oauthCtx.storage,
      grantScopes(),
      {},
    );
    const res = await request(oauthCtx.app, "POST", "/keys", {
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
      (await oauthCtx.storage.keys.list()).some((k) => k.label === "platform"),
    ).toBe(false);
  });

  it("records the grant on the audit row, so a revoked app leads to its keys", async () => {
    const { token, clientId } = await seedOauthBearer(
      oauthCtx.storage,
      grantScopes("core.note:read"),
      {},
    );
    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "audited", source: "audited" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const audits = await waitForAudit(
      () => oauthCtx.storage.audit.list({ action: "key.create" }),
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
    const { token } = await seedOauthBearer(
      oauthCtx.storage,
      grantScopes(),
      {},
    );
    const raw = "marfa_k1_sess_" + Math.random().toString(36).slice(2);
    const target = await oauthCtx.storage.keys.create(
      {
        label: "target",
        source: "target-" + Math.random().toString(36).slice(2),
        type_permissions: {},
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
    );

    const list = await request(oauthCtx.app, "GET", "/keys", { key: token });
    expect(list.status).toBe(200);

    const renamed = await request(oauthCtx.app, "PATCH", `/keys/${target.id}`, {
      key: token,
      body: { label: "renamed" },
    });
    expect(renamed.status).toBe(200);

    const revoked = await request(
      oauthCtx.app,
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
      oauthCtx.storage,
      grantScopes("core.note:read"),
      {},
    );
    const minted = await request(oauthCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "step one", source: "step-one" },
    });
    expect(minted.status).toBe(201);
    const first = (await minted.json()) as { id: string; key: string };
    const stored = await oauthCtx.storage.keys.get(first.id);
    // The grant carried `keys.mint`, so the key carries it and no more: the
    // other six are absent even though the account holder holds them all.
    expect(stored?.permissions).toEqual(["keys.mint"]);

    // And the second hop cannot widen what the first was clamped to.
    const stepTwo = await request(oauthCtx.app, "POST", "/keys", {
      key: first.key,
      body: {
        label: "step two",
        source: "step-two",
        permissions: ["webhooks.manage"],
      },
    });
    expect(stepTwo.status).toBe(403);
    const err = (await stepTwo.json()) as {
      error: { details?: { required_scope?: string } };
    };
    expect(err.error.details?.required_scope).toBe("webhooks.manage");
  });

  it("clamps the update door, which reaches keys the session never minted", async () => {
    // A clamp at the mint alone is not a clamp: the maps are writable a moment
    // later, and this door addresses every key.
    const raw = "marfa_k1_victim_" + Math.random().toString(36).slice(2);
    const victim = await oauthCtx.storage.keys.create(
      {
        label: "someone else's key",
        source: "victim-" + Math.random().toString(36).slice(2),
        type_permissions: {},
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
    );

    const { token } = await seedOauthBearer(
      oauthCtx.storage,
      grantScopes("core.note:read"),
      {},
    );
    const widen = await request(oauthCtx.app, "PATCH", `/keys/${victim.id}`, {
      key: token,
      body: { type_permissions: { "*": "write" } },
    });
    expect(widen.status).toBe(403);

    // At the ceiling, the same door still works.
    const within = await request(oauthCtx.app, "PATCH", `/keys/${victim.id}`, {
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
      oauthCtx.storage,
      grantScopes("core.note:read"),
      {},
    );
    const minted = await request(oauthCtx.app, "POST", "/keys", {
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
    const target = await oauthCtx.storage.keys.create(
      {
        label: "ext target",
        source: "ext-target-" + Math.random().toString(36).slice(2),
        type_permissions: {},
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
    );
    const patched = await request(oauthCtx.app, "PATCH", `/keys/${target.id}`, {
      key: token,
      body: { extension_permissions: { "*": "write" } },
    });
    expect(patched.status).toBe(403);
  });

  it("names one family and still gets none of the other three for free", async () => {
    // `namesNoReach` reads all five families and the claims. The grant below projects a
    // non-empty edge map as well as a type map, so the derive path has
    // something to hand over — without which this assertion would pass
    // whether or not the condition were right, which is what the first
    // version of it did.
    const { token } = await seedOauthBearer(
      oauthCtx.storage,
      grantScopes("core.note:read", "edge.about:read"),
      {},
    );

    // The derive path does hand the edge map over when nothing is named.
    const derived = await request(oauthCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "derived", source: "derived-edges" },
    });
    expect(derived.status).toBe(201);
    const derivedKey = await oauthCtx.storage.keys.get(
      ((await derived.json()) as { id: string }).id,
    );
    expect(derivedKey?.edge_permissions?.about).toBe("read");

    // Naming one family takes the derive path off for all of them.
    const partial = await request(oauthCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "partial",
        source: "partial",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(partial.status).toBe(201);
    const partialKey = await oauthCtx.storage.keys.get(
      ((await partial.json()) as { id: string }).id,
    );
    expect(partialKey?.type_permissions["core.note"]).toBe("read");
    expect(partialKey?.edge_permissions ?? {}).toEqual({});
    expect(partialKey?.metadata_permissions ?? {}).toEqual({});
    expect(partialKey?.extension_permissions ?? {}).toEqual({});
    // The session holds `keys.mint`, which the key it minted naming a map
    // does not take.
    expect(partialKey?.permissions).toEqual([]);
  });

  it("takes the derive path off whichever family is named", async () => {
    // Symmetric to the case above, and it is the one that catches a term
    // going missing from `namesNoReach`: naming only the edge family must
    // stop the type map deriving too, or a caller asking for a narrow key
    // silently receives the session's own reach instead.
    const { token } = await seedOauthBearer(
      oauthCtx.storage,
      grantScopes("core.note:read", "edge.about:read"),
      {},
    );
    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "edges only",
        source: "edges-only",
        edge_permissions: {},
      },
    });
    expect(res.status).toBe(201);
    const stored = await oauthCtx.storage.keys.get(
      ((await res.json()) as { id: string }).id,
    );
    expect(stored?.type_permissions ?? {}).toEqual({});
    expect(stored?.edge_permissions ?? {}).toEqual({});
  });

  it("does not let a session-minted key claim a namespace by its label", async () => {
    // `label` is read as identity, the same way `source` is: a namespace
    // equal to the key's label is granted write implicitly. A session chooses
    // its key's label, so without the stamp being consulted an app could name
    // another vendor's namespace and read it on every item stored,
    // durably and after the app was revoked.
    const { token } = await seedOauthBearer(
      oauthCtx.storage,
      grantScopes("core.note:read"),
      {},
    );
    const minted = await request(oauthCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "com.othervendor.sync",
        source: "vendor-probe",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(minted.status).toBe(201);
    const key = await oauthCtx.storage.keys.get(
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
      oauthCtx.storage,
      grantScopes("content:write"),
      {},
    );
    const refused = await request(oauthCtx.app, "POST", "/keys", {
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
      oauthCtx.storage,
      grantScopes("metadata:write"),
      {},
    );
    const allowed = await request(oauthCtx.app, "POST", "/keys", {
      key: metaHolder.token,
      body: {
        label: "meta ok",
        source: "meta-ok",
        metadata_permissions: { "*": "write" },
      },
    });
    expect(allowed.status).toBe(201);
  });

  it("lets an API key holding `keys.mint` mint, with no grant anywhere", async () => {
    // The gate reads the key's own list when the caller is not a session,
    // so an API key reaches this door with no OAuth principal involved at
    // all. This is the case that says so.
    const raw = "marfa_k1_ta_" + Math.random().toString(36).slice(2);
    await oauthCtx.storage.keys.create(
      {
        label: "ta-key",
        source: "ta-key",
        permissions: [...PERMISSIONS],
        type_permissions: {},
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
    );
    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: raw,
      body: { label: "minted", source: "minted" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    const stored = await oauthCtx.storage.keys.get(created.id);
    // An API-key mint that names no maps keeps `{}` rather than deriving from
    // a grant, because there is no grant to derive from.
    expect(stored?.type_permissions).toEqual({});
  });
});

describe("POST /keys — what an operator key mints", () => {
  // The operator key holds nothing, so nothing about it is a ceiling: a
  // working key it mints holds what the body names, or the whole set when
  // the body names nothing. A body naming `is_operator: true` produces a
  // second operator key, which holds nothing.
  let oauthCtx: TestContext;

  beforeAll(async () => {
    oauthCtx = await createTestContext({});
  });

  afterAll(async () => {
    await oauthCtx.cleanup();
  });

  it("mints a working key holding everything when the body names nothing", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: oauthCtx.operatorKey,
      body: {
        label: `seeded-${suffix}`,
        source: `seeded-${suffix}`,
        is_operator: false,
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await oauthCtx.storage.keys.get(minted.id);
    expect(stored?.is_operator).toBe(false);
    expect(stored?.type_permissions).toEqual({ "*": "write" });
    expect(stored?.edge_permissions).toEqual({ "*": "write" });
    expect(stored?.metadata_permissions).toEqual({ "*": "write" });
    expect(stored?.extension_permissions).toEqual({ "*": "write" });
    expect(stored?.profile_permissions).toEqual({ "*": "write" });
    expect(stored?.permissions).toEqual([...PERMISSIONS]);
  });

  it("mints a working key holding only what the body names", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: oauthCtx.operatorKey,
      body: {
        label: `narrow-${suffix}`,
        source: `narrow-${suffix}`,
        type_permissions: { "core.note": "read" },
        permissions: ["keys.mint"],
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await oauthCtx.storage.keys.get(minted.id);
    expect(stored?.is_operator).toBe(false);
    expect(stored?.type_permissions).toEqual({ "core.note": "read" });
    expect(stored?.edge_permissions).toEqual({});
    expect(stored?.permissions).toEqual(["keys.mint"]);
  });

  it("mints a key naming a map and no permissions with no permissions, from the operator key or a working one", async () => {
    // Naming a map is naming what the key holds, so the permissions left
    // unnamed are held no more than the maps left unnamed. The witness is
    // the case above: the same mint naming nothing takes every permission.
    for (const minter of [oauthCtx.operatorKey, oauthCtx.workingKey]) {
      const suffix = Math.random().toString(36).slice(2, 10);
      const res = await request(oauthCtx.app, "POST", "/keys", {
        key: minter,
        body: {
          label: `mapped-${suffix}`,
          source: `mapped-${suffix}`,
          type_permissions: { "core.note": "write" },
          metadata_permissions: { types: "write" },
        },
      });
      expect(res.status).toBe(201);
      const minted = (await res.json()) as { id: string };
      const stored = await oauthCtx.storage.keys.get(minted.id);
      expect(stored?.type_permissions).toEqual({ "core.note": "write" });
      expect(stored?.metadata_permissions).toEqual({ types: "write" });
      expect(
        stored?.permissions,
        "a key minted for one type took its minter's permissions, keys.mint and items.purge among them",
      ).toEqual([]);
    }
  });

  it("mints a key naming only claimed sources with no permissions", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: oauthCtx.operatorKey,
      body: {
        label: `claims-${suffix}`,
        source: `claims-${suffix}`,
        sources: [`claimed-${suffix}`],
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await oauthCtx.storage.keys.get(minted.id);
    expect(stored?.permissions).toEqual([]);
  });

  it("lets a key holding nothing read itself, and nothing else of the keys", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const minted = await request(oauthCtx.app, "POST", "/keys", {
      key: oauthCtx.operatorKey,
      body: {
        label: `self-${suffix}`,
        source: `self-${suffix}`,
        type_permissions: { "core.note": "write" },
      },
    });
    expect(minted.status).toBe(201);
    const { id, key } = (await minted.json()) as { id: string; key: string };

    const self = await request(oauthCtx.app, "GET", "/keys/current", { key });
    expect(self.status).toBe(200);
    const row = (await self.json()) as Record<string, unknown>;
    expect(row.id).toBe(id);
    expect(row.source).toBe(`self-${suffix}`);
    expect(row.permissions).toEqual([]);
    expect(row.type_permissions).toEqual({ "core.note": "write" });
    expect(row).not.toHaveProperty("key");
    expect(row).not.toHaveProperty("key_hash");
    expect(row).not.toHaveProperty("revoked_at");

    // The listing is the witness that the key reads itself by this door
    // alone: it holds no `keys.mint`.
    const list = await request(oauthCtx.app, "GET", "/keys", { key });
    expect(list.status).toBe(403);
  });

  it("answers the operator key its own row", async () => {
    const res = await request(oauthCtx.app, "GET", "/keys/current", {
      key: oauthCtx.operatorKey,
    });
    expect(res.status).toBe(200);
    const row = (await res.json()) as { is_operator: boolean };
    expect(row.is_operator).toBe(true);
  });

  it("refuses a request with no credential", async () => {
    const res = await request(oauthCtx.app, "GET", "/keys/current", {});
    expect(res.status).toBe(401);
  });

  it("refuses to give the operator key it mints any reach at all", async () => {
    // Running the instance is not a permission, so the tier that runs it
    // carries none. The creator ceiling does not catch this, because the
    // operator key is exempt from it by having nothing to be measured
    // against.
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: oauthCtx.operatorKey,
      body: {
        label: `operator-narrow-${suffix}`,
        source: `operator-narrow-${suffix}`,
        is_operator: true,
        type_permissions: { "core.note": "read" },
      },
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as { error: { message: string } };
    // The refusal names the route that mints a working key, so the caller's
    // recourse is not a guess.
    expect(err.error.message).toMatch(/POST \/keys/);
  });

  it("mints a spare operator key when the body names nothing", async () => {
    // The one thing this door still does for an operator caller: a second
    // key at the same tier, carrying the same nothing.
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: oauthCtx.operatorKey,
      body: {
        label: `operator-spare-${suffix}`,
        source: `operator-spare-${suffix}`,
        is_operator: true,
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await oauthCtx.storage.keys.get(minted.id);
    expect(stored?.is_operator).toBe(true);
    expect(stored?.type_permissions).toEqual({});
    expect(stored?.permissions).toEqual([]);

    const audits = await waitForAudit(
      () => oauthCtx.storage.audit.list({ action: "key.create" }),
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
    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: oauthCtx.operatorKey,
      body: {
        label: `operator-denials-${suffix}`,
        source: `operator-denials-${suffix}`,
        is_operator: true,
        type_permissions: { "core.note": "none" },
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await oauthCtx.storage.keys.get(minted.id);
    expect(stored?.is_operator).toBe(true);
    // Empty, not the denial that was sent. `{"core.note": "none"}` grants
    // nothing either, so the difference is not what a door would read off it:
    // the constraint compares bytes, and those are not the bytes `{}` takes.
    expect(stored?.type_permissions).toEqual({});
    expect(stored?.permissions).toEqual([]);
  });

  it("cannot even be handed a widened operator key to mint from", async () => {
    // The row constraint says both halves (no permissions, no maps), so
    // the caller this case would need, an operator key carrying every map,
    // is a row nothing can write, and the route's forcing is unreachable
    // from below rather than merely unused.
    //
    // So the refusal is what is asserted: a constraint dropped from the row
    // turns this red, rather than making that caller writable with nothing
    // to say the forcing now matters.
    const suffix = Math.random().toString(36).slice(2, 10);
    const rawWide = `marfa_k1_wide_operator_${suffix}`;
    await expect(
      oauthCtx.storage.keys.create(
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
          permissions: ["keys.mint"],
        },
        hashApiKey(rawWide, TEST_API_KEY_SALT),
      ),
    ).rejects.toThrow();
    // Asserted on the row rather than on the message, because the message is
    // the driver's and carries the constraint's name. What matters is
    // that nothing landed. The constraint itself is
    // `api_keys_operator_holds_nothing`, declared in `schema.ts` and pinned
    // by `schema-sql.test.ts` against a database it builds fresh.
    expect(
      (await oauthCtx.storage.keys.list()).some(
        (k) => k.label === `wide-operator-${suffix}`,
      ),
    ).toBe(false);

    // And the operator key the instance really holds mints a credential that
    // inherits nothing, which is what the forcing is for.
    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: oauthCtx.operatorKey,
      body: {
        label: `inherits-nothing-${suffix}`,
        source: `inherits-nothing-${suffix}`,
        is_operator: true,
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await oauthCtx.storage.keys.get(minted.id);
    expect(stored?.type_permissions).toEqual({});
    expect(stored?.edge_permissions).toEqual({});
    expect(stored?.metadata_permissions).toEqual({});
    expect(stored?.extension_permissions).toEqual({});
    expect(stored?.profile_permissions).toEqual({});
    expect(stored?.permissions).toEqual([]);
  });

  it("mints the two-hop credential chain a black-box client relies on", async () => {
    // The conformance suite provisions with the operator key and then runs as
    // a working credential minted from it, which mints narrower ones from
    // itself. Pinned here as well as there, so a regression names the door
    // rather than the referee's boot.
    const suffix = Math.random().toString(36).slice(2, 10);
    const harnessKey = await mintWorkingKey(oauthCtx, {
      label: `harness-${suffix}`,
      source: `harness-${suffix}`,
      type_permissions: { "*": "write" },
    });

    const secondHop = await request(oauthCtx.app, "POST", "/keys", {
      key: harnessKey,
      body: {
        label: `scoped-${suffix}`,
        source: `scoped-${suffix}`,
        type_permissions: { "core.note": "read" },
      },
    });
    expect(secondHop.status).toBe(201);
    const scoped = (await secondHop.json()) as { id: string };
    const stored = await oauthCtx.storage.keys.get(scoped.id);
    expect(stored?.is_operator).toBe(false);
    expect(stored?.type_permissions).toEqual({ "core.note": "read" });
  });

  it("still lets a working key holding `keys.mint` mint", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const raw = `marfa_k1_bound_admin_${suffix}`;
    await oauthCtx.storage.keys.create(
      {
        label: `bound-admin-${suffix}`,
        source: `bound-admin-${suffix}`,
        permissions: [...PERMISSIONS],
        type_permissions: {},
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
    );

    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: raw,
      body: { label: `child-${suffix}`, source: `child-${suffix}` },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await oauthCtx.storage.keys.get(minted.id);
    expect(stored?.is_operator).toBe(false);
  });
});
