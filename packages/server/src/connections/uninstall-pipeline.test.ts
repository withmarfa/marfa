/**
 * Direct tests of the uninstall pipeline. The HTTP-level happy path is
 * covered by routes/connections.test.ts; these tests exercise the
 * pipeline against a real test storage so the cleanup-of-each-artifact
 * branches run end-to-end (runtime credential revocation, OAuth-token
 * deletion, leased-token revocation, inbound-webhook disable, state
 * transition, activity emission, audit log).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, TEST_API_KEY_SALT } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { performInstall } from "./install-pipeline.js";
import { mintLocalRuntimeCredential } from "../integrations/local-runtime/credentials.js";
import { performUninstall, UninstallError } from "./uninstall-pipeline.js";
import type { IntegrationManifest } from "@withmarfa/shared";
import { runtimeCredentialItemSource } from "../connections/lifecycle-lock.js";
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
    name: "acme/uninstall-direct",
    version: "1.0.0",
    publisher: "acme",
    description: "uninstall test",
    direction: "both",
    runs_on: "server" as const,
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "prompt-user",
      partial_write_mode: "all-or-nothing",
    },
    // Declares what an OAuth grant on this connection would cover. The
    // fixture used to bind an oauth_token credential to a manifest saying
    // it needed no OAuth at all, which install now refuses: nothing in
    // that pairing said which capability the grant was for.
    oauth_requirements: { upstream: "proxy" as const },
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
  };
}

async function installFresh(): Promise<{
  apiKeyId: string;
  connectionId: string;
  credentialId: string;
}> {
  const adminKey = await ctx.storage.keys
    .list()
    .then((keys) => keys.find((k) => k.is_operator));
  if (!adminKey) throw new Error("admin key not found in test ctx");

  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: `acme.uninstall-direct-${Date.now().toString()}`,
        manifest_version: "1.0.0",
        publisher: "acme",
        direction: "both",
        manifest: manifest(),
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );

  const result = await performInstall(ctx.storage, {
    apiKeyId: adminKey.id,
    spaceId: undefined,
    authMode: "keys",
    integrationItemId: integration.id,
    manifest: {
      ...manifest(),
      name: `acme.uninstall-${Date.now().toString()}`,
    },
  });

  return {
    apiKeyId: adminKey.id,
    connectionId: result.connection_id,
    // Installing mints nothing, so the credential uninstall revokes is
    // the one a dispatch would have left behind. Minted through the
    // supervisor's own path rather than hand-built, so what uninstall
    // sweeps is the shape it sweeps in production.
    credentialId: await mintRuntimeCredentialId(result.connection_id),
  };
}

/** Mint a runtime credential for a Connection the way a dispatch does,
 *  and resolve the row id the mint does not return. */
async function mintRuntimeCredentialId(connectionId: string): Promise<string> {
  return mintRuntimeCredentialIdIn(ctx.storage, connectionId, "keys");
}

async function mintRuntimeCredentialIdIn(
  storage: TestContext["storage"],
  connectionId: string,
  authMode: "hosted" | "keys",
): Promise<string> {
  await mintLocalRuntimeCredential(
    storage,
    TEST_API_KEY_SALT,
    connectionId,
    authMode,
  );
  const bound = await storage.keys.listByConnectionId(connectionId, undefined);
  const runtime = bound.find((k) => k.is_runtime_credential);
  if (!runtime) throw new Error("runtime credential did not resolve");
  return runtime.id;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("performUninstall — happy path", () => {
  it("revokes the runtime credential, transitions the connection to revoked, emits activity, audits", async () => {
    const installed = await installFresh();

    const credBefore = (await ctx.storage.keys.list()).find(
      (k) => k.id === installed.credentialId,
    );
    expect(credBefore).toBeTruthy();

    const result = await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      spaceId: undefined,
      connectionId: installed.connectionId,
    });

    expect(result.connection_id).toBe(installed.connectionId);
    expect(result.revoked_credential_ids).toEqual([installed.credentialId]);
    expect(result.oauth_tokens_deleted).toBe(false);
    expect(result.leased_tokens_revoked).toBe(0);
    expect(result.inbound_webhooks_disabled).toBe(0);
    expect(result.activity_id).toMatch(/^[0-9a-f-]+$/);

    // Credential is gone from active list (revoked_at stamped → list filters it out).
    const credAfter = (await ctx.storage.keys.list()).find(
      (k) => k.id === installed.credentialId,
    );
    expect(credAfter).toBeUndefined();

    // Connection state flipped to revoked — and so did the properties
    // that describe the same fact.
    //
    // Asserting `state` alone is why this shipped a row reading
    // `state: revoked` beside `status: active`. The type documents
    // `status` as the lifecycle status and its enum is exactly
    // `active | revoked`, so the two cannot legitimately disagree. The
    // shape is asserted whole rather than field by field for that reason.
    const conn = await ctx.storage.items.getIncludingTrashed(
      installed.connectionId,
      undefined,
    );
    expect(conn?.state).toBe("revoked");
    expect(conn?.properties.status).toBe("revoked");
    // Stamped rather than cleared: a property cannot be removed through
    // the update path (shallow merge, and an explicit null on an optional
    // field means "leave unset"), which is exactly how `healthy` survived
    // an uninstall. The enum gained a `revoked` member so the field can
    // say the runtime is gone instead of reporting stale health.
    expect(conn?.properties.runtime_status).toBe("revoked");

    // Activity row was emitted with the right summary + provenance.
    const activity = await ctx.storage.items.get(result.activity_id, undefined);
    expect(activity?.type).toBe("system.activity");
    expect(activity?.properties.summary).toMatch(/Uninstalled connection /);
    expect(activity?.properties.connection_id).toBe(installed.connectionId);

    // Audit row written.
    const auditRows = await ctx.storage.audit.list({
      action: "integration.uninstall",
      resource_id: installed.connectionId,
      limit: 5,
    });
    expect(auditRows.data.length).toBeGreaterThanOrEqual(1);
    const last = auditRows.data[0];
    expect(last?.details.revoked_credential_ids).toEqual([
      installed.credentialId,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("performUninstall — error paths", () => {
  it("throws UninstallError(connection_not_found) for an unknown id", async () => {
    await expect(
      performUninstall(ctx.storage, {
        apiKeyId: "anything",
        spaceId: undefined,
        connectionId: "00000000-0000-7000-8000-000000000000",
      }),
    ).rejects.toMatchObject({
      name: "UninstallError",
      code: "connection_not_found",
    });
  });

  it("throws UninstallError(wrong_connection_kind) when called against a non-integration connection", async () => {
    // Mint a system.connection with kind: app (the OAuth-grant
    // shape) and confirm uninstall rejects it. Uninstall is scoped to
    // integration kinds.
    const grant = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "app",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );

    await expect(
      performUninstall(ctx.storage, {
        apiKeyId: "anything",
        spaceId: undefined,
        connectionId: grant.id,
      }),
    ).rejects.toMatchObject({
      name: "UninstallError",
      code: "wrong_connection_kind",
    });
  });

  it("throws UninstallError(already_revoked) on second call against the same connection", async () => {
    const installed = await installFresh();

    await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      spaceId: undefined,
      connectionId: installed.connectionId,
    });

    await expect(
      performUninstall(ctx.storage, {
        apiKeyId: installed.apiKeyId,
        spaceId: undefined,
        connectionId: installed.connectionId,
      }),
    ).rejects.toMatchObject({
      name: "UninstallError",
      code: "already_revoked",
    });
  });

  it("UninstallError carries the discriminator code so callers can branch", () => {
    // Stable shape contract — the route layer keys on `code` to map to
    // 400 vs 404.
    const err = new UninstallError("connection_not_found", "x");
    expect(err.code).toBe("connection_not_found");
    expect(err.name).toBe("UninstallError");
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Idempotency-at-the-artifact-layer (uninstall is monotonic, no compensations)
// ---------------------------------------------------------------------------

describe("performUninstall — partial-state semantics", () => {
  it("revokes multiple runtime credentials when the connection accumulated more than one", async () => {
    // Operationally a runtime credential is 1:1 with a connection, but
    // the schema doesn't enforce uniqueness. The pipeline must revoke
    // every active credential bound to the connection — defense in depth.
    const installed = await installFresh();

    // Mint a second runtime credential bound to the same connection.
    const { hashApiKey } = await import("../middleware/auth.js");
    const extraCred = await ctx.storage.keys.createRuntimeCredential(
      {
        label: "extra runtime cred",
        source: `integration-extra:${installed.connectionId}`,
        type_permissions: { "core.note": "read" },
        connection_id: installed.connectionId,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        item_source: runtimeCredentialItemSource({ name: "acme/fixture" }),
      },
      hashApiKey("marfa_k1_" + "0".repeat(64), "test-salt"),
      undefined,
    );

    const result = await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      spaceId: undefined,
      connectionId: installed.connectionId,
    });

    expect(result.revoked_credential_ids).toEqual(
      expect.arrayContaining([installed.credentialId, extraCred.id]),
    );
    expect(result.revoked_credential_ids.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The upstream credential — the token the user handed Marfa.
//
// None of the cases below could fail before this was covered, because
// `installFresh` passes no `credentialRef` at all: every existing test
// installs a connection with no upstream credential and so never reaches
// the code that was missing.
// ---------------------------------------------------------------------------

async function makeCredential(
  kind: "api_token" | "oauth_token",
): Promise<string> {
  const credential = await ctx.storage.items.create(
    {
      type: "system.credential",
      properties: {
        kind,
        label: `upstream ${kind} ${Date.now().toString()}`,
        secret_encrypted: "aaa|bbb|ccc",
        ...(kind === "api_token"
          ? {
              api_token_config: {
                upstream_base_url: "https://api.example.test",
                auth_scheme: "Bearer",
              },
            }
          : {
              oauth_provider_config: {
                upstream_base_url: "https://api.example.test",
                authorize_url: "https://example.test/authorize",
                token_url: "https://example.test/token",
                client_id: "client",
              },
            }),
      },
    },
    undefined,
  );
  return credential.id;
}

async function installWithCredential(credentialRef: string): Promise<{
  apiKeyId: string;
  connectionId: string;
}> {
  const adminKey = await ctx.storage.keys
    .list()
    .then((keys) => keys.find((k) => k.is_operator));
  if (!adminKey) throw new Error("admin key not found in test ctx");

  const stamp = `${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`;
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: `acme.upstream-${stamp}`,
        manifest_version: "1.0.0",
        publisher: "acme",
        direction: "both",
        manifest: manifest(),
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );

  const result = await performInstall(ctx.storage, {
    apiKeyId: adminKey.id,
    spaceId: undefined,
    authMode: "keys",
    integrationItemId: integration.id,
    manifest: { ...manifest(), name: `acme.upstream-${stamp}` },
    credentialRef,
  });

  return { apiKeyId: adminKey.id, connectionId: result.connection_id };
}

describe("performUninstall — the upstream credential", () => {
  it("purges an api-token credential and says so", async () => {
    const credentialId = await makeCredential("api_token");
    const installed = await installWithCredential(credentialId);

    const result = await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      connectionId: installed.connectionId,
    });

    expect(result.upstream_credential).toEqual({
      status: "purged",
      credential_id: credentialId,
    });
    expect(await ctx.storage.items.get(credentialId, undefined)).toBeNull();
  });

  it("purges an oauth-token credential and says so", async () => {
    const credentialId = await makeCredential("oauth_token");
    const installed = await installWithCredential(credentialId);

    const result = await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      connectionId: installed.connectionId,
    });

    expect(result.upstream_credential).toEqual({
      status: "purged",
      credential_id: credentialId,
    });
    expect(await ctx.storage.items.get(credentialId, undefined)).toBeNull();
  });

  it("keeps a credential another live connection still shares, and names it", async () => {
    // The four Google integrations do exactly this, so the shared case is
    // the normal one rather than an edge.
    const credentialId = await makeCredential("oauth_token");
    const first = await installWithCredential(credentialId);
    const second = await installWithCredential(credentialId);

    const result = await performUninstall(ctx.storage, {
      apiKeyId: first.apiKeyId,
      connectionId: first.connectionId,
    });

    expect(result.upstream_credential).toEqual({
      status: "retained",
      credential_id: credentialId,
      reason: "in_use_by_other_connections",
      connection_ids: [second.connectionId],
    });
    const survivor = await ctx.storage.items.get(credentialId, undefined);
    expect(survivor?.type).toBe("system.credential");

    // And once the sibling goes too, the credential goes with it.
    const secondResult = await performUninstall(ctx.storage, {
      apiKeyId: second.apiKeyId,
      connectionId: second.connectionId,
    });
    expect(secondResult.upstream_credential).toEqual({
      status: "purged",
      credential_id: credentialId,
    });
    expect(await ctx.storage.items.get(credentialId, undefined)).toBeNull();
  });

  it("reports `none` when the connection carried no credential", async () => {
    const installed = await installFresh();

    const result = await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      connectionId: installed.connectionId,
    });

    expect(result.upstream_credential).toEqual({ status: "none" });
  });

  it("reports `already_gone` for a ref pointing at nothing", async () => {
    const credentialId = await makeCredential("api_token");
    const installed = await installWithCredential(credentialId);

    // Removed by hand, which is exactly how the two stranded credentials
    // this defect produced were cleaned up before it was fixed.
    await ctx.storage.items.transition(credentialId, "revoked", undefined);
    await ctx.storage.items.purge(credentialId, undefined);

    const result = await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      connectionId: installed.connectionId,
    });

    expect(result.upstream_credential).toEqual({
      status: "already_gone",
      credential_id: credentialId,
    });
  });

  it("carries the outcome onto the activity and audit rows", async () => {
    const credentialId = await makeCredential("api_token");
    const installed = await installWithCredential(credentialId);

    const result = await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      connectionId: installed.connectionId,
    });

    const activity = await ctx.storage.items.get(result.activity_id, undefined);
    const detail = (
      activity?.properties as { detail?: Record<string, unknown> }
    ).detail;
    expect(detail?.upstream_credential).toEqual({
      status: "purged",
      credential_id: credentialId,
    });

    const audit = await ctx.storage.audit.list({
      action: "integration.uninstall",
      resource_id: installed.connectionId,
      limit: 5,
    });
    const row = audit.data[0];
    expect(
      (row?.details as { upstream_credential?: unknown } | undefined)
        ?.upstream_credential,
    ).toEqual({ status: "purged", credential_id: credentialId });
  });
});

// ---------------------------------------------------------------------------
// A connection that lives in a space.
//
// Everything before this point installs with `spaceId: undefined`, where
// nothing carries a `space_id` at all. The space fence therefore never
// narrows anything and a defect in what an absent space means is invisible:
// every row matches either reading of it. Naming a space is what makes the
// fence load-bearing, and it is the shape both live environments run.
//
// The context is `authMode: "hosted"` to match those deployments, but that
// is not what these cases turn on: hosted only wires the users store, which
// no pipeline here touches, and the one guard that reads `authMode` passes
// either way once a space is named. The named space is the discriminating
// input. (`install-pipeline.test.ts` has the one case where hosted is
// genuinely the property under test.)
// ---------------------------------------------------------------------------

describe("performUninstall — a connection inside a space", () => {
  let hosted: TestContext;

  beforeAll(async () => {
    hosted = await createTestContext({ authMode: "hosted" });
  });

  afterAll(async () => {
    await hosted.cleanup();
  });

  async function installIntoSpace(): Promise<{
    apiKeyId: string;
    spaceId: string;
    connectionId: string;
    credentialId: string;
  }> {
    const adminKey = await hosted.storage.keys
      .list()
      .then((keys) => keys.find((k) => k.is_operator));
    if (!adminKey) throw new Error("admin key not found in test ctx");

    const space = await hosted.storage.spaces!.create(
      `uninstall-${Math.random().toString(36).slice(2, 8)}`,
    );
    const stamp = `${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`;

    // The catalog row carries no space: `system.integration` is registered
    // by a platform credential and read through the widening, exactly as it
    // is on a live deployment.
    const integration = await hosted.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: `acme.hosted-${stamp}`,
          manifest_version: "1.0.0",
          publisher: "acme",
          direction: "both",
          manifest: manifest(),
          registered_at: new Date().toISOString(),
        },
      },
      undefined,
    );

    const result = await performInstall(hosted.storage, {
      apiKeyId: adminKey.id,
      spaceId: space.id,
      authMode: "hosted",
      integrationItemId: integration.id,
      manifest: { ...manifest(), name: `acme.hosted-${stamp}` },
    });

    return {
      apiKeyId: adminKey.id,
      spaceId: space.id,
      connectionId: result.connection_id,
      credentialId: await mintRuntimeCredentialIdIn(
        hosted.storage,
        result.connection_id,
        "hosted",
      ),
    };
  }

  it("revokes the runtime credential on a space-scoped uninstall", async () => {
    const installed = await installIntoSpace();

    const result = await performUninstall(hosted.storage, {
      apiKeyId: installed.apiKeyId,
      spaceId: installed.spaceId,
      connectionId: installed.connectionId,
    });

    expect(result.revoked_credential_ids).toEqual([installed.credentialId]);
    expect(
      (await hosted.storage.keys.listForSpace(installed.spaceId)).find(
        (k) => k.id === installed.credentialId,
      ),
    ).toBeUndefined();
  });

  it("revokes the runtime credential when a platform admin uninstalls a space's connection", async () => {
    // The mismatch: a platform admin holds no `space_id`, so the route
    // computes `spaceId: undefined` and the pipeline resolves the
    // connection unfenced. Every credential the connection owns carries
    // the connection's space, so a fence that reads an absent space as
    // "the rows with no space" matches none of them — not sometimes,
    // every time — and the uninstall reports an empty revocation list
    // beside an HTTP 200 while the credential stays live.
    const installed = await installIntoSpace();

    const result = await performUninstall(hosted.storage, {
      apiKeyId: installed.apiKeyId,
      spaceId: undefined,
      connectionId: installed.connectionId,
    });

    expect(result.revoked_credential_ids).toEqual([installed.credentialId]);

    // And the credential is genuinely gone, not merely reported. A list
    // scoped to the space is the read every operator surface makes.
    const survivors = await hosted.storage.keys.listForSpace(installed.spaceId);
    expect(
      survivors.find((k) => k.id === installed.credentialId),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// What the result says happened is what happened.
// ---------------------------------------------------------------------------

describe("performUninstall — affected rows, not attempts", () => {
  it("does not count a subscription disabled after it was listed", async () => {
    // The pipeline used to walk the subscriptions it had read and count the
    // ones the read called enabled. Nothing holds a lock over
    // `inbound_webhooks` across those two steps, so the count was a claim
    // about the moment before the write. Disabling one inside that window
    // is the whole difference between reporting the read and reporting the
    // write, and it is what the first version of this test missed: it
    // asserted an outcome the old shape produced too.
    const installed = await installFresh();

    const racedOff = randomUUID();
    const stillOn = randomUUID();
    for (const id of [racedOff, stillOn]) {
      await ctx.storage.inboundWebhooks.create({
        id,
        connection_id: installed.connectionId,
        secret_encrypted: "a|b|c",
        verification_method: "hmac-sha256",
        events: ["thing.happened"],
      });
    }

    const real = ctx.storage.inboundWebhooks;
    const inboundWebhooks = Object.create(real) as typeof real;
    inboundWebhooks.listByConnection = async (
      connectionId: string,
      spaceId?: string,
    ) => {
      const rows = await real.listByConnection(connectionId, spaceId);
      await real.setDisabled(racedOff, true);
      return rows;
    };

    const result = await performUninstall(
      { ...ctx.storage, inboundWebhooks },
      {
        apiKeyId: installed.apiKeyId,
        spaceId: undefined,
        connectionId: installed.connectionId,
      },
    );

    expect(result.inbound_webhooks_disabled).toBe(1);
    expect((await real.getAny(stillOn))?.disabled).toBe(true);
    expect((await real.getAny(racedOff))?.disabled).toBe(true);
  });

  it("deletes the oauth-token row even when a read disagrees with the table", async () => {
    // The pre-read was a second source of truth about the row the delete
    // was about to touch, and the pipeline believed the read. Any staleness
    // in it skipped the delete and reported `false`: upstream tokens left
    // in the database, under a connection reported as uninstalled. There is
    // no read to be stale now, so a read that lies changes nothing.
    const installed = await installFresh();
    await ctx.storage.connectionOauthTokens.upsert({
      connection_id: installed.connectionId,
      access_token_encrypted: "a|b|c",
      refresh_token_encrypted: null,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      scopes: ["read"],
    });

    const real = ctx.storage.connectionOauthTokens;
    const connectionOauthTokens = Object.create(real) as typeof real;
    connectionOauthTokens.get = () => Promise.resolve(null);

    const result = await performUninstall(
      {
        ...ctx.storage,
        connectionOauthTokens,
      },
      {
        apiKeyId: installed.apiKeyId,
        spaceId: undefined,
        connectionId: installed.connectionId,
      },
    );

    expect(result.oauth_tokens_deleted).toBe(true);
    expect(await real.get(installed.connectionId, undefined)).toBeNull();
  });

  it("does not claim a credential revoked after it was listed", async () => {
    // The supersede path retires a connection's older credentials on every
    // mint and holds no lock this pipeline waits on, so a credential can go
    // between the list and the revoke. Reporting the list would put an id
    // in the audit row under an action that did not happen.
    const installed = await installFresh();
    const { hashApiKey } = await import("../middleware/auth.js");
    const extra = await ctx.storage.keys.createRuntimeCredential(
      {
        label: "raced runtime cred",
        source: `integration-raced:${installed.connectionId}`,
        type_permissions: { "core.note": "read" },
        connection_id: installed.connectionId,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        item_source: runtimeCredentialItemSource({ name: "acme/fixture" }),
      },
      hashApiKey(`marfa_k1_raced_${randomUUID()}`, TEST_API_KEY_SALT),
      undefined,
    );

    const real = ctx.storage.keys;
    const keys = Object.create(real) as typeof real;
    keys.listByConnectionId = async (
      connectionId: string,
      spaceId?: string,
    ) => {
      const rows = await real.listByConnectionId(connectionId, spaceId);
      await real.revoke(extra.id);
      return rows;
    };

    const result = await performUninstall(
      { ...ctx.storage, keys },
      {
        apiKeyId: installed.apiKeyId,
        spaceId: undefined,
        connectionId: installed.connectionId,
      },
    );

    expect(result.revoked_credential_ids).toEqual([installed.credentialId]);
  });
});

describe("performUninstall — an unaudited uninstall does not pass silently", () => {
  it("surfaces a real audit failure rather than answering 200", async () => {
    // The real store and its real write path; the only thing arranged is a
    // `details` payload that will not serialize. Under the fire-and-forget
    // writer this pipeline used to reach, the same failure is caught,
    // warned about and dropped, and the caller is told the credentials were
    // revoked by an uninstall with no record of it.
    const installed = await installFresh();

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

    await expect(
      performUninstall(storage, {
        apiKeyId: installed.apiKeyId,
        spaceId: undefined,
        connectionId: installed.connectionId,
      }),
    ).rejects.toThrow();

    // Monotonic, so the uninstall stands. The loud failure is about the
    // missing record, not about a half-done uninstall.
    const conn = await ctx.storage.items.getIncludingTrashed(
      installed.connectionId,
      undefined,
    );
    expect(conn?.state).toBe("revoked");
    const rows = await ctx.storage.audit.list({
      action: "integration.uninstall",
      resource_id: installed.connectionId,
      limit: 5,
    });
    expect(rows.data).toHaveLength(0);
  });
});
