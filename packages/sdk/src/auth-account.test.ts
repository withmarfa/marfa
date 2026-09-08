import { SPACE_PERMISSIONS } from "@withmarfa/shared";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { MarfaClient } from "./client.js";
import { ValidationError } from "./errors.js";
import {
  createHostedModeFixture,
  readLatestAccountVerification,
  type HostedModeFixture,
} from "./test-harness.js";

/**
 * Mint a fresh `space_admin` bearer bound to the user's space
 * after `markPendingDeletion` revoked the original. The deletion
 * cascade revokes every API key in the space; a real user recovering
 * via SDK would have to be re-issued a key out of band. For the
 * round-trip test we synthesize that recovery here.
 */
async function mintFreshBearer(fixture: HostedModeFixture): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_sdk_recovery_${suffix}`;
  const hash = createHmac("sha256", "test-salt").update(raw).digest("hex");
  await fixture.storage.keys.create(
    {
      label: `sdk-recovery-${suffix}`,
      source: `sdk-recovery-${suffix}`,
      space_permissions: [...SPACE_PERMISSIONS],
      type_permissions: { "*": "write" },
      extension_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      metadata_permissions: { "*": "write" },
      default_tier: "library",
      is_operator: false,
    },
    hash,
    fixture.spaceId,
  );
  return raw;
}

/**
 * SDK round-trip coverage for `client.auth.account.*`.
 *
 * Server-side route coverage lives at
 * `packages/server/src/routes/auth-account.test.ts`. These tests exercise
 * the SDK's transport shim — request/response shape serialization against a
 * live server via the hosted-mode fixture. Each test is a discrete
 * one-method round-trip so a failure points at the right method.
 *
 * The deletion routes skip email send when no `emailTransport` is configured
 * (the test harness leaves it undefined). Confirm/cancel tokens still land in
 * `auth_verification`; tests read them via `readLatestAccountVerification`
 * rather than intercepting an email.
 */

describe("client.auth.account — hosted-mode round-trip", () => {
  let fixture: HostedModeFixture;

  beforeEach(async () => {
    fixture = await createHostedModeFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("requestDelete returns 202 and lands a confirm token in auth_verification", async () => {
    await fixture.client.auth.account.requestDelete();

    // Token is minted server-side; surface to test via direct storage read.
    const token = await readLatestAccountVerification(
      fixture.storage,
      "account-delete:",
    );
    expect(token).toBeTruthy();
    expect(token?.length ?? 0).toBeGreaterThan(0);
  });

  it("confirmDelete consumes the token and transitions account to pending_deletion", async () => {
    await fixture.client.auth.account.requestDelete();
    const token = await readLatestAccountVerification(
      fixture.storage,
      "account-delete:",
    );
    expect(token).toBeTruthy();

    await fixture.client.auth.account.confirmDelete(token ?? "");

    const lifecycle = fixture.storage.accountLifecycle;
    expect(lifecycle).toBeTruthy();
    const state = await lifecycle?.getAccountLifecycleByEmail(fixture.email);
    expect(state?.deletion_state).toBe("pending_deletion");
    expect(state?.pending_deletion_at).toBeTruthy();
  });

  it("cancel reverses pending_deletion back to active (via fresh bearer post-revocation)", async () => {
    await fixture.client.auth.account.requestDelete();
    const token = await readLatestAccountVerification(
      fixture.storage,
      "account-delete:",
    );
    await fixture.client.auth.account.confirmDelete(token ?? "");

    const lifecycle = fixture.storage.accountLifecycle;
    const before = await lifecycle?.getAccountLifecycleByEmail(fixture.email);
    expect(before?.deletion_state).toBe("pending_deletion");

    const recoveryKey = await mintFreshBearer(fixture);
    const recoveryClient = new MarfaClient({
      url: "http://localhost",
      apiKey: recoveryKey,
      fetch: fixture.fetch,
    });

    await recoveryClient.auth.account.cancel();

    const after = await lifecycle?.getAccountLifecycleByEmail(fixture.email);
    expect(after?.deletion_state).toBe("active");
    expect(after?.pending_deletion_at).toBeFalsy();
  });

  it("cancel called outside pending_deletion state surfaces a structured error", async () => {
    // Server returns 400 `not_pending_deletion` for an active account;
    // SDK transport deserializes it as a ValidationError.
    await expect(fixture.client.auth.account.cancel()).rejects.toThrow(
      ValidationError,
    );
  });
});
