/**
 * Integration uninstall pipeline.
 *
 * Reverses what `performInstall` and the OAuth-bootstrap / leased-token /
 * inbound-webhook subsystems may have left attached to a
 * `system.connection` of kind `integration`. Mirrors
 * `install-pipeline.ts`'s shape but inverts the meaning of "atomicity":
 * uninstall is *monotonic toward "uninstalled"*, so we don't compensate
 * earlier steps when a later step fails — partial uninstall is closer to
 * the desired terminal state than the starting state, and re-issuing a
 * revoked credential or restoring a deleted token would be incorrect.
 *
 * Steps:
 *   1. Resolve the connection. 404 if missing; 400 if wrong kind or
 *      already revoked.
 *   2. Revoke every active runtime credential bound to this connection
 *      (`apiKeys.connection_id`). Idempotent; revoking a row that's
 *      already revoked is a no-op.
 *   3. Delete the `connection_oauth_tokens` row if present (the upstream
 *      OAuth tokens cached for the proxy).
 *   4. Revoke every active `connection_leased_tokens` row.
 *   5. Disable every `inbound_webhooks` subscription bound to this
 *      connection so further deliveries are dropped.
 *   6. Transition the `system.connection` item state from `active` to
 *      `revoked` (the bounded system.* lifecycle's terminal state).
 *   7. Emit a `system.activity` row recording the uninstall.
 *   8. Awaited audit-log write.
 *
 * Authorisation lives at the route layer — this function is callable
 * with any storage handle and trusts the caller to have gated already.
 *
 * Internal-call bypass — the `system.connection` transition at step 6
 * uses `storage.items.transition` directly rather than the HTTP route,
 * sidestepping the platform-credential gate that route enforces. This
 * intentionally mirrors `performInstall`'s direct-storage create: at
 * uninstall time the caller is a tenant admin or platform admin acting
 * deliberately, not an arbitrary `system.*` writer.
 */
import type { Storage } from "../storage/interface.js";

export interface UninstallInput {
  /** The api_keys row id of the caller (audit trail). */
  apiKeyId: string;
  /** Tenant scope. Must match the connection's tenant. */
  tenantId?: string;
  /** id of the system.connection item to uninstall. */
  connectionId: string;
  /** Resolved client IP (T-027). Threaded into the audit row. */
  clientIp?: string | null;
}

export interface UninstallResult {
  connection_id: string;
  /** Ids of every runtime credential revoked. Usually a single id; the
   *  pipeline tolerates the rare multi-credential case. */
  revoked_credential_ids: string[];
  /** True when a connection_oauth_tokens row was deleted; false when
   *  the connection had never bootstrapped upstream OAuth. */
  oauth_tokens_deleted: boolean;
  /** Number of `connection_leased_tokens` rows revoked. Zero when none
   *  were active. */
  leased_tokens_revoked: number;
  /** Number of `inbound_webhooks` subscriptions disabled. */
  inbound_webhooks_disabled: number;
  /** id of the emitted system.activity row. */
  activity_id: string;
}

export class UninstallError extends Error {
  constructor(
    public readonly code:
      | "connection_not_found"
      | "wrong_connection_kind"
      | "already_revoked",
    message: string,
  ) {
    super(message);
    this.name = "UninstallError";
  }
}

export async function performUninstall(
  storage: Storage,
  input: UninstallInput,
): Promise<UninstallResult> {
  // -------------------------------------------------------------------
  // Step 1: resolve the connection.
  // -------------------------------------------------------------------
  const connection = await storage.items.get(
    input.connectionId,
    input.tenantId,
  );
  if (connection?.type !== "system.connection") {
    throw new UninstallError(
      "connection_not_found",
      `Connection ${input.connectionId} not found`,
    );
  }
  const kind = connection.properties.kind as string | undefined;
  if (kind !== "integration") {
    throw new UninstallError(
      "wrong_connection_kind",
      `Connection ${input.connectionId} has kind "${kind ?? "<missing>"}"; uninstall accepts only "integration"`,
    );
  }
  if (connection.state === "revoked") {
    throw new UninstallError(
      "already_revoked",
      `Connection ${input.connectionId} is already revoked`,
    );
  }

  // -------------------------------------------------------------------
  // Step 2: revoke every active runtime credential bound to this connection.
  // -------------------------------------------------------------------
  const credentials = await storage.keys.listByConnectionId(
    input.connectionId,
    input.tenantId,
  );
  const revokedCredentialIds: string[] = [];
  for (const cred of credentials) {
    await storage.keys.revoke(cred.id);
    revokedCredentialIds.push(cred.id);
  }

  // -------------------------------------------------------------------
  // Step 3: delete the connection_oauth_tokens row if present.
  // -------------------------------------------------------------------
  const existingToken = await storage.connectionOauthTokens.get(
    input.connectionId,
    input.tenantId,
  );
  let oauthTokensDeleted = false;
  if (existingToken) {
    await storage.connectionOauthTokens.delete(input.connectionId);
    oauthTokensDeleted = true;
  }

  // -------------------------------------------------------------------
  // Step 4: revoke every active leased token for this connection.
  // -------------------------------------------------------------------
  const nowIso = new Date().toISOString();
  const activeLeases =
    await storage.connectionLeasedTokens.listActiveByConnection(
      input.connectionId,
      nowIso,
      input.tenantId,
    );
  let leasedTokensRevoked = 0;
  for (const lease of activeLeases) {
    const flipped = await storage.connectionLeasedTokens.revoke(
      lease.id,
      nowIso,
    );
    if (flipped) leasedTokensRevoked += 1;
  }

  // -------------------------------------------------------------------
  // Step 5: disable inbound webhook subscriptions tied to this connection.
  // -------------------------------------------------------------------
  const inboundSubs = await storage.inboundWebhooks.listByConnection(
    input.connectionId,
    input.tenantId,
  );
  let inboundWebhooksDisabled = 0;
  for (const sub of inboundSubs) {
    if (!sub.disabled) {
      await storage.inboundWebhooks.setDisabled(sub.id, true);
      inboundWebhooksDisabled += 1;
    }
  }

  // -------------------------------------------------------------------
  // Step 6: transition system.connection state to revoked.
  // The system.* lifecycle override only allows active → revoked, which
  // matches the precondition asserted in step 1.
  // -------------------------------------------------------------------
  await storage.items.transition(input.connectionId, "revoked", input.tenantId);

  // -------------------------------------------------------------------
  // Step 7: emit system.activity row.
  // -------------------------------------------------------------------
  const integrationRef = connection.properties.integration_ref as
    | string
    | undefined;
  const activity = await storage.items.create(
    {
      type: "system.activity",
      properties: {
        connection_id: input.connectionId,
        severity: "info" as const,
        summary: `Uninstalled connection ${input.connectionId}`,
        detail: {
          integration_ref: integrationRef ?? null,
          revoked_credential_ids: revokedCredentialIds,
          oauth_tokens_deleted: oauthTokensDeleted,
          leased_tokens_revoked: leasedTokensRevoked,
          inbound_webhooks_disabled: inboundWebhooksDisabled,
        },
      },
    },
    input.tenantId,
  );

  // -------------------------------------------------------------------
  // Step 8: audit log. Awaited (T-012).
  // -------------------------------------------------------------------
  await storage.audit.log({
    key_id: input.apiKeyId,
    client_ip: input.clientIp ?? null,
    tenant_id: input.tenantId ?? null,
    action: "integration.uninstall",
    resource_type: "item",
    resource_id: input.connectionId,
    details: {
      integration_ref: integrationRef ?? null,
      revoked_credential_ids: revokedCredentialIds,
      oauth_tokens_deleted: oauthTokensDeleted,
      leased_tokens_revoked: leasedTokensRevoked,
      inbound_webhooks_disabled: inboundWebhooksDisabled,
      activity_id: activity.id,
    },
  });

  return {
    connection_id: input.connectionId,
    revoked_credential_ids: revokedCredentialIds,
    oauth_tokens_deleted: oauthTokensDeleted,
    leased_tokens_revoked: leasedTokensRevoked,
    inbound_webhooks_disabled: inboundWebhooksDisabled,
    activity_id: activity.id,
  };
}
