/**
 * Integration install pipeline.
 *
 * Owns the multi-step install of an Integration manifest into a space:
 *   1. Insert a `system.connection.integration` item bound
 *      to the Integration's id (via `integration_ref`).
 *   2. Confirm the new Connection is one a runtime credential may later
 *      be minted for, and refuse the install if it is not.
 *   3. Emit a `system.activity` row referencing the connection.
 *
 * Order matters: step 2 reads the row step 1 wrote, so the connection
 * must exist first, and a refusal there rolls step 1 back rather than
 * leaving a Connection nobody asked for.
 *
 * Installing mints no credential. It used to, and nothing could ever
 * present the result: the plaintext was discarded at the end of this
 * function and no route can reveal it. A Connection with no credential
 * is fully dispatchable, because the supervisor mints per dispatch
 * without consulting what is already there, and that mint revokes
 * whatever it finds. The row's only visible effect was a key in the
 * space's list that a space admin did not create and could not use.
 *
 * Atomicity — `storage.runInTransaction` is genuinely transactional on
 * both dialects, but install spans multiple storage stores and
 * external side effects (audit, activity emit), and a single Drizzle tx
 * doesn't bracket those cleanly. So the pipeline uses **compensating
 * writes**: each step records what to undo on failure, and the catch-all
 * reverses them in reverse order. The compensations are idempotent.
 *
 * Step 2 survives the mint it used to guard, and deliberately. Whether a
 * Connection may produce a platform-tier credential is a property of the
 * Connection rather than of any one mint, and this is the third of three
 * doors enforcing it: a space-less Connection on a hosted deployment
 * must not exist in an installable state at all. Checking it here means
 * the install fails loudly, naming the missing space, instead of
 * succeeding and leaving the first dispatch to discover it. A rule
 * enforced on two of three doors is not a rule.
 *
 * Manifest version compatibility — the install binds the connection to
 * a specific `integration_ref` at the manifest's exact version. When a
 * new manifest version registers as a sibling item, existing
 * connections keep pointing at the old version's item id; an explicit
 * upgrade flow would re-bind. This is intentionally out of scope here.
 */
import {
  applyConfigurationDefaults,
  ErrorCode,
  MarfaError,
  validateConnectionConfiguration,
  type IntegrationManifest,
} from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import {
  withConnectionLifecycleLock,
  withConnectionLifecycleLockInTransaction,
} from "./lifecycle-lock.js";
import { assertMintableSpaceScope } from "./runtime-credential-lifecycle.js";
import { writeRevokedConnectionState } from "./revoked-connection.js";

export interface InstallInput {
  /** The api_keys row id of the caller (audit trail). */
  apiKeyId: string;
  /** Space scope for every row written. */
  spaceId?: string;
  /**
   * The deployment's `AUTH_MODE`, for the space fence at step 2.
   * Required rather than defaulted: the permissive value is the one that
   * reopens the hole, so a caller that has not thought about it should
   * not compile.
   */
  authMode: "hosted" | "keys";
  /** id of the system.integration item the connection binds to. */
  integrationItemId: string;
  /** The manifest blob (already validated on registration). Drives
   *  permission translation and trigger persistence. */
  manifest: Record<string, unknown> | IntegrationManifest;
  /** Resolved client IP of the caller. Threaded into the audit row so
   *  installs are attributable. Null when the install runs outside a
   *  Hono request (e.g. one-shot CLI scripts). */
  clientIp?: string | null;
  /**
   * Optional id of a pre-existing `system.credential` to reference from
   * the new connection. Multiple integrations of the same upstream
   * (e.g. `google/calendar` + `google/tasks`) share one credential row
   * instead of duplicating per-integration.
   *
   * Two credential kinds are accepted:
   *   - `kind: "oauth_token"` — created by
   *     `POST /credentials/oauth-provider`. Carries OAuth client config
   *     + encrypted client secret. The connection's OAuth dance reads
   *     it at `/oauth/callback`; the proxy reads it for
   *     refresh.
   *   - `kind: "api_token"` — created by `POST /credentials/api-token`.
   *     Carries upstream base URL + encrypted bearer. The proxy stamps
   *     the bearer transparently; no refresh primitive.
   *
   * Per-install behavior:
   *   - When unset: no `credential_ref` is set on the connection.
   *     Token-backed or OAuth-backed integrations must populate it
   *     out-of-band before any proxy or callback call works.
   *   - When set: validated to resolve to a `system.credential` whose
   *     `kind` is one of the accepted set, in the caller's space.
   *     Stamped onto `connection.properties.credential_ref` at step 1.
   *     A mismatched or missing credential rejects the install with
   *     `INVALID_REQUEST` before any state is written.
   *
   * This is the upstream provider credential, and the only credential an
   * install touches. The per-Connection runtime credential is a separate
   * thing entirely, minted per dispatch by the supervisor rather than
   * here.
   */
  credentialRef?: string;
  /**
   * Optional initial `properties.configuration` seed for the new
   * connection. It merges over the manifest's declared defaults, which the
   * pipeline writes in for every key this seed leaves out, letting
   * server-side install paths (admin install via
   * `POST /connections/install`) pre-populate per-connection knobs that
   * would otherwise require a follow-on `PATCH /items/:id` round-trip.
   *
   * An omitted key is therefore answered by the manifest rather than left
   * for a handler to answer. It used to be left, and Google Calendar's two
   * resolution branches came to disagree about what an unconfigured
   * connection writes.
   *
   * Motivating case: `upstream_base_url_override` so a connection
   * sharing the shared google.* OAuth credential can point at a
   * per-host upstream (e.g. `people.googleapis.com` for
   * `google/contacts`). Without this seam, the override has to be
   * patched onto the connection after install but before the OAuth
   * dance — fragile.
   *
   * The bag is type-erased intentionally — the connection's
   * `configuration` map is free-form JSON owned by each integration's
   * install-time consent contract. The proxy + handlers validate the
   * specific keys they consume; this seam doesn't try to schema-check
   * the whole bag.
   */
  configuration?: Record<string, unknown>;
}

export interface InstallResult {
  connection_id: string;
  activity_id: string;
}

export async function performInstall(
  storage: Storage,
  input: InstallInput,
): Promise<InstallResult> {
  const manifest = input.manifest as IntegrationManifest;
  const now = new Date().toISOString();

  // -------------------------------------------------------------------
  // Pre-step: validate `credentialRef` resolves to a usable
  // `kind: oauth_token` credential in the caller's space. Done BEFORE
  // any writes so a bad ref doesn't leak compensating-write activity.
  // -------------------------------------------------------------------
  if (input.credentialRef !== undefined) {
    const candidate = await storage.items.get(
      input.credentialRef,
      input.spaceId,
    );
    if (candidate?.type !== "system.credential") {
      throw new MarfaError(
        ErrorCode.INVALID_REQUEST,
        `credential_ref ${input.credentialRef} does not resolve to a system.credential item in this space`,
        { credential_ref: input.credentialRef },
      );
    }
    const credProps = candidate.properties as { kind?: unknown };
    // Accept both oauth_token and api_token credential kinds. Both
    // shapes carry an upstream_base_url + an encrypted secret; the
    // connection-proxy branches at request time on `kind`.
    if (credProps.kind !== "oauth_token" && credProps.kind !== "api_token") {
      throw new MarfaError(
        ErrorCode.INVALID_REQUEST,
        `credential_ref ${input.credentialRef} resolves to a system.credential of kind '${String(credProps.kind)}'; expected 'oauth_token' or 'api_token'`,
        { credential_ref: input.credentialRef, kind: credProps.kind },
      );
    }
    // The credential and the manifest have to agree about what this
    // integration authenticates with. `oauth_requirements` is what the
    // proxy reads to decide which capability a call spends and whether it
    // is proxied or leased, so binding an OAuth credential to a manifest
    // that declares none installs a connection whose grant nothing can
    // project — and the failure would arrive later, at the first mint,
    // rather than here where the two are being joined.
    if (
      credProps.kind === "oauth_token" &&
      Object.keys(manifest.oauth_requirements ?? {}).length === 0
    ) {
      throw new MarfaError(
        ErrorCode.INVALID_REQUEST,
        `credential_ref ${input.credentialRef} is an OAuth credential, but ${manifest.name} declares no oauth_requirements, so nothing says which capability the grant covers or how it is spent.`,
        { credential_ref: input.credentialRef, kind: credProps.kind },
      );
    }
  }

  // The configuration seed is judged against the manifest's declared
  // contract before anything is written — an undeclared key is refused,
  // because only the integration's author could know it existed, and a
  // missing required key would install a Connection that cannot run.
  const configurationIssues = validateConnectionConfiguration(
    manifest,
    input.configuration ?? {},
    { requireRequired: true },
  );
  if (configurationIssues.length > 0) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "Connection configuration does not match the integration's declared contract",
      { issues: configurationIssues },
    );
  }

  // Compensation stack — each step pushes a rollback closure. On any
  // subsequent failure we walk the stack in reverse and re-throw.
  //
  // Do NOT use `compensations.reverse()` — that mutates the array in
  // place. Iterate via a downward index so the original push-order is
  // preserved; any code that re-reads `compensations` after rollback
  // sees the same sequence.
  //
  // Only one step registers a compensation now that the credential mint
  // is gone, so the reverse walk has nothing to order and no test can
  // observe it. The rule is kept because it is a property of the walker
  // rather than of how many steps happen to use it. A second
  // compensation must arrive with a test that pins the order, or this
  // becomes a comment nothing enforces.
  const compensations: (() => Promise<void>)[] = [];
  const rollback = async (originalErr: unknown): Promise<never> => {
    for (let i = compensations.length - 1; i >= 0; i--) {
      const undo = compensations[i];
      if (!undo) continue;
      try {
        await undo();
      } catch (cleanupErr) {
        // Compensation failure is logged via audit on next install, not
        // surfaced to the caller — the original error is the actionable one.
        console.error("[install-pipeline] compensation failed", cleanupErr);
      }
    }
    throw originalErr;
  };

  // -------------------------------------------------------------------
  // Step 1: insert the system.connection item.
  // -------------------------------------------------------------------
  const connectionProperties: Record<string, unknown> = {
    kind: "integration" as const,
    status: "active" as const,
    granted_at: now,
    integration_ref: input.integrationItemId,
    // Seed from optional install-time configuration, with the manifest's
    // declared defaults filled in for anything the caller left out. Writing
    // them here rather than resolving them on each read is what stops a
    // handler inventing its own answer for an unconfigured key: there is no
    // unconfigured key left to invent one for. The bag stays free-form
    // beyond that — per-integration install contracts validate their own.
    configuration: applyConfigurationDefaults(
      manifest,
      input.configuration ?? {},
    ),
    direction: manifest.direction,
    runtime_status: "healthy" as const,
    feed_activity: false,
  };
  // Absent rather than `undefined`: a client-run manifest declares no
  // triggers, and stamping the key with nothing in it would put a field on
  // the connection that reads as "declared, empty" instead of "not
  // declared".
  if (manifest.triggers !== undefined) {
    connectionProperties.triggers = manifest.triggers;
  }
  if (input.credentialRef !== undefined) {
    connectionProperties.credential_ref = input.credentialRef;
  }

  const connection = await storage.items.create(
    {
      type: "system.connection",
      properties: connectionProperties,
    },
    input.spaceId,
  );
  compensations.push(async () => {
    // `revoked`, not `trashed`. `system.*` types carry the bounded
    // lifecycle — `active → revoked` is the only transition they have —
    // so a trash here raises `invalid_transition`, which the
    // compensation walker logs and swallows. The visible result was a
    // rollback that left the Connection active: every install failure
    // after this point stranded a live Connection nobody had asked for.
    //
    // Which fields, and why each of them, lives with the writer. The point
    // here is that the writer is shared with uninstall: this and that are
    // the two producers of a revoked connection, and correcting one of
    // them without the other is how they came to disagree.
    //
    // Under the lifecycle lock. This was the only lifecycle-state write in
    // this directory running unlocked: uninstall, pause and upgrade all
    // take it, and the connection is externally visible and mutable from
    // the moment step 1 commits, so a rollback racing a pause could
    // interleave with it.
    //
    // The transaction-riding shape rather than the bracketing one, because
    // this is pure database work. The bracketing form holds a pool
    // connection for the length of the callback and then needs a second
    // slot for the work inside it, which is the shape that once stopped the
    // server answering. The writer opens its own transaction inside that
    // one deliberately rather than relying on the lock helper to supply
    // one: the helper supplies a transaction on Postgres and not on SQLite,
    // where it falls back to the bracketing form, so taking it alone would
    // quietly leave the two writes unatomic on one dialect. Postgres
    // resolves the inner call to a savepoint.
    await withConnectionLifecycleLockInTransaction(storage, connection.id, () =>
      writeRevokedConnectionState(storage, connection.id, input.spaceId),
    );
  });

  // -------------------------------------------------------------------
  // Step 2: confirm the Connection is still one a runtime credential may
  // be minted for. A precondition in its own right, not a side effect of
  // minting one.
  // -------------------------------------------------------------------
  try {
    // The lock is what makes the state read below mean anything. The
    // Connection row is visible to a space admin the moment step 1
    // commits, so an uninstall can reach it before this line runs, and an
    // install that completed behind that sweep would leave an active
    // Connection the sweep believed it had revoked.
    //
    // The fence is the rule that a space-less credential is the platform
    // tier rather than a narrow one; an admin installing without naming a
    // space is exactly how one gets minted. Refusing here rather than at
    // the first dispatch is what makes the failure legible: the install
    // says which space is missing, while a dispatch-time refusal surfaces
    // as an integration that installed cleanly and never ran.
    await withConnectionLifecycleLock(storage, connection.id, async () => {
      const current = await storage.items.get(connection.id, input.spaceId);
      if (current?.type !== "system.connection") {
        throw new MarfaError(
          ErrorCode.CONNECTION_NOT_FOUND,
          `Connection ${connection.id} disappeared during install`,
          { connection_id: connection.id },
        );
      }
      if (current.state !== "active") {
        throw new MarfaError(
          ErrorCode.CONNECTION_NOT_ACTIVE,
          `Connection ${connection.id} is ${current.state}; it cannot be installed`,
          { connection_id: connection.id },
        );
      }
      assertMintableSpaceScope(current, input.authMode);
    });
  } catch (err) {
    return rollback(err);
  }

  // -------------------------------------------------------------------
  // Step 3: emit system.activity row.
  // -------------------------------------------------------------------
  let activity;
  try {
    activity = await storage.items.create(
      {
        type: "system.activity",
        properties: {
          connection_id: connection.id,
          severity: "info" as const,
          summary: `Installed ${manifest.name}@${manifest.version}`,
          detail: {
            integration_ref: input.integrationItemId,
            manifest_name: manifest.name,
            manifest_version: manifest.version,
          },
        },
      },
      input.spaceId,
    );
  } catch (err) {
    return rollback(err);
  }

  // -------------------------------------------------------------------
  // Audit trail, through the propagating writer. An install grants an
  // integration a standing share of the space's authority, so an
  // unaudited one must not stand: a failure here rolls the install back.
  //
  // `log` would not do it. It runs under a tracker that catches everything
  // and warns, so it cannot reject and the rollback below would never
  // run — which is what it did, for as long as this was written that way,
  // under a comment claiming the opposite.
  // -------------------------------------------------------------------
  try {
    await storage.audit.logOrThrow({
      key_id: input.apiKeyId,
      client_ip: input.clientIp ?? null,
      space_id: input.spaceId ?? null,
      action: "integration.install",
      resource_type: "item",
      resource_id: connection.id,
      details: {
        integration_ref: input.integrationItemId,
        activity_id: activity.id,
        manifest_name: manifest.name,
        manifest_version: manifest.version,
        ...(input.credentialRef !== undefined
          ? { credential_ref: input.credentialRef }
          : {}),
      },
    });
  } catch (err) {
    return rollback(err);
  }

  return {
    connection_id: connection.id,
    activity_id: activity.id,
  };
}
