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
 * Mint a fresh `tenant_admin` bearer bound to the user's tenant
 * after `markPendingDeletion` revoked the original. The deletion
 * cascade revokes every API key in the tenant; a real user recovering
 * via SDK would have to be re-issued a key out of band. For the
 * round-trip test we synthesise that recovery here.
 */
async function mintFreshBearer(fixture: HostedModeFixture): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_sdk_recovery_${suffix}`;
  const hash = createHmac("sha256", "test-salt").update(raw).digest("hex");
  await fixture.storage.keys.create(
    {
      label: `sdk-recovery-${suffix}`,
      source: `sdk-recovery-${suffix}`,
      role: "tenant_admin",
      type_permissions: { "*": "write" },
      default_tier: "library",
      is_platform: false,
    },
    hash,
    fixture.tenantId,
  );
  return raw;
}

/**
 * SDK round-trip coverage for `client.auth.account.*`.
 *
 * Server-side coverage of the routes themselves lives at
 * `packages/server/src/routes/auth-account.test.ts`. The
 * point of these tests is the SDK's transport shim — request/response
 * shape serialization against a live server, exercised via the
 * hosted-mode fixture. Each test is a discrete one-method round-trip
 * rather than chaining all three through one sequence so a failure
 * points at the right method.
 *
 * The account-deletion routes silently skip email send when no
 * `emailTransport` is configured (test harness leaves it undefined).
 * The confirm/cancel tokens still land in `auth_verification`; tests
 * read them via `readLatestAccountVerification` in lieu of
 * intercepting an email.
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

    // Lifecycle store is the source of truth for deletion_state.
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

    // Sanity-check pre-state so the assertion below proves something.
    const lifecycle = fixture.storage.accountLifecycle;
    const before = await lifecycle?.getAccountLifecycleByEmail(fixture.email);
    expect(before?.deletion_state).toBe("pending_deletion");

    // confirmDelete revokes every API key in the tenant as part of the
    // deletion cascade. A real user recovering via SDK would need a
    // freshly-issued bearer; reproduce that here. The link-based GET
    // cancel path doesn't exercise the SDK, so the bearer-via-fresh-key
    // path is the right shape for SDK round-trip coverage.
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
    // Account is in `active` state — never ran requestDelete/confirmDelete.
    // Server returns 400 with code `not_pending_deletion`; the SDK
    // transport deserializes as a ValidationError. Exercises the
    // SDK's error-shape handling for the cancel route.
    await expect(fixture.client.auth.account.cancel()).rejects.toThrow(
      ValidationError,
    );
  });
});
