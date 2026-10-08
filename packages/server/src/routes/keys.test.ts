import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  createUnclaimedTestApp,
  mintWorkingKey,
  request,
  seedOauthBearer,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { KeyResponseSchema } from "./_schemas.js";
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
        // Content access does not grant key management.
        permissions: [],
        type_permissions: { "*": "read" },
        default_tier: "library",
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

describe("enforcement_override — a lever missing a required field", () => {
  /** The `details.errors` of a refusal, with its code. */
  async function refusal(res: Response) {
    const body = (await res.json()) as {
      error: {
        code: string;
        details?: { field?: string; errors?: { path: string }[] };
      };
    };
    return body.error;
  }

  const cases = [
    {
      lever: { source_filter: { sources: ["elsewhere"] } },
      path: "enforcement_override.source_filter.types",
    },
    {
      lever: { source_allowlist: { types: ["core.note"] } },
      path: "enforcement_override.source_allowlist.sources",
    },
    {
      lever: { strict_mode: {} },
      path: "enforcement_override.strict_mode.types",
    },
  ];

  // One fault, one answer: the mint and the update refuse it the same way.
  it.each(cases)(
    "is refused 400 missing_required_field naming $path, by the mint and by the update",
    async ({ lever, path }) => {
      const minted = await createKey();
      const doors = [
        request(ctx.app, "POST", "/keys", {
          key: ctx.workingKey,
          body: {
            label: "lever-mint",
            source: "lever-mint",
            enforcement_override: lever,
          },
        }),
        request(ctx.app, "PATCH", `/keys/${minted.id}`, {
          key: ctx.workingKey,
          body: { enforcement_override: lever },
        }),
      ];
      const answers = [];
      for (const res of await Promise.all(doors)) {
        expect(res.status).toBe(400);
        answers.push(await refusal(res));
      }
      expect(answers[1]).toEqual(answers[0]);
      expect(answers[0]?.code).toBe("missing_required_field");
      expect(answers[0]?.details?.field).toBe(path);

      // Refused, so nothing was stored.
      const stored = await ctx.storage.keys.get(minted.id);
      expect(stored?.enforcement_override).toBeUndefined();
    },
  );

  it("still refuses a lever that is not an object, and still takes null", async () => {
    const minted = await createKey();
    const res = await request(ctx.app, "PATCH", `/keys/${minted.id}`, {
      key: ctx.workingKey,
      body: { enforcement_override: "strict" },
    });
    expect(res.status).toBe(400);
    const error = await refusal(res);
    expect(error.code).toBe("validation_error");
    expect(error.details?.errors?.map((e) => e.path)).toEqual([
      "enforcement_override",
    ]);

    const cleared = await request(ctx.app, "PATCH", `/keys/${minted.id}`, {
      key: ctx.workingKey,
      body: { enforcement_override: null },
    });
    expect(cleared.status).toBe(200);
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

  // **Nothing stood between the direct owner and a revoke that did
  // nothing.** `keys.get` drops revoked rows, so a revoked key and an
  // unknown one both read as a miss, and the store was reached with any id
  // at all. The route handler carries what that cost.
  it("refuses an unknown id rather than answering ok", async () => {
    const unknown = generateId();

    const res = await request(ctx.app, "DELETE", `/keys/${unknown}`, {
      headers: {
        cookie: ctx.owner.cookie,
        origin: new URL(ctx.config.authBaseUrl).origin,
      },
    });
    expect(
      res.status,
      "a revoke that changed no row answered success, so somebody believing it walks away with a live credential they think is dead",
    ).toBe(404);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("api_key_not_found");

    // A barrier rather than a deadline: the absence below is read once the
    // audit writer has settled, so a loaded machine cannot turn it red.

    expect(
      await revokeAudits(unknown),
      "an audit row records a revocation that never happened",
    ).toBe(0);
  });

  it("tells the owner a key was already revoked rather than answering ok", async () => {
    const { id } = await createKey();

    const first = await request(ctx.app, "DELETE", `/keys/${id}`, {
      headers: {
        cookie: ctx.owner.cookie,
        origin: new URL(ctx.config.authBaseUrl).origin,
      },
    });
    expect(first.status).toBe(200);

    expect(await revokeAudits(id)).toBe(1);

    const second = await request(ctx.app, "DELETE", `/keys/${id}`, {
      headers: {
        cookie: ctx.owner.cookie,
        origin: new URL(ctx.config.authBaseUrl).origin,
      },
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
      headers: {
        cookie: ctx.owner.cookie,
        origin: new URL(ctx.config.authBaseUrl).origin,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await revokeAudits(id)).toBe(1);
    expect(await ctx.storage.keys.get(id)).toBeNull();
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
    const { token } = await seedOauthBearer(oauthCtx, ["openid"], {});
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
      oauthCtx,
      grantScopes("core.*:write"),
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
      oauthCtx,
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
    expect(stored).not.toHaveProperty("is_operator");
  });

  it("refuses reach the grant does not cover, and names the literal", async () => {
    const { token } = await seedOauthBearer(
      oauthCtx,
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
      oauthCtx,
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

  it("rejects the removed authority field from a signed-in app", async () => {
    const { token } = await seedOauthBearer(oauthCtx, grantScopes(), {});
    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "platform",
        source: "platform",
        is_operator: true,
      },
    });
    // Removed fields are invalid, including when supplied by an approved app.
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("validation_error");
    expect(
      (await oauthCtx.storage.keys.list()).some((k) => k.label === "platform"),
    ).toBe(false);
  });

  it("records the grant on the audit row, so a revoked app leads to its keys", async () => {
    const { token, clientId } = await seedOauthBearer(
      oauthCtx,
      grantScopes("core.note:read"),
      {},
    );
    const res = await request(oauthCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "audited", source: "audited" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const audits = await oauthCtx.storage.audit.list({ action: "key.create" });
    expect(audits.data.some((row) => row.resource_id === created.id)).toBe(
      true,
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
    const { token } = await seedOauthBearer(oauthCtx, grantScopes(), {});
    const raw = "marfa_k1_sess_" + Math.random().toString(36).slice(2);
    const target = await oauthCtx.storage.keys.create(
      {
        label: "target",
        source: "target-" + Math.random().toString(36).slice(2),
        type_permissions: {},
        default_tier: "library",
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
      oauthCtx,
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
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
    );

    const { token } = await seedOauthBearer(
      oauthCtx,
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
      oauthCtx,
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
    // `namesNoFamily` reads `permissions`, the five maps and the claims. The grant below projects a
    // non-empty edge map as well as a type map, so the derive path has
    // something to hand over — without which this assertion would pass
    // whether or not the condition were right, which is what the first
    // version of it did.
    const { token } = await seedOauthBearer(
      oauthCtx,
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
    expect(derivedKey?.edge_permissions.about).toBe("read");

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
    // going missing from `namesNoFamily`: naming only the edge family must
    // stop the type map deriving too, or a caller asking for a narrow key
    // silently receives the session's own reach instead.
    const { token } = await seedOauthBearer(
      oauthCtx,
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

  it("measures a metadata wildcard on the metadata axis, not the type axis", async () => {
    // `metadata.*:write` is well-formed on the WRONG axis: it misses the
    // sub-resource matcher, clears `isValidTypePattern` because `metadata` is
    // a valid root, and parses as an item-type grant. A plain content grant
    // then covers it, so this case is a fail-open unless the bare form is
    // used — and `"*"` is the ordinary key, since it is what a bare
    // `metadata:<verb>` grant projects to.
    const contentOnly = await seedOauthBearer(
      oauthCtx,
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
      oauthCtx,
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

describe("POST /keys — what the direct owner mints", () => {
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
      headers: {
        cookie: oauthCtx.owner.cookie,
        origin: new URL(oauthCtx.config.authBaseUrl).origin,
      },
      body: {
        label: `seeded-${suffix}`,
        source: `seeded-${suffix}`,
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await oauthCtx.storage.keys.get(minted.id);
    expect(stored).not.toHaveProperty("is_operator");
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
      headers: {
        cookie: oauthCtx.owner.cookie,
        origin: new URL(oauthCtx.config.authBaseUrl).origin,
      },
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
    expect(stored).not.toHaveProperty("is_operator");
    expect(stored?.type_permissions).toEqual({ "core.note": "read" });
    expect(stored?.edge_permissions).toEqual({});
    expect(stored?.permissions).toEqual(["keys.mint"]);
  });

  it("mints a key naming a map and no permissions with no permissions, from the owner or a working key", async () => {
    // Naming a map is naming what the key holds, so the permissions left
    // unnamed are held no more than the maps left unnamed. The witness is
    // the case above: the same mint naming nothing takes every permission.
    for (const minter of [undefined, oauthCtx.workingKey]) {
      const suffix = Math.random().toString(36).slice(2, 10);
      const res = await request(oauthCtx.app, "POST", "/keys", {
        ...(minter
          ? { key: minter }
          : {
              headers: {
                cookie: oauthCtx.owner.cookie,
                origin: new URL(oauthCtx.config.authBaseUrl).origin,
              },
            }),
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
      headers: {
        cookie: oauthCtx.owner.cookie,
        origin: new URL(oauthCtx.config.authBaseUrl).origin,
      },
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
      headers: {
        cookie: oauthCtx.owner.cookie,
        origin: new URL(oauthCtx.config.authBaseUrl).origin,
      },
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

  it("refuses a request with no credential", async () => {
    const res = await request(oauthCtx.app, "GET", "/keys/current", {});
    expect(res.status).toBe(401);
  });

  it("mints the two-hop credential chain a black-box client relies on", async () => {
    // The conformance suite provisions with the direct owner and then runs as
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
    expect(stored).not.toHaveProperty("is_operator");
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
    expect(stored).not.toHaveProperty("is_operator");
  });
});

describe("ordinary keys never establish machine authority", () => {
  it("refuses an unauthenticated mint before and after claim", async () => {
    const fresh = await createUnclaimedTestApp();
    try {
      expect(
        (
          await request(fresh.app, "POST", "/keys", {
            body: { label: "no-authority", source: "no-authority" },
          })
        ).status,
      ).toBe(401);
      const witness = await ctx.ownerRequest("/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "owner-witness",
          source: "owner-witness",
          permissions: [],
        }),
      });
      expect(witness.status).toBe(201);
      expect(
        (
          await request(ctx.app, "POST", "/keys", {
            body: { label: "still-no-authority", source: "still-no-authority" },
          })
        ).status,
      ).toBe(401);
    } finally {
      await fresh.cleanup();
    }
  });
  it("rejects a removed privileged-key field even from the owner", async () => {
    const response = await ctx.ownerRequest("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "removed",
        source: "removed",
        is_operator: true,
      }),
    });
    expect(response.status).toBe(400);
  });
});
