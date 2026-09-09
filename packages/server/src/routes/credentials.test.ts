/**
 * Tests for `POST /credentials/oauth-provider`.
 *
 * Coverage:
 *   - Auth gate: unauthenticated → 401; a key without `space.credentials`
 *     → 403; one holding it OK.
 *   - Happy path: 201 + credential_id; the resulting `system.credential` row
 *     has the right shape; the encrypted secret round-trips back to the
 *     original via `decryptSecret`.
 *   - Validation: malformed URL fields → 400.
 *   - Audit trail: `credential.oauth_provider.create` row written.
 *   - Removal: `DELETE /credentials/{id}` gates on `space.credentials`, refuses
 *     while a live connection references the credential, and otherwise
 *     removes the row and the secret it held.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  waitForAudit,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { decryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function uniqueSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A key holding no space permission, so every credentials door refuses it. */
async function mintUnprivilegedKey(): Promise<string> {
  const suffix = uniqueSuffix();
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.spaceKey,
    body: {
      label: `no-permission-test-${suffix}`,
      source: `no-permission-test-${suffix}`,
      space_permissions: [],
      type_permissions: {},
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { key: string };
  return body.key;
}

// Built through the storage layer rather than `POST /keys`, because the
// minting caller here carries no space and so mints only space-less keys.
// What these cases need is the opposite shape — a credential bound to a
// space and holding `space.credentials` — so the fixture stamps the space
// directly instead of routing around the rule.
async function mintSpaceCredentialsKey(): Promise<string> {
  const suffix = uniqueSuffix();
  const raw = `marfa_k1_space_credentials_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: `space-credentials-test-${suffix}`,
      source: `space-credentials-test-${suffix}`,
      space_permissions: ["space.credentials"],
      type_permissions: {},
      default_tier: "library",
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    `space-credentials-${suffix}`,
  );
  return raw;
}

const VALID_BODY = {
  label: "Google (test)",
  oauth_authorize_url: "https://accounts.google.com/o/oauth2/auth",
  oauth_token_url: "https://oauth2.googleapis.com/token",
  oauth_client_id: "test-client-id.apps.googleusercontent.com",
  oauth_client_secret: "GOCSPX-supersecretvalue",
  upstream_base_url: "https://www.googleapis.com",
  oauth_default_scope: "https://www.googleapis.com/auth/calendar.events",
};

describe("POST /credentials/oauth-provider — auth gate", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      body: VALID_BODY,
    });
    expect(res.status).toBe(401);
  });

  it("rejects a key without space.credentials with 403", async () => {
    const unprivilegedKey = await mintUnprivilegedKey();
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: unprivilegedKey,
      body: VALID_BODY,
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /credentials/oauth-provider — happy path", () => {
  it("creates a system.credential of kind oauth_token with the right shape", async () => {
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: ctx.spaceKey,
      body: VALID_BODY,
    });
    expect(res.status).toBe(201);
    const { credential_id } = (await res.json()) as { credential_id: string };
    expect(credential_id).toMatch(/^[a-z0-9-]+$/i);

    const credential = await ctx.storage.items.get(credential_id);
    expect(credential?.type).toBe("system.credential");
    const props = credential?.properties as {
      label: string;
      kind: string;
      oauth_provider_config: {
        oauth_authorize_url: string;
        oauth_token_url: string;
        oauth_client_id: string;
        upstream_base_url: string;
        oauth_default_scope?: string;
      };
      secret_encrypted: string;
    };
    expect(props.label).toBe(VALID_BODY.label);
    expect(props.kind).toBe("oauth_token");
    expect(props.oauth_provider_config).toEqual({
      oauth_authorize_url: VALID_BODY.oauth_authorize_url,
      oauth_token_url: VALID_BODY.oauth_token_url,
      oauth_client_id: VALID_BODY.oauth_client_id,
      upstream_base_url: VALID_BODY.upstream_base_url,
      oauth_default_scope: VALID_BODY.oauth_default_scope,
    });
    expect(typeof props.secret_encrypted).toBe("string");
    expect(props.secret_encrypted.length).toBeGreaterThan(0);

    const plaintext = decryptSecret(
      props.secret_encrypted,
      SECRET_INFO.connectionOauthToken,
    );
    expect(plaintext).toBe(VALID_BODY.oauth_client_secret);
  });

  it("a space key holding space.credentials can create credentials too", async () => {
    const spaceKey = await mintSpaceCredentialsKey();
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: spaceKey,
      body: { ...VALID_BODY, label: "Google (space credentials key)" },
    });
    expect(res.status).toBe(201);
  });

  it("omits oauth_default_scope when not supplied", async () => {
    const { oauth_default_scope: _, ...withoutScope } = VALID_BODY;
    void _;
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: ctx.spaceKey,
      body: withoutScope,
    });
    expect(res.status).toBe(201);
    const { credential_id } = (await res.json()) as { credential_id: string };
    const credential = await ctx.storage.items.get(credential_id);
    const cfg = (
      credential?.properties as {
        oauth_provider_config: Record<string, unknown>;
      }
    ).oauth_provider_config;
    expect(cfg).not.toHaveProperty("oauth_default_scope");
  });

  it("writes a credential.oauth_provider.create audit row", async () => {
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: ctx.spaceKey,
      body: { ...VALID_BODY, label: "Audit test" },
    });
    expect(res.status).toBe(201);
    const { credential_id } = (await res.json()) as { credential_id: string };

    const audits = await waitForAudit(
      () =>
        ctx.storage.audit.list({
          action: "credential.oauth_provider.create",
        }),
      (r) => r.data.some((row) => row.resource_id === credential_id),
    );
    const row = audits.data.find((r) => r.resource_id === credential_id);
    expect(row).toBeTruthy();
    expect(row?.details).toMatchObject({
      label: "Audit test",
      oauth_client_id: VALID_BODY.oauth_client_id,
      upstream_base_url: VALID_BODY.upstream_base_url,
    });
  });
});

describe("POST /credentials/oauth-provider — validation", () => {
  it("rejects malformed oauth_authorize_url with 400", async () => {
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: ctx.spaceKey,
      body: { ...VALID_BODY, oauth_authorize_url: "not-a-url" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing required fields with 400", async () => {
    const { oauth_client_id: _, ...incomplete } = VALID_BODY;
    void _;
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: ctx.spaceKey,
      body: incomplete,
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty oauth_client_secret with 400", async () => {
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: ctx.spaceKey,
      body: { ...VALID_BODY, oauth_client_secret: "" },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /credentials/api-token
// ---------------------------------------------------------------------------

const VALID_API_TOKEN_BODY = {
  label: "Todoist (test)",
  upstream_base_url: "https://api.todoist.com",
  api_token: "td-test-token-deadbeef",
};

describe("POST /credentials/api-token — auth gate", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      body: VALID_API_TOKEN_BODY,
    });
    expect(res.status).toBe(401);
  });

  it("rejects a key without space.credentials with 403", async () => {
    const unprivilegedKey = await mintUnprivilegedKey();
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: unprivilegedKey,
      body: VALID_API_TOKEN_BODY,
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /credentials/api-token — happy path", () => {
  it("creates a system.credential of kind api_token with the right shape", async () => {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.spaceKey,
      body: VALID_API_TOKEN_BODY,
    });
    expect(res.status).toBe(201);
    const { credential_id } = (await res.json()) as { credential_id: string };
    expect(credential_id).toMatch(/^[a-z0-9-]+$/i);

    const credential = await ctx.storage.items.get(credential_id);
    expect(credential?.type).toBe("system.credential");
    const props = credential?.properties as {
      label: string;
      kind: string;
      api_token_config: { upstream_base_url: string };
      secret_encrypted: string;
    };
    expect(props.label).toBe(VALID_API_TOKEN_BODY.label);
    expect(props.kind).toBe("api_token");
    expect(props.api_token_config).toEqual({
      upstream_base_url: VALID_API_TOKEN_BODY.upstream_base_url,
    });
    expect(typeof props.secret_encrypted).toBe("string");
    expect(props.secret_encrypted.length).toBeGreaterThan(0);
    expect(props.secret_encrypted).not.toContain(
      VALID_API_TOKEN_BODY.api_token,
    );

    const plaintext = decryptSecret(
      props.secret_encrypted,
      SECRET_INFO.connectionOauthToken,
    );
    expect(plaintext).toBe(VALID_API_TOKEN_BODY.api_token);
  });

  it("a space key holding space.credentials can create api_token credentials too", async () => {
    const spaceKey = await mintSpaceCredentialsKey();
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: spaceKey,
      body: {
        ...VALID_API_TOKEN_BODY,
        label: "Todoist (space credentials key)",
      },
    });
    expect(res.status).toBe(201);
  });

  it("persists auth_scheme on api_token_config when supplied", async () => {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.spaceKey,
      body: {
        ...VALID_API_TOKEN_BODY,
        label: "Readwise (auth_scheme Token)",
        upstream_base_url: "https://readwise.io",
        auth_scheme: "Token",
      },
    });
    expect(res.status).toBe(201);
    const { credential_id } = (await res.json()) as { credential_id: string };
    const credential = await ctx.storage.items.get(credential_id);
    expect(
      (credential?.properties as { api_token_config: Record<string, unknown> })
        .api_token_config,
    ).toEqual({
      upstream_base_url: "https://readwise.io",
      auth_scheme: "Token",
    });
  });

  it("omits auth_scheme on api_token_config when not supplied — proxy falls back to Bearer", async () => {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.spaceKey,
      body: { ...VALID_API_TOKEN_BODY, label: "Default scheme" },
    });
    expect(res.status).toBe(201);
    const { credential_id } = (await res.json()) as { credential_id: string };
    const credential = await ctx.storage.items.get(credential_id);
    const cfg = (
      credential?.properties as { api_token_config: Record<string, unknown> }
    ).api_token_config;
    expect(cfg).not.toHaveProperty("auth_scheme");
    expect(cfg.upstream_base_url).toBe(VALID_API_TOKEN_BODY.upstream_base_url);
  });

  it("rejects unknown auth_scheme values with 400", async () => {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.spaceKey,
      body: { ...VALID_API_TOKEN_BODY, auth_scheme: "Negotiate" },
    });
    expect(res.status).toBe(400);
  });

  it("writes a credential.api_token.create audit row without leaking the token", async () => {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.spaceKey,
      body: { ...VALID_API_TOKEN_BODY, label: "Audit test (api)" },
    });
    expect(res.status).toBe(201);
    const { credential_id } = (await res.json()) as { credential_id: string };

    const audits = await waitForAudit(
      () =>
        ctx.storage.audit.list({
          action: "credential.api_token.create",
        }),
      (r) => r.data.some((row) => row.resource_id === credential_id),
    );
    const row = audits.data.find((r) => r.resource_id === credential_id);
    expect(row).toBeTruthy();
    expect(row?.details).toMatchObject({
      label: "Audit test (api)",
      upstream_base_url: VALID_API_TOKEN_BODY.upstream_base_url,
    });
    expect(JSON.stringify(row?.details ?? {})).not.toContain(
      VALID_API_TOKEN_BODY.api_token,
    );
  });
});

describe("POST /credentials/api-token — validation", () => {
  it("rejects malformed upstream_base_url with 400", async () => {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.spaceKey,
      body: { ...VALID_API_TOKEN_BODY, upstream_base_url: "not-a-url" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty api_token with 400", async () => {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.spaceKey,
      body: { ...VALID_API_TOKEN_BODY, api_token: "" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing label with 400", async () => {
    const { label: _, ...incomplete } = VALID_API_TOKEN_BODY;
    void _;
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.spaceKey,
      body: incomplete,
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /credentials/{id}", () => {
  async function makeCredential(label: string): Promise<string> {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.spaceKey,
      body: { ...VALID_API_TOKEN_BODY, label },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { credential_id: string }).credential_id;
  }

  it("requires space.credentials", async () => {
    const id = await makeCredential("delete-auth-gate");
    const unprivilegedKey = await mintUnprivilegedKey();
    const res = await request(ctx.app, "DELETE", `/credentials/${id}`, {
      key: unprivilegedKey,
    });
    expect(res.status).toBe(403);
  });

  it("removes the credential and the secret it held", async () => {
    const id = await makeCredential("delete-happy-path");
    expect(await ctx.storage.items.get(id)).not.toBeNull();

    const res = await request(ctx.app, "DELETE", `/credentials/${id}`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, credential_id: id });

    // Gone, not orphaned. This is the whole point: the user's own secret
    // has to be removable, and a soft-deleted row still holds it.
    expect(await ctx.storage.items.get(id)).toBeNull();
  });

  it("a space key holding space.credentials can remove a credential it created", async () => {
    const spaceKey = await mintSpaceCredentialsKey();
    const created = await request(ctx.app, "POST", "/credentials/api-token", {
      key: spaceKey,
      body: { ...VALID_API_TOKEN_BODY, label: "space-credentials-key-owned" },
    });
    expect(created.status).toBe(201);
    const { credential_id } = (await created.json()) as {
      credential_id: string;
    };

    const res = await request(
      ctx.app,
      "DELETE",
      `/credentials/${credential_id}`,
      { key: spaceKey },
    );
    expect(res.status).toBe(200);
  });

  it("refuses while a connection that is not revoked references it", async () => {
    const id = await makeCredential("delete-in-use");
    const connection = await ctx.storage.items.create({
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        credential_ref: id,
      },
    });

    const res = await request(ctx.app, "DELETE", `/credentials/${id}`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: { connection_ids?: string[] } };
    };
    expect(body.error.code).toBe("credential_in_use");
    expect(body.error.details?.connection_ids).toContain(connection.id);

    // Still there — a refused delete must not half-remove anything.
    expect(await ctx.storage.items.get(id)).not.toBeNull();
  });

  it("allows removal once the referencing connection is revoked", async () => {
    const id = await makeCredential("delete-after-revoke");
    const connection = await ctx.storage.items.create({
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        credential_ref: id,
      },
    });
    await ctx.storage.items.transition(connection.id, "revoked");

    const res = await request(ctx.app, "DELETE", `/credentials/${id}`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    expect(await ctx.storage.items.get(id)).toBeNull();
  });

  it("404s on an unknown credential, and on an item that is not one", async () => {
    const missing = await request(
      ctx.app,
      "DELETE",
      "/credentials/01a00000-0000-7000-8000-000000000000",
      { key: ctx.spaceKey },
    );
    expect(missing.status).toBe(404);

    const note = await ctx.storage.items.create({
      type: "core.note",
      properties: { body: "not a credential" },
    });
    const wrongType = await request(
      ctx.app,
      "DELETE",
      `/credentials/${note.id}`,
      { key: ctx.spaceKey },
    );
    expect(wrongType.status).toBe(404);
  });

  it("writes an audit row", async () => {
    const id = await makeCredential("delete-audit");
    const res = await request(ctx.app, "DELETE", `/credentials/${id}`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const audits = await waitForAudit(
      () => ctx.storage.audit.list({ action: "credential.delete" }),
      (r) => r.data.some((row) => row.resource_id === id),
    );
    expect(audits.data.some((row) => row.resource_id === id)).toBe(true);
  });
});
