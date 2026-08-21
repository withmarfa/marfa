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
 *   6. Revoke the `system.connection`: transition its state from `active`
 *      to `revoked`, and set `properties.status` to match in the same
 *      transaction. The two are the same fact stored twice, and they were
 *      allowed to disagree.
 *   7. Release the upstream credential the connection was installed with
 *      — the user's own API or OAuth token — purging it unless another
 *      live connection still shares it. Runs after step 6 so a failure
 *      here leaves the connection revoked rather than half-installed.
 *   8. Emit a `system.activity` row recording the uninstall.
 *   9. Awaited audit-log write.
 *
 * **Three kinds of credential, reported separately.** Steps 2, 3 and 7
 * remove different things, and the result says which of them happened to
 * each. Reporting only the first two was not inaccurate about them — it
 * was silent about the third, and silence about the user's own secret
 * reads as "it is gone". See `upstream-credential.ts`.
 *
 * Authorization lives at the route layer — this function is callable
 * with any storage handle and trusts the caller to have gated already.
 *
 * Internal-call bypass — the `system.connection` writes at step 6
 * use the storage layer directly rather than the HTTP route,
 * sidestepping the platform-credential gate that route enforces. This
 * intentionally mirrors `performInstall`'s direct-storage create: at
 * uninstall time the caller is a space admin or platform admin acting
 * deliberately, not an arbitrary `system.*` writer.
 */
import type { Storage } from "../storage/interface.js";
import { withConnectionLifecycleLock } from "./lifecycle-lock.js";
import {
  releaseUpstreamCredential,
  type UpstreamCredentialOutcome,
} from "./upstream-credential.js";

export interface UninstallInput {
  /** The api_keys row id of the caller (audit trail). */
  apiKeyId: string;
  /** Space scope. Must match the connection's space. */
  spaceId?: string;
  /** id of the system.connection item to uninstall. */
  connectionId: string;
  /** Resolved client IP. Threaded into the audit row. */
  clientIp?: string | null;
}

export interface UninstallResult {
  connection_id: string;
  /** Ids of every **runtime** credential revoked — Marfa's own, minted per
   *  dispatch. Not the upstream credential; see `upstream_credential`.
   *  Usually a single id, and routinely empty: superseded runtime
   *  credentials are revoked on every mint and reaped hourly, so a
   *  connection that is not mid-dispatch has none left to revoke. */
  revoked_credential_ids: string[];
  /** True when a connection_oauth_tokens row was deleted — the proxy's
   *  cached upstream tokens. Always false for an api-token connection,
   *  which never has one. */
  oauth_tokens_deleted: boolean;
  /** What became of the upstream credential the connection was installed
   *  with. Always present, including when there was nothing to do, so a
   *  reader can tell "no credential" from "kept" from "removed". */
  upstream_credential: UpstreamCredentialOutcome;
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
  return withConnectionLifecycleLock(storage, input.connectionId, () =>
    performUninstallLocked(storage, input),
  );
}

async function performUninstallLocked(
  storage: Storage,
  input: UninstallInput,
): Promise<UninstallResult> {
  // -------------------------------------------------------------------
  // Step 1: resolve the connection.
  // -------------------------------------------------------------------
  const connection = await storage.items.get(input.connectionId, input.spaceId);
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
    input.spaceId,
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
    input.spaceId,
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
      input.spaceId,
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
    input.spaceId,
  );
  let inboundWebhooksDisabled = 0;
  for (const sub of inboundSubs) {
    if (!sub.disabled) {
      await storage.inboundWebhooks.setDisabled(sub.id, true);
      inboundWebhooksDisabled += 1;
    }
  }

  // -------------------------------------------------------------------
  // Step 6: revoke the connection — lifecycle state and the denormalised
  // properties that describe it.
  //
  // `properties.status` is the type's own "Lifecycle status (universal
  // across all kinds)" field, and its enum is exactly `active | revoked`.
  // Transitioning `state` and leaving it behind produced a row reading
  // `state: revoked` beside `status: active`, which is not an ambiguity to
  // interpret: the field is documented as the lifecycle status and it was
  // not set. `runtime_status: healthy` on a connection whose credentials
  // are all revoked is wrong for the same reason.
  //
  // Both writes land in one transaction so a partial failure cannot leave
  // them disagreeing, which is the state this fixes.
  // -------------------------------------------------------------------
  // `runtime_status` is stamped, not cleared. A property cannot be removed
  // through the update path at all: the merge is shallow and an explicit
  // null on an optional field means "leave unset", so a delete here would
  // silently leave `healthy` in place. That is how the stale value
  // survived. The field gained a `revoked` member for this, because a
  // status enum that cannot express "the runtime is gone" will always be
  // reporting the health of something that no longer runs.
  const revokedProperties: Record<string, unknown> = {
    ...connection.properties,
    status: "revoked",
    runtime_status: "revoked",
  };
  await storage.runInTransaction(async () => {
    await storage.items.transition(
      input.connectionId,
      "revoked",
      input.spaceId,
    );
    await storage.items.update(
      input.connectionId,
      { properties: revokedProperties },
      input.spaceId,
    );
  });

  // -------------------------------------------------------------------
  // Step 7: release the upstream credential.
  //
  // After step 6 deliberately. Uninstall is monotonic toward
  // "uninstalled", and a connection left revoked with its credential
  // still present is closer to that than a live connection whose secret
  // has been removed from under it. The dependent scan excludes this
  // connection explicitly rather than relying on the revoke above, so
  // the ordering stays a safety property and not a correctness one.
  // -------------------------------------------------------------------
  const upstreamCredential = await releaseUpstreamCredential(
    storage,
    connection,
    input.spaceId,
  );

  // -------------------------------------------------------------------
  // Step 8: emit system.activity row.
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
          upstream_credential: upstreamCredential,
          leased_tokens_revoked: leasedTokensRevoked,
          inbound_webhooks_disabled: inboundWebhooksDisabled,
        },
      },
    },
    input.spaceId,
  );

  // -------------------------------------------------------------------
  // Step 9: audit log. Awaited — failures are not silently swallowed.
  // -------------------------------------------------------------------
  await storage.audit.log({
    key_id: input.apiKeyId,
    client_ip: input.clientIp ?? null,
    space_id: input.spaceId ?? null,
    action: "integration.uninstall",
    resource_type: "item",
    resource_id: input.connectionId,
    details: {
      integration_ref: integrationRef ?? null,
      revoked_credential_ids: revokedCredentialIds,
      oauth_tokens_deleted: oauthTokensDeleted,
      upstream_credential: upstreamCredential,
      leased_tokens_revoked: leasedTokensRevoked,
      inbound_webhooks_disabled: inboundWebhooksDisabled,
      activity_id: activity.id,
    },
  });

  return {
    connection_id: input.connectionId,
    revoked_credential_ids: revokedCredentialIds,
    oauth_tokens_deleted: oauthTokensDeleted,
    upstream_credential: upstreamCredential,
    leased_tokens_revoked: leasedTokensRevoked,
    inbound_webhooks_disabled: inboundWebhooksDisabled,
    activity_id: activity.id,
  };
}
