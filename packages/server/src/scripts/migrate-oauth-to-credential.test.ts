/**
 * Tests for the OAuth-config-to-system.credential migration — Layer 2 PR 4.
 *
 * Covers:
 *   - Happy path: connection with full inline OAuth config → system.credential
 *     created, secret encrypted, credential_ref set, OAuth fields stripped
 *     from configuration (other config fields preserved).
 *   - Skip already-migrated: connection with credential_ref set → counted
 *     as skipped, no new credential.
 *   - Skip wrong kind: app connection ignored.
 *   - Skip no OAuth: integration with no inline OAuth →
 *     counted as skipped.
 *   - Idempotency: running twice doesn't create duplicates.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { migrateOauthToCredential } from "./migrate-oauth-to-credential.js";
import { decryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const inlineOauth = {
  upstream_base_url: "https://api.example.com",
  oauth_token_url: "https://api.example.com/oauth/token",
  oauth_client_id: "client_abc",
  oauth_client_secret: "secret_xyz",
};

async function createConnection(
  configuration: Record<string, unknown>,
  overrides?: { kind?: string; credential_ref?: string },
): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: overrides?.kind ?? "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        ...(overrides?.credential_ref
          ? { credential_ref: overrides.credential_ref }
          : {}),
        configuration,
      },
    },
    undefined,
  );
  return item.id;
}

describe("migrateOauthToCredential", () => {
  it("migrates a connection with inline OAuth: creates credential, sets credential_ref, strips fields", async () => {
    const connId = await createConnection({
      ...inlineOauth,
      // Non-OAuth field that should be preserved.
      extra_setting: "preserved",
    });

    const report = await migrateOauthToCredential(ctx.storage);
    expect(report.migrated).toBeGreaterThanOrEqual(1);

    // Refresh the connection — credential_ref now set, OAuth fields gone.
    const refreshed = await ctx.storage.items.get(connId);
    const props = refreshed?.properties as {
      credential_ref?: string;
      configuration?: Record<string, unknown>;
    };
    expect(props.credential_ref).toBeDefined();
    expect(props.configuration?.upstream_base_url).toBeUndefined();
    expect(props.configuration?.oauth_client_secret).toBeUndefined();
    expect(props.configuration?.extra_setting).toBe("preserved");

    // The new credential item carries the encrypted secret + clear config.
    const cred = await ctx.storage.items.get(props.credential_ref!);
    expect(cred?.type).toBe("system.credential");
    const credProps = cred?.properties as {
      kind?: string;
      oauth_provider_config?: Record<string, string>;
      secret_encrypted?: string;
    };
    expect(credProps.kind).toBe("oauth_token");
    expect(credProps.oauth_provider_config?.upstream_base_url).toBe(
      inlineOauth.upstream_base_url,
    );
    expect(credProps.oauth_provider_config?.oauth_client_id).toBe(
      inlineOauth.oauth_client_id,
    );
    // Secret round-trips through decryption.
    const decrypted = decryptSecret(
      credProps.secret_encrypted!,
      SECRET_INFO.connectionOauthToken,
    );
    expect(decrypted).toBe(inlineOauth.oauth_client_secret);
  });

  it("skips connections that already have a credential_ref", async () => {
    const fakeCredentialId = "itm_already_migrated_credential";
    const connId = await createConnection(
      { ...inlineOauth },
      { credential_ref: fakeCredentialId },
    );

    const reportBefore = await migrateOauthToCredential(ctx.storage);
    const refreshed = await ctx.storage.items.get(connId);
    const props = refreshed?.properties as {
      credential_ref?: string;
      configuration?: Record<string, unknown>;
    };
    // credential_ref unchanged; OAuth fields untouched.
    expect(props.credential_ref).toBe(fakeCredentialId);
    expect(props.configuration?.oauth_client_secret).toBe(
      inlineOauth.oauth_client_secret,
    );
    expect(reportBefore.skipped_already_migrated).toBeGreaterThanOrEqual(1);
  });

  it("skips connections of the wrong kind (app)", async () => {
    await createConnection({ ...inlineOauth }, { kind: "app" });
    const report = await migrateOauthToCredential(ctx.storage);
    expect(report.skipped_wrong_kind).toBeGreaterThanOrEqual(1);
  });

  it("skips integrations without OAuth config", async () => {
    await createConnection({ unrelated: "no-oauth" });
    const report = await migrateOauthToCredential(ctx.storage);
    expect(report.skipped_no_oauth_config).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent — running twice doesn't create duplicate credentials", async () => {
    await createConnection({ ...inlineOauth, marker: "idempotent-test" });

    const r1 = await migrateOauthToCredential(ctx.storage);
    const migratedFirst = r1.migrated;
    const r2 = await migrateOauthToCredential(ctx.storage);
    // Second run finds nothing to migrate (the connection is now
    // already_migrated). migrated count stays at zero increment.
    expect(r2.migrated).toBeLessThan(migratedFirst);
    expect(r2.skipped_already_migrated).toBeGreaterThanOrEqual(migratedFirst);
  });
});
