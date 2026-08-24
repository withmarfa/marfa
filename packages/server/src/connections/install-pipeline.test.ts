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
import type { AuditLogEntry, AuditStore } from "../storage/interface.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function manifest(): IntegrationManifest {
  return {
    name: "acme/install-pipeline-direct",
    version: "1.0.0",
    publisher: "Acme",
    description: "direct install test",
    direction: "both",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "prompt-user",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
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
          manifest_name: "acme/install-pipeline-direct",
          manifest_version: "1.0.0",
          publisher: "Acme",
          direction: "both",
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

describe("performInstall — the manifest's declared defaults are written in", () => {
  // A declared `default` used to be inert: nothing read it on a write, so an
  // unconfigured key meant whatever each handler decided, and Google
  // Calendar's two branches came to disagree. Writing the default at install
  // leaves no unconfigured key for a handler to answer for.
  function manifestWithDefaults(): ReturnType<typeof manifest> {
    return {
      ...manifest(),
      target_types: ["core.note", "acme.note"],
      configuration_schema: {
        target_type: {
          type: "string",
          description: "Item type synced notes land as.",
          from_target_types: true,
          default: "acme.note",
        },
        page_size: {
          type: "number",
          description: "Items per page.",
          default: 50,
        },
        label: { type: "string", description: "No default declared." },
      },
    };
  }

  async function installedConfiguration(
    configuration?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const withDefaults = manifestWithDefaults();
    const adminKey = (await ctx.storage.keys.list())[0]!;
    const integration = await ctx.storage.items.create({
      type: "system.integration",
      properties: {
        manifest_name: withDefaults.name,
        manifest_version: withDefaults.version,
        publisher: withDefaults.publisher,
        direction: withDefaults.direction,
        manifest: withDefaults,
        registered_at: new Date().toISOString(),
      },
    });

    const result = await performInstall(ctx.storage, "test-salt", {
      apiKeyId: adminKey.id,
      spaceId: undefined,
      authMode: "keys",
      integrationItemId: integration.id,
      manifest: withDefaults,
      label: "defaults install",
      ...(configuration ? { configuration } : {}),
    });
    const connection = await ctx.storage.items.get(result.connection_id);
    return (
      connection?.properties as { configuration: Record<string, unknown> }
    ).configuration;
  }

  it("pins a declared default an install did not name", async () => {
    expect(await installedConfiguration()).toEqual({
      target_type: "acme.note",
      page_size: 50,
    });
  });

  it("leaves an explicit choice alone", async () => {
    const configuration = await installedConfiguration({
      target_type: "core.note",
    });
    expect(configuration.target_type).toBe("core.note");
    // The other declared default still lands: filling one key is not a
    // reason to skip the rest.
    expect(configuration.page_size).toBe(50);
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
        update: async (
          id: string,
          patch: { properties?: Record<string, unknown> },
        ): Promise<unknown> => {
          const p = patch.properties ?? {};
          // Every key, not only the two under test. The rollback writes a
          // delta and `items.update` merges it against what is stored, so a
          // stub that looked at `status` and `runtime_status` alone could not
          // tell that from resubmitting the whole create-time object, which
          // would revert anything that had touched the connection meanwhile.
          calls.push(
            `update:${id}:${Object.entries(p)
              .map(([k, v]) => `${k}=${String(v)}`)
              .sort()
              .join(",")}`,
          );
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
      runInTransaction: async <T>(fn: () => T | Promise<T>): Promise<T> => {
        calls.push("tx:begin");
        const out = await fn();
        calls.push("tx:commit");
        return out;
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

    // Rollback fires in reverse: credential revoke, then the Connection to
    // its terminal state. The lock brackets the mint and nothing else.
    //
    // The terminal state is three writes, not one, and they are asserted
    // together because that is the property. `properties.status` is the
    // type's own lifecycle status and every surface a person reads shows it
    // rather than the item's state, so a transition alone left a rolled-back
    // install rendering as active and healthy. One transaction, so a partial
    // failure cannot recreate the disagreement.
    expect(calls).toEqual([
      "create:connection",
      "lock:connection-lifecycle:itm_conn_fake",
      "create:credential",
      "unlock:connection-lifecycle:itm_conn_fake",
      "create:activity:throw",
      "revoke:api_cred_fake",
      "lock:connection-lifecycle:itm_conn_fake",
      "tx:begin",
      "transition:itm_conn_fake:revoked",
      "update:itm_conn_fake:runtime_status=revoked,status=revoked",
      "tx:commit",
      "unlock:connection-lifecycle:itm_conn_fake",
    ]);
  });

  it("rolls back in reverse order when the audit write throws", async () => {
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
        update: async (
          id: string,
          patch: { properties?: Record<string, unknown> },
        ): Promise<unknown> => {
          const p = patch.properties ?? {};
          // Every key, not only the two under test. The rollback writes a
          // delta and `items.update` merges it against what is stored, so a
          // stub that looked at `status` and `runtime_status` alone could not
          // tell that from resubmitting the whole create-time object, which
          // would revert anything that had touched the connection meanwhile.
          calls.push(
            `update:${id}:${Object.entries(p)
              .map(([k, v]) => `${k}=${String(v)}`)
              .sort()
              .join(",")}`,
          );
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
        // `logOrThrow`, not `log`. The stub used to reject from `log`,
        // which the real store cannot do, so the rollback this case pins
        // could not be reached in production at all. What is stubbed here
        // is the ordering fixture; the real writer's rejection is covered
        // against real storage below and in storage/audit-contract.test.ts.
        logOrThrow: (): Promise<void> => {
          calls.push("audit:log:throw");
          return Promise.reject(new Error("audit DB unavailable"));
        },
      },
      runInTransaction: async <T>(fn: () => T | Promise<T>): Promise<T> => {
        calls.push("tx:begin");
        const out = await fn();
        calls.push("tx:commit");
        return out;
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
      "lock:connection-lifecycle:itm_conn_audit",
      "tx:begin",
      "transition:itm_conn_audit:revoked",
      "update:itm_conn_audit:runtime_status=revoked,status=revoked",
      "tx:commit",
      "unlock:connection-lifecycle:itm_conn_audit",
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
        update: (
          id: string,
          patch: { properties?: Record<string, unknown> },
        ): Promise<unknown> => {
          const p = patch.properties ?? {};
          calls.push(
            `update:${id}:${Object.entries(p)
              .map(([k, v]) => `${k}=${String(v)}`)
              .sort()
              .join(",")}`,
          );
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
      runInTransaction: async <T>(fn: () => T | Promise<T>): Promise<T> => {
        calls.push("tx:begin");
        const out = await fn();
        calls.push("tx:commit");
        return out;
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
      "lock:connection-lifecycle:itm_1",
      "tx:begin",
      "transition:itm_1:revoked",
      "update:itm_1:runtime_status=revoked,status=revoked",
      "tx:commit",
      "unlock:connection-lifecycle:itm_1",
    ]);
  });
});

describe("performInstall — credentialRef (OAuth provider credential reuse)", () => {
  async function setupIntegrationItem(): Promise<string> {
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: "acme/install-pipeline-direct",
          manifest_version: "1.0.0",
          publisher: "Acme",
          direction: "both",
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

// ---------------------------------------------------------------------------
// What the rollback leaves behind.
//
// The three cases above assert the *order* the compensations run in against
// stubbed storage, which is worth having and is not the property that
// matters to anyone looking at a connection afterwards. A rollback that ran
// every step in the right order and left the row reading active would pass
// all three, and did: `properties.status` stayed `active` and
// `runtime_status` stayed `healthy` while `state` said `revoked`, and every
// operator surface reads the properties. So this asserts the state, on real
// storage, after a failure the pipeline can genuinely produce.
// ---------------------------------------------------------------------------

describe("performInstall — the state a rolled-back install leaves", () => {
  let hosted: TestContext;

  beforeAll(async () => {
    hosted = await createTestContext({ authMode: "hosted" });
  });

  afterAll(async () => {
    await hosted.cleanup();
  });

  it("leaves no connection reading as active after the mint refuses", async () => {
    // A real failure, not an injected one: a hosted deployment refuses to
    // mint a runtime credential for a connection with no space, because a
    // space-less credential is the platform tier rather than a narrow one.
    // Step 1 has committed by then, so the compensation is what decides
    // what the space admin sees.
    const adminKey = await hosted.storage.keys
      .list()
      .then((keys) => keys.find((k) => k.role === "admin"));
    if (!adminKey) throw new Error("admin key not found in test ctx");

    const stamp = `${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`;
    const integration = await hosted.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: `acme.rollback-${stamp}`,
          manifest_version: "1.0.0",
          publisher: "Acme",
          direction: "both",
          manifest: manifest(),
          registered_at: new Date().toISOString(),
        },
      },
      undefined,
    );

    const before = await hosted.storage.items.list({
      type: "system.connection",
      limit: 200,
    });

    await expect(
      performInstall(hosted.storage, "test-salt", {
        apiKeyId: adminKey.id,
        spaceId: undefined,
        authMode: "hosted",
        integrationItemId: integration.id,
        manifest: { ...manifest(), name: `acme.rollback-${stamp}` },
        label: `rollback state ${stamp}`,
      }),
    ).rejects.toThrow(/has no space/);

    // The pipeline throws before it can return an id, so the connection is
    // found by what appeared rather than by what was reported — which is
    // the position anyone cleaning up after this is in.
    const after = await hosted.storage.items.list({
      type: "system.connection",
      limit: 200,
    });
    const seen = new Set(before.data.map((i) => i.id));
    const stranded = after.data.filter((i) => !seen.has(i.id));
    expect(stranded).toHaveLength(1);

    const connection = await hosted.storage.items.getIncludingTrashed(
      stranded[0]!.id,
      undefined,
    );
    // All three together. Each one on its own has been the thing that was
    // right while the row as a whole still read as live.
    expect(connection?.state).toBe("revoked");
    expect(connection?.properties.status).toBe("revoked");
    expect(connection?.properties.runtime_status).toBe("revoked");
  });
});

describe("performInstall — an unaudited install does not stand", () => {
  it("rolls back when the real audit write fails", async () => {
    // The real store, the real write path, a real rejection. The only thing
    // arranged is a `details` payload that will not serialize, which is
    // enough because the audit writer this pipeline reaches is the
    // propagating one: under the fire-and-forget writer the same failure is
    // caught, warned about and dropped, and the install below would return
    // an id for a connection nothing recorded.
    const adminKey = await ctx.storage.keys
      .list()
      .then((keys) => keys.find((k) => k.role === "admin"));
    if (!adminKey) throw new Error("admin key not found in test ctx");

    const stamp = `${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`;
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: `acme.audit-${stamp}`,
          manifest_version: "1.0.0",
          publisher: "Acme",
          direction: "both",
          manifest: manifest(),
          registered_at: new Date().toISOString(),
        },
      },
      undefined,
    );

    // Prototype delegation rather than a spread: the audit store is a class
    // instance, so a spread copies none of its methods and would turn
    // "the pipeline called the other writer" into "the pipeline called
    // undefined", which throws for the wrong reason and passes the test.
    const realAudit = ctx.storage.audit;
    const audit = Object.create(realAudit) as AuditStore;
    audit.logOrThrow = (entry: AuditLogEntry): Promise<void> =>
      realAudit.logOrThrow({
        ...entry,
        details: { ...entry.details, attempts: 1n },
      });
    const storage = { ...ctx.storage, audit };

    const before = await ctx.storage.items.list({
      type: "system.connection",
      limit: 500,
    });

    await expect(
      performInstall(storage, "test-salt", {
        apiKeyId: adminKey.id,
        spaceId: undefined,
        authMode: "keys",
        integrationItemId: integration.id,
        manifest: { ...manifest(), name: `acme.audit-${stamp}` },
        label: `audit failure ${stamp}`,
      }),
    ).rejects.toThrow();

    const after = await ctx.storage.items.list({
      type: "system.connection",
      limit: 500,
    });
    const seen = new Set(before.data.map((i) => i.id));
    const stranded = after.data.filter((i) => !seen.has(i.id));
    expect(stranded).toHaveLength(1);

    // State, not order. The connection reads revoked on every field a
    // person sees, and the credential the mint issued is retired.
    const connection = await ctx.storage.items.getIncludingTrashed(
      stranded[0]!.id,
      undefined,
    );
    expect(connection?.state).toBe("revoked");
    expect(connection?.properties.status).toBe("revoked");
    expect(connection?.properties.runtime_status).toBe("revoked");

    const liveCredential = (await ctx.storage.keys.list()).find(
      (k) => k.connection_id === stranded[0]!.id,
    );
    expect(liveCredential).toBeUndefined();

    // And nothing claims the install was audited.
    const rows = await ctx.storage.audit.list({
      action: "integration.install",
      resource_id: stranded[0]!.id,
      limit: 5,
    });
    expect(rows.data).toHaveLength(0);
  });
});
