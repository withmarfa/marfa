/**
 * Direct tests of the install pipeline's compensating-write behavior.
 *
 * The HTTP-level happy path is covered by routes/integrations.test.ts.
 * These tests exercise rollback paths that are awkward to trigger
 * through the route — specifically a credential-mint failure forced via
 * a duplicate `source` collision on the apiKeys table.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { performInstall } from "./install-pipeline.js";
import type { IntegrationManifest } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function manifest(): IntegrationManifest {
  return {
    name: "acme.install-pipeline-direct",
    version: "1.0.0",
    publisher: "Acme",
    description: "direct install test",
    direction: "both",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    runtime_compatibility: ["hosted"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "prompt-user",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "1.0.0",
  };
}

/**
 * The Connection row the mint re-reads under the lifecycle lock. The
 * stubs below never persist anything, so the read has to be answered
 * with a row in the state the pipeline just created.
 */
function activeConnection(id: string): {
  id: string;
  type: string;
  state: string;
  space_id: string | null;
  properties: Record<string, unknown>;
} {
  return {
    id,
    type: "system.connection",
    state: "active",
    space_id: null,
    properties: { kind: "integration", status: "active" },
  };
}

/**
 * A `CoordinationStore` that records the bracket around whatever runs
 * inside it. Recording both edges is what lets the sequence assertions
 * below say the credential mint happens *under* the lock rather than
 * merely near it.
 */
function lockRecorder(calls: string[]): {
  withExclusiveLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
  withJobLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined>;
} {
  return {
    async withExclusiveLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
      calls.push(`lock:${name}`);
      try {
        return await fn();
      } finally {
        calls.push(`unlock:${name}`);
      }
    },
    withJobLock<T>(
      _name: string,
      fn: () => Promise<T>,
    ): Promise<T | undefined> {
      return fn();
    },
  };
}

describe("performInstall — happy path", () => {
  it("creates connection + credential + activity and returns their ids", async () => {
    const adminKey = await ctx.storage.keys
      .list()
      .then((keys) => keys.find((k) => k.role === "admin"));
    if (!adminKey) throw new Error("admin key not found in test ctx");

    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: "acme.install-pipeline-direct",
          manifest_version: "1.0.0",
          publisher: "Acme",
          direction: "both",
          runtime_compatibility: ["hosted"],
          manifest: manifest(),
          registered_at: new Date().toISOString(),
        },
      },
      undefined,
    );

    const result = await performInstall(ctx.storage, "test-salt", {
      apiKeyId: adminKey.id,
      spaceId: undefined,
      authMode: "keys",
      integrationItemId: integration.id,
      manifest: manifest(),
      label: "direct install",
    });

    expect(result.connection_id).toMatch(/^[0-9a-f-]+$/);
    expect(result.credential_id).toMatch(/^[0-9a-f-]+$/);
    expect(result.activity_id).toMatch(/^[0-9a-f-]+$/);

    const cred = (await ctx.storage.keys.list()).find(
      (k) => k.id === result.credential_id,
    );
    // Direction: both => write level on target types
    expect(cred?.type_permissions["core.note"]).toBe("write");
  });
});

describe("performInstall — compensating writes on activity failure", () => {
  it("rollback closures fire in reverse order when a later step throws", async () => {
    // Drive the rollback path through a stubbed storage. We don't need a
    // full Storage implementation — just enough surface for performInstall
    // to traverse: items.create (succeeds for connection), keys.createRuntimeCredential
    // (succeeds), items.create (THROWS for activity), then the rollback
    // must fire for credential.revoke + items.transition(connection,
    // revoked). `revoked` because `system.*` types carry the bounded
    // lifecycle and have no trash state.
    const calls: string[] = [];
    const stubStorage = {
      items: {
        create: async (input: {
          type: string;
        }): Promise<{ id: string; properties: Record<string, unknown> }> => {
          if (input.type === "system.connection") {
            calls.push("create:connection");
            return await Promise.resolve({
              id: "itm_conn_fake",
              properties: {},
            });
          }
          calls.push("create:activity:throw");
          throw new Error("forced activity failure");
        },
        get: (id: string): Promise<unknown> =>
          Promise.resolve(activeConnection(id)),
        transition: async (id: string, state: string): Promise<unknown> => {
          calls.push(`transition:${id}:${state}`);
          return await Promise.resolve(null);
        },
      },
      keys: {
        createRuntimeCredential: async (): Promise<{ id: string }> => {
          calls.push("create:credential");
          return await Promise.resolve({ id: "api_cred_fake" });
        },
        revoke: async (id: string): Promise<void> => {
          calls.push(`revoke:${id}`);
          await Promise.resolve();
        },
      },
      coordination: lockRecorder(calls),
      audit: {
        log: async (): Promise<void> => {
          calls.push("audit:log");
          await Promise.resolve();
        },
      },
    };

    await expect(
      performInstall(
        stubStorage as unknown as Parameters<typeof performInstall>[0],
        "test-salt",
        {
          apiKeyId: "api_admin",
          spaceId: undefined,
          authMode: "keys",
          integrationItemId: "itm_int_fake",
          manifest: manifest(),
          label: "rollback test",
        },
      ),
    ).rejects.toThrow(/forced activity failure/);

    // Rollback fires in reverse: credential revoke, then the Connection
    // to its terminal state. The lock brackets the mint and nothing else.
    expect(calls).toEqual([
      "create:connection",
      "lock:connection-lifecycle:itm_conn_fake",
      "create:credential",
      "unlock:connection-lifecycle:itm_conn_fake",
      "create:activity:throw",
      "revoke:api_cred_fake",
      "transition:itm_conn_fake:revoked",
    ]);
  });

  it("rolls back when audit.log throws", async () => {
    const calls: string[] = [];
    const stubStorage = {
      items: {
        create: async (input: {
          type: string;
        }): Promise<{ id: string; properties: Record<string, unknown> }> => {
          if (input.type === "system.connection") {
            calls.push("create:connection");
            return await Promise.resolve({
              id: "itm_conn_audit",
              properties: {},
            });
          }
          calls.push("create:activity");
          return await Promise.resolve({
            id: "itm_act_audit",
            properties: {},
          });
        },
        get: (id: string): Promise<unknown> =>
          Promise.resolve(activeConnection(id)),
        transition: async (id: string, state: string): Promise<unknown> => {
          calls.push(`transition:${id}:${state}`);
          return await Promise.resolve(null);
        },
      },
      keys: {
        createRuntimeCredential: async (): Promise<{ id: string }> => {
          calls.push("create:credential");
          return await Promise.resolve({ id: "api_cred_audit" });
        },
        revoke: async (id: string): Promise<void> => {
          calls.push(`revoke:${id}`);
          await Promise.resolve();
        },
      },
      coordination: lockRecorder(calls),
      audit: {
        log: (): Promise<void> => {
          calls.push("audit:log:throw");
          return Promise.reject(new Error("audit DB unavailable"));
        },
      },
    };

    await expect(
      performInstall(
        stubStorage as unknown as Parameters<typeof performInstall>[0],
        "test-salt",
        {
          apiKeyId: "api_admin",
          spaceId: undefined,
          authMode: "keys",
          integrationItemId: "itm_int_fake",
          manifest: manifest(),
          label: "audit-failure test",
        },
      ),
    ).rejects.toThrow(/audit DB unavailable/);

    // The audit failure throws, the rollback walks the stack, and the
    // Connection reaches its terminal state.
    expect(calls).toEqual([
      "create:connection",
      "lock:connection-lifecycle:itm_conn_audit",
      "create:credential",
      "unlock:connection-lifecycle:itm_conn_audit",
      "create:activity",
      "audit:log:throw",
      "revoke:api_cred_audit",
      "transition:itm_conn_audit:revoked",
    ]);
  });

  it("rollback walks compensations in reverse push order without mutating", async () => {
    // Rollback iterates via a downward index rather than calling
    // `compensations.reverse()`, which would mutate in place. The array
    // stays in push order so any recovery code that re-invokes rollback
    // walks the same reversed sequence each time.
    //
    // Verified by failing partway through a multi-step install and
    // asserting the observable call sequence.
    const calls: string[] = [];
    const stubStorage = {
      items: {
        create: (input: {
          type: string;
        }): Promise<{ id: string; properties: Record<string, unknown> }> => {
          calls.push(`create:${input.type}`);
          return Promise.resolve({
            id: `itm_${String(calls.length)}`,
            properties: {},
          });
        },
        get: (id: string): Promise<unknown> =>
          Promise.resolve(activeConnection(id)),
        transition: (id: string, state: string): Promise<unknown> => {
          calls.push(`transition:${id}:${state}`);
          return Promise.resolve(null);
        },
      },
      keys: {
        createRuntimeCredential: (): Promise<{ id: string }> => {
          calls.push("create:credential:throw");
          return Promise.reject(new Error("forced credential failure"));
        },
        revoke: (id: string): Promise<void> => {
          calls.push(`revoke:${id}`);
          return Promise.resolve();
        },
      },
      coordination: lockRecorder(calls),
      audit: {
        log: (): Promise<void> => Promise.resolve(),
      },
    };

    await expect(
      performInstall(
        stubStorage as unknown as Parameters<typeof performInstall>[0],
        "test-salt",
        {
          apiKeyId: "api_admin",
          spaceId: undefined,
          authMode: "keys",
          integrationItemId: "itm_int_fake",
          manifest: manifest(),
          label: "rollback-reinvoke test",
        },
      ),
    ).rejects.toThrow(/forced credential failure/);

    expect(calls).toEqual([
      "create:system.connection",
      "lock:connection-lifecycle:itm_1",
      "create:credential:throw",
      "unlock:connection-lifecycle:itm_1",
      "transition:itm_1:revoked",
    ]);
  });
});

describe("performInstall — credentialRef (OAuth provider credential reuse)", () => {
  async function setupIntegrationItem(): Promise<string> {
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: "acme.install-pipeline-direct",
          manifest_version: "1.0.0",
          publisher: "Acme",
          direction: "both",
          runtime_compatibility: ["hosted"],
          manifest: manifest(),
          registered_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    return integration.id;
  }

  async function setupOauthCredential(): Promise<string> {
    const credential = await ctx.storage.items.create(
      {
        type: "system.credential",
        properties: {
          label: "shared-oauth-provider",
          kind: "oauth_token",
          oauth_provider_config: {
            oauth_authorize_url: "https://example.com/oauth/authorize",
            oauth_token_url: "https://example.com/oauth/token",
            oauth_client_id: "shared-client",
            upstream_base_url: "https://api.example.com",
          },
          secret_encrypted:
            "test-encrypted-placeholder|test-encrypted-placeholder|tag",
        },
      },
      undefined,
    );
    return credential.id;
  }

  it("stamps credential_ref onto the connection when supplied", async () => {
    const adminKey = await ctx.storage.keys
      .list()
      .then((keys) => keys.find((k) => k.role === "admin"));
    if (!adminKey) throw new Error("admin key not found in test ctx");

    const integrationId = await setupIntegrationItem();
    const credentialId = await setupOauthCredential();
    // Count the system.credential rows whose oauth_provider_config has the
    // same client_id as the one we'll reference. After install, this count
    // must stay 1 — a second install with the same credential_ref must not
    // duplicate the provider credential.
    function countSharedProviderCredentials(): Promise<number> {
      return ctx.storage.items.list({ type: "system.credential" }).then(
        (page) =>
          page.data.filter((c) => {
            const cfg = (
              c.properties as {
                oauth_provider_config?: { oauth_client_id?: string };
              }
            ).oauth_provider_config;
            return cfg?.oauth_client_id === "shared-client";
          }).length,
      );
    }
    expect(await countSharedProviderCredentials()).toBe(1);

    const result = await performInstall(ctx.storage, "test-salt", {
      apiKeyId: adminKey.id,
      spaceId: undefined,
      authMode: "keys",
      integrationItemId: integrationId,
      manifest: manifest(),
      label: "with-credential-ref",
      credentialRef: credentialId,
    });

    const connection = await ctx.storage.items.get(result.connection_id);
    expect(connection?.type).toBe("system.connection");
    const props = connection?.properties as { credential_ref?: string };
    expect(props.credential_ref).toBe(credentialId);

    // The OAuth provider credential count must not have grown — the
    // existing row was reused, not duplicated. The runtime credential
    // (kind: api_key, lives on the api_keys table, not as a
    // system.credential item) is still freshly minted, which is correct
    // and doesn't affect this count.
    expect(await countSharedProviderCredentials()).toBe(1);
  });

  it("rejects when credential_ref does not resolve", async () => {
    const adminKey = await ctx.storage.keys
      .list()
      .then((keys) => keys.find((k) => k.role === "admin"));
    if (!adminKey) throw new Error("admin key not found in test ctx");

    const integrationId = await setupIntegrationItem();

    await expect(
      performInstall(ctx.storage, "test-salt", {
        apiKeyId: adminKey.id,
        spaceId: undefined,
        authMode: "keys",
        integrationItemId: integrationId,
        manifest: manifest(),
        label: "bad-credential-ref",
        credentialRef: "itm_credref_does_not_exist",
      }),
    ).rejects.toThrow(/does not resolve/);
  });

  it("rejects when credential_ref points to a kind the install pipeline doesn't accept (api_key)", async () => {
    const adminKey = await ctx.storage.keys
      .list()
      .then((keys) => keys.find((k) => k.role === "admin"));
    if (!adminKey) throw new Error("admin key not found in test ctx");

    const integrationId = await setupIntegrationItem();
    const wrongKindCredential = await ctx.storage.items.create(
      {
        type: "system.credential",
        properties: { label: "wrong-kind", kind: "api_key" },
      },
      undefined,
    );

    await expect(
      performInstall(ctx.storage, "test-salt", {
        apiKeyId: adminKey.id,
        spaceId: undefined,
        authMode: "keys",
        integrationItemId: integrationId,
        manifest: manifest(),
        label: "wrong-kind-credential-ref",
        credentialRef: wrongKindCredential.id,
      }),
    ).rejects.toThrow(/expected 'oauth_token' or 'api_token'/);
  });

  it("accepts credential_ref pointing at a system.credential of kind 'api_token'", async () => {
    const adminKey = await ctx.storage.keys
      .list()
      .then((keys) => keys.find((k) => k.role === "admin"));
    if (!adminKey) throw new Error("admin key not found in test ctx");

    const integrationId = await setupIntegrationItem();
    const apiTokenCredential = await ctx.storage.items.create(
      {
        type: "system.credential",
        properties: {
          label: "todoist-test-token",
          kind: "api_token",
          api_token_config: { upstream_base_url: "https://api.todoist.com" },
          secret_encrypted:
            "test-encrypted-placeholder|test-encrypted-placeholder|tag",
        },
      },
      undefined,
    );

    const result = await performInstall(ctx.storage, "test-salt", {
      apiKeyId: adminKey.id,
      spaceId: undefined,
      authMode: "keys",
      integrationItemId: integrationId,
      manifest: manifest(),
      label: "with-api-token-credential",
      credentialRef: apiTokenCredential.id,
    });

    const connection = await ctx.storage.items.get(result.connection_id);
    expect(connection?.type).toBe("system.connection");
    const props = connection?.properties as { credential_ref?: string };
    expect(props.credential_ref).toBe(apiTokenCredential.id);
  });

  it("connection has no credential_ref when credentialRef is omitted", async () => {
    const adminKey = await ctx.storage.keys
      .list()
      .then((keys) => keys.find((k) => k.role === "admin"));
    if (!adminKey) throw new Error("admin key not found in test ctx");

    const integrationId = await setupIntegrationItem();

    const result = await performInstall(ctx.storage, "test-salt", {
      apiKeyId: adminKey.id,
      spaceId: undefined,
      authMode: "keys",
      integrationItemId: integrationId,
      manifest: manifest(),
      label: "no-credential-ref",
    });

    const connection = await ctx.storage.items.get(result.connection_id);
    const props = connection?.properties as { credential_ref?: string };
    expect(props.credential_ref).toBeUndefined();
  });
});
