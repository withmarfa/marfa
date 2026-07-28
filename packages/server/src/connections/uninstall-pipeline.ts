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
 *   3. Disarm the connection's hosted-substrate schedule so its
 *      per-Connection alarm stops firing. Same place as credential
 *      revocation because it is the same job: cutting the connection's
 *      ability to keep doing work. Applies to every connection on the
 *      `hosted` substrate.
 *   4. Delete the `connection_oauth_tokens` row if present (the upstream
 *      OAuth tokens cached for the proxy).
 *   5. Revoke every active `connection_leased_tokens` row.
 *   6. Disable every `inbound_webhooks` subscription bound to this
 *      connection so further deliveries are dropped.
 *   7. Transition the `system.connection` item state from `active` to
 *      `revoked` (the bounded system.* lifecycle's terminal state).
 *   8. Emit a `system.activity` row recording the uninstall.
 *   9. Awaited audit-log write.
 *
 * Authorization lives at the route layer — this function is callable
 * with any storage handle and trusts the caller to have gated already.
 *
 * Internal-call bypass — the `system.connection` transition at step 7
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
  /** Resolved client IP. Threaded into the audit row. */
  clientIp?: string | null;
  /**
   * Which integrations substrate this deployment runs. The schedule-
   * disarm step only applies to `hosted`: the local scheduler's walker
   * gates on connection state, so a revoked connection stops being
   * scheduled with nothing to cancel.
   *
   * This is the authoritative switch, deliberately separate from the
   * coordinates below. Deriving the substrate from whether the
   * coordinates happen to be set means a hosted deployment missing a
   * secret is silently treated as a self-host: every disarm skipped,
   * every alarm left ticking, and a result shape identical to a correct
   * self-host's.
   *
   * Optional so existing callers and test fixtures keep compiling;
   * absent behaves as `local`, matching the server's own default.
   */
  integrationRuntime?: "hosted" | "local";
  /**
   * Runtime-control plane URL and broker key, for the schedule-disarm
   * step. Required when `integrationRuntime` is `hosted`; a hosted
   * deployment missing either one fails the step loudly rather than
   * skipping it.
   */
  controlPlaneUrl?: string;
  runtimeBrokerKey?: string;
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
  /** True only when a Durable Object attested that it cancelled the
   *  alarm. False when there was nothing to cancel (the local substrate,
   *  or an integration that deploys no Worker) and false when the disarm
   *  was attempted and failed — the two are distinguished by
   *  `schedule_disarm_error`. */
  schedules_disarmed: boolean;
  /** Present only when the disarm attempt ran and failed. An operator
   *  should re-run the disarm; see the emitted `action_required`
   *  activity. */
  schedule_disarm_error?: string;
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
  // Step 3: disarm the connection's hosted-substrate schedule.
  //
  // The per-Connection Durable Object alarm re-arms itself on every
  // fire, so revoking credentials alone leaves it ticking forever
  // against a connection that no longer exists — work that can never
  // succeed and error noise that never stops.
  //
  // A failure here does NOT fail the uninstall. Three reasons:
  //   - This pipeline is monotonic toward "uninstalled" and does not
  //     compensate earlier steps, so aborting now would strand the
  //     connection `active` with its credentials already revoked, which
  //     is strictly worse than finishing.
  //   - The alarm's remaining reach is already cut: the connection ends
  //     up `revoked`, and the credential broker refuses to mint for a
  //     non-active connection. The residue is noise, not damage.
  //   - Uninstall is the user-visible action and it has already done the
  //     part that matters. Failing it would report "nothing happened"
  //     for a connection whose credentials are gone.
  // What this step must not assume is that the runtime cleans up after
  // itself. Per-Integration Workers deploy on their own cadence, so a
  // connection's Worker may be running a bundle that predates
  // terminal-lease handling entirely: it retries the refusal forever and
  // the alarm keeps ticking. Only a bundle that acts on a terminal lease
  // refusal disarms itself, so the cost of a missed disarm is one tick
  // for some connections and unbounded for others.
  // What it must not do is pass silently, so the failure lands on the
  // result, in an `action_required` activity, and in the audit row.
  // -------------------------------------------------------------------
  const integrationRefForDisarm = connection.properties.integration_ref as
    | string
    | undefined;
  const disarm = await disarmConnectionSchedule(storage, {
    connectionId: input.connectionId,
    tenantId: input.tenantId,
    integrationRef: integrationRefForDisarm,
    integrationRuntime: input.integrationRuntime ?? "local",
    controlPlaneUrl: input.controlPlaneUrl,
    runtimeBrokerKey: input.runtimeBrokerKey,
  });

  // -------------------------------------------------------------------
  // Step 4: delete the connection_oauth_tokens row if present.
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
  // Step 5: revoke every active leased token for this connection.
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
  // Step 6: disable inbound webhook subscriptions tied to this connection.
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
  // Step 7: transition system.connection state to revoked.
  // active → revoked is the only allowed system.* lifecycle transition,
  // matching the precondition asserted in step 1.
  // -------------------------------------------------------------------
  await storage.items.transition(input.connectionId, "revoked", input.tenantId);

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
          leased_tokens_revoked: leasedTokensRevoked,
          inbound_webhooks_disabled: inboundWebhooksDisabled,
          schedules_disarmed: disarm.disarmed,
        },
      },
    },
    input.tenantId,
  );

  // -------------------------------------------------------------------
  // Step 9: audit log. Awaited — failures are not silently swallowed.
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
      schedules_disarmed: disarm.disarmed,
      ...(disarm.error !== undefined
        ? { schedule_disarm_error: disarm.error }
        : {}),
      activity_id: activity.id,
    },
  });

  return {
    connection_id: input.connectionId,
    revoked_credential_ids: revokedCredentialIds,
    oauth_tokens_deleted: oauthTokensDeleted,
    leased_tokens_revoked: leasedTokensRevoked,
    inbound_webhooks_disabled: inboundWebhooksDisabled,
    schedules_disarmed: disarm.disarmed,
    ...(disarm.error !== undefined
      ? { schedule_disarm_error: disarm.error }
      : {}),
    activity_id: activity.id,
  };
}

interface DisarmOutcome {
  /**
   * True only when a Durable Object attested it cancelled an alarm.
   * "Nothing to cancel" is `false` with no error — the same shape the
   * local substrate reports — so the flag means one thing everywhere.
   */
  disarmed: boolean;
  /** Set only when a disarm was attempted and failed. */
  error?: string;
}

/**
 * The control plane's disarm envelope. `dispatched: false` is the
 * short-circuit for an integration that deploys no Worker; when it did
 * dispatch, `result.disarmed` is the Durable Object's own attestation
 * that `deleteAlarm()` ran.
 */
interface DisarmDispatchEnvelope {
  ok?: boolean;
  dispatched?: boolean;
  result?: { disarmed?: boolean } | null;
}

interface DisarmVerdict {
  /** Whether an alarm was actually cancelled. */
  cancelled: boolean;
  /** Set when the envelope does not describe a clean outcome at all. */
  failure?: string;
}

/**
 * Read a 2xx disarm envelope into a verdict.
 *
 * The attestation is `result.disarmed`, not the status and not the
 * envelope's own `ok`. A Worker that has no disarm route still answers
 * on its hostname, and a Worker answering from a generic handler
 * produces a 2xx the rest of the chain happily relays as success. Only
 * the Durable Object writes `disarmed`, and it writes it after
 * `deleteAlarm()` has run, so it is the one field that cannot be
 * produced by a Worker that did nothing.
 *
 * `dispatched: false` is neither: the control plane short-circuits for
 * an integration that deploys no Worker, where there is no Durable
 * Object to attest anything and nothing to tear down. That is not a
 * failure, and it is also not a cancellation — reporting it as one would
 * make the result field mean "we asked" in one branch and "an alarm
 * stopped" in another.
 */
function verifyDisarmEnvelope(body: DisarmDispatchEnvelope): DisarmVerdict {
  if (body.ok === false) {
    return {
      cancelled: false,
      failure: "control plane reported the disarm dispatch failed",
    };
  }
  if (body.dispatched === false) return { cancelled: false };
  if (body.result?.disarmed !== true) {
    return {
      cancelled: false,
      failure:
        "control plane returned success but the Worker did not attest the alarm was disarmed (no result.disarmed) — the integration Worker may predate the disarm route",
    };
  }
  return { cancelled: true };
}

/**
 * Ask the runtime-control plane to cancel a connection's schedule alarm.
 *
 * Never throws: the caller is mid-teardown and a throw here would strand
 * the connection half-uninstalled. Failure is reported back so the caller
 * can surface it, and an `action_required` activity is emitted so it
 * reaches an operator rather than only a response body nobody reads.
 */
async function disarmConnectionSchedule(
  storage: Storage,
  args: {
    connectionId: string;
    tenantId?: string;
    integrationRef?: string;
    integrationRuntime: "hosted" | "local";
    controlPlaneUrl?: string;
    runtimeBrokerKey?: string;
  },
): Promise<DisarmOutcome> {
  if (args.integrationRuntime !== "hosted") {
    // Local substrate — no Durable Object alarms exist to cancel.
    return { disarmed: false };
  }

  // Every hosted connection gets a dispatch, including ones whose
  // install-time triggers carry no schedule. Those triggers are a
  // snapshot of the manifest at install; whether an alarm exists depends
  // on the deployed Worker's MANIFEST_CRON and on whether an arm ever
  // ran, and the two diverge — an integration can ship webhook-only, be
  // redeployed with a schedule trigger, and have an operator arm an
  // existing connection through the documented retry path. Gating on the
  // stale snapshot would skip the disarm for exactly that connection and
  // leave its alarm ticking forever, which is the failure this step
  // exists to prevent. Dispatching when there is nothing to cancel costs
  // a reported failure an operator can ignore or retry; skipping when
  // there is costs an orphan nobody finds.
  const controlPlaneUrl = args.controlPlaneUrl;
  const brokerKey = args.runtimeBrokerKey;

  let integrationName: string | undefined;
  if (args.integrationRef) {
    const integration = await storage.items.get(
      args.integrationRef,
      args.tenantId,
      { includePlatformScoped: true },
    );
    if (integration?.type === "system.integration") {
      const name = (integration.properties as { manifest_name?: unknown })
        .manifest_name;
      if (typeof name === "string" && name.length > 0) integrationName = name;
    }
  }

  const url =
    controlPlaneUrl && brokerKey
      ? `${controlPlaneUrl.replace(/\/$/, "")}/connections/${args.connectionId}/disarm-schedule`
      : null;
  let failure: string | undefined;
  let cancelled = false;

  if (!url || !brokerKey) {
    // Hosted, but the runtime-control coordinates are missing. The alarm
    // is real and still ticking; reporting a clean skip here would hide a
    // broken deployment behind the same result a correct self-host
    // produces.
    failure =
      "hosted substrate is missing runtime-control coordinates (MARFA_RUNTIME_CONTROL_URL / MARFA_RUNTIME_BROKER_KEY); the schedule alarm is still armed";
  } else if (!integrationName) {
    failure = "connection has no resolvable integration manifest name";
  } else {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${brokerKey}`,
        },
        body: JSON.stringify({ integration_name: integrationName }),
      });
      if (!res.ok) {
        const body = await res.text();
        failure = `control plane returned ${String(res.status)}: ${body.slice(0, 256)}`;
      } else {
        const body = (await res.json()) as DisarmDispatchEnvelope;
        const verdict = verifyDisarmEnvelope(body);
        failure = verdict.failure;
        cancelled = verdict.cancelled;
      }
    } catch (err) {
      failure =
        err instanceof Error
          ? `control plane unreachable: ${err.message}`
          : `control plane unreachable: ${String(err)}`;
    }
  }

  if (!failure) return { disarmed: cancelled };

  try {
    await storage.items.create(
      {
        type: "system.activity",
        properties: {
          connection_id: args.connectionId,
          severity: "action_required" as const,
          summary: `Schedule alarm not disarmed for connection ${args.connectionId}`,
          detail: {
            reason: failure,
            integration_name: integrationName ?? null,
            disarm_url: url,
          },
        },
      },
      args.tenantId,
    );
  } catch {
    // The activity emit is the operator surface, not the source of
    // truth. `schedule_disarm_error` on the result and the audit row
    // still carry the failure if this write is the thing that broke.
  }

  return { disarmed: false, error: failure };
}
