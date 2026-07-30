/**
 * Tests for `POST /credentials/oauth-provider`.
 *
 * Coverage:
 *   - Auth gate: unauthenticated → 401; member key → 403; space_admin OK.
 *   - Happy path: 201 + credential_id; the resulting `system.credential` row
 *     has the right shape; the encrypted secret round-trips back to the
 *     original via `decryptSecret`.
 *   - Validation: malformed URL fields → 400.
 *   - Audit trail: `credential.oauth_provider.create` row written.
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

async function mintMemberKey(): Promise<string> {
  const suffix = uniqueSuffix();
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.adminKey,
    body: {
      label: `member-test-${suffix}`,
      source: `member-test-${suffix}`,
      role: "member",
      type_permissions: {},
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { key: string };
  return body.key;
}

// Built through the storage layer rather than `POST /keys`, which refuses
// to mint a `space_admin` key from a caller that has no space to pass on
// (the resulting credential would not stop at the boundary its role names).
// These tests only need a credential that carries the role, so the fixture
// stamps a space directly instead of routing around the rule.
async function mintSpaceAdminKey(): Promise<string> {
  const suffix = uniqueSuffix();
  const raw = `marfa_k1_space_admin_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: `space-admin-test-${suffix}`,
      source: `space-admin-test-${suffix}`,
      role: "space_admin",
      type_permissions: {},
      default_tier: "library",
      is_platform: false,
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

  it("rejects member keys with 403", async () => {
    const memberKey = await mintMemberKey();
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: memberKey,
      body: VALID_BODY,
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /credentials/oauth-provider — happy path", () => {
  it("creates a system.credential of kind oauth_token with the right shape", async () => {
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: ctx.adminKey,
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

  it("space_admin keys can create credentials too", async () => {
    const spaceAdminKey = await mintSpaceAdminKey();
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: spaceAdminKey,
      body: { ...VALID_BODY, label: "Google (space_admin)" },
    });
    expect(res.status).toBe(201);
  });

  it("omits oauth_default_scope when not supplied", async () => {
    const { oauth_default_scope: _, ...withoutScope } = VALID_BODY;
    void _;
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: ctx.adminKey,
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
      key: ctx.adminKey,
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
      key: ctx.adminKey,
      body: { ...VALID_BODY, oauth_authorize_url: "not-a-url" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing required fields with 400", async () => {
    const { oauth_client_id: _, ...incomplete } = VALID_BODY;
    void _;
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: ctx.adminKey,
      body: incomplete,
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty oauth_client_secret with 400", async () => {
    const res = await request(ctx.app, "POST", "/credentials/oauth-provider", {
      key: ctx.adminKey,
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

  it("rejects member keys with 403", async () => {
    const memberKey = await mintMemberKey();
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: memberKey,
      body: VALID_API_TOKEN_BODY,
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /credentials/api-token — happy path", () => {
  it("creates a system.credential of kind api_token with the right shape", async () => {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.adminKey,
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

  it("space_admin keys can create api_token credentials too", async () => {
    const spaceAdminKey = await mintSpaceAdminKey();
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: spaceAdminKey,
      body: { ...VALID_API_TOKEN_BODY, label: "Todoist (space_admin)" },
    });
    expect(res.status).toBe(201);
  });

  it("persists auth_scheme on api_token_config when supplied", async () => {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.adminKey,
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
      key: ctx.adminKey,
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
      key: ctx.adminKey,
      body: { ...VALID_API_TOKEN_BODY, auth_scheme: "Negotiate" },
    });
    expect(res.status).toBe(400);
  });

  it("writes a credential.api_token.create audit row without leaking the token", async () => {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.adminKey,
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
      key: ctx.adminKey,
      body: { ...VALID_API_TOKEN_BODY, upstream_base_url: "not-a-url" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty api_token with 400", async () => {
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.adminKey,
      body: { ...VALID_API_TOKEN_BODY, api_token: "" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing label with 400", async () => {
    const { label: _, ...incomplete } = VALID_API_TOKEN_BODY;
    void _;
    const res = await request(ctx.app, "POST", "/credentials/api-token", {
      key: ctx.adminKey,
      body: incomplete,
    });
    expect(res.status).toBe(400);
  });
});
