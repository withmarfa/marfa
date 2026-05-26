/**
 * Integration install pipeline — workstream 3 Layer 2 PR 1.
 *
 * Owns the multi-step install of an Integration manifest into a tenant:
 *   1. Insert a `system.connection.integration` item bound
 *      to the Integration's id (via `integration_ref`).
 *   2. Mint a runtime credential bound to the new connection id (apiKeys
 *      row stamped with `is_runtime_credential: true` and `connection_id`).
 *   3. Emit a `system.activity` row referencing the connection.
 *
 * Order matters — the runtime credential mint stamps `connection_id`, so
 * the connection id must exist first. The orchestrator's plan-review
 * flagged the call sequence as "credential mint → connection insert →
 * activity emit"; the actual execution order is connection-first because
 * the credential needs the id to bind to. Outcome is identical: no
 * orphan credentials, no half-installed state.
 *
 * Atomicity — `storage.runInTransaction` is genuinely transactional on
 * both dialects (T-071), but install spans multiple storage stores and
 * external side effects (audit, activity emit), and a single Drizzle tx
 * doesn't bracket those cleanly. So the pipeline uses **compensating
 * writes**: each step records what to undo on failure, and the catch-all
 * reverses them in reverse order. The compensations are idempotent.
 *
 * Internal-call bypass — the runtime credential mint at step 2 calls
 * `storage.keys.createRuntimeCredential` directly rather than going
 * through the HTTP `POST /system/runtime-credentials` route. This
 * intentionally bypasses the broker-key (`is_platform: true`) check
 * that route enforces — at install time the caller is the better-auth
 * session user (a human approving a connection), not the control-plane
 * lease broker. Documented here so future readers don't read the
 * bypass as an oversight.
 *
 * Manifest version compatibility — the install binds the connection to
 * a specific `integration_ref` at the manifest's exact version. When a
 * new manifest version registers as a sibling item, existing
 * connections keep pointing at the old version's item id; an explicit
 * upgrade flow (Layer 3 work) would re-bind. Plan B does not address
 * the upgrade flow on purpose.
 */
import { randomBytes } from "node:crypto";
import {
  ErrorCode,
  MarfaError,
  type IntegrationManifest,
} from "@withmarfa/shared";
import { hashApiKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

const KEY_PREFIX = "marfa_k1_";

/** TTL for the seed runtime credential the install mints. The control
 *  plane's lease broker re-mints on 401, so this only needs to outlast
 *  the gap between install and first scheduled poll — 1 hour is comfortable
 *  for any realistic schedule cadence. */
const INSTALL_CREDENTIAL_TTL_SECONDS = 3600;

export interface InstallInput {
  /** The api_keys row id of the caller (audit trail). */
  apiKeyId: string;
  /** Tenant scope for every row written. */
  tenantId?: string;
  /** id of the system.integration item the connection binds to. */
  integrationItemId: string;
  /** The manifest blob (already validated on registration). Drives
   *  permission translation and trigger persistence. */
  manifest: Record<string, unknown> | IntegrationManifest;
  /** Display label for the credential and connection. Falls back to
   *  `${manifest_name} ${manifest_version}` at the route layer. */
  label: string;
  /** Resolved client IP of the caller (T-027). Threaded into the audit
   *  row so installs are attributable. Null when the install runs
   *  outside a Hono request (e.g. one-shot CLI scripts). */
  clientIp?: string | null;
  /**
   * Optional id of a pre-existing `system.credential` to reference from
   * the new connection. Multiple integrations of the same upstream
   * (e.g. `google.calendar` + `google.tasks`) share one credential row
   * instead of duplicating per-integration.
   *
   * Two credential kinds are accepted (T-241):
   *   - `kind: "oauth_token"` — created by
   *     `POST /credentials/oauth-provider`. Carries OAuth client config
   *     + encrypted client secret. The connection's OAuth dance reads
   *     it at `/oauth/callback/:provider`; the proxy reads it for
   *     refresh.
   *   - `kind: "api_token"` — created by `POST /credentials/api-token`.
   *     Carries upstream base URL + encrypted bearer. The proxy stamps
   *     the bearer transparently; no refresh primitive.
   *
   * Per-install behaviour:
   *   - When unset: no `credential_ref` is set on the connection.
   *     Token-backed or OAuth-backed integrations must populate it
   *     out-of-band before any proxy or callback call works.
   *   - When set: validated to resolve to a `system.credential` whose
   *     `kind` is one of the accepted set, in the caller's tenant.
   *     Stamped onto `connection.properties.credential_ref` at step 1.
   *     A mismatched or missing credential rejects the install with
   *     `INVALID_REQUEST` before any state is written.
   *
   * The runtime credential (the api_key bound to the new connection_id)
   * stays per-install — it's NOT reused. Only the provider credential is.
   */
  credentialRef?: string;
  /**
   * Optional initial `properties.configuration` seed for the new
   * connection. The install-pipeline always creates the connection with
   * an empty `configuration: {}`; this seed merges over that empty
   * default, letting server-side install paths (admin install via
   * `POST /connections/install`) pre-populate per-connection knobs that
   * would otherwise require a follow-on `PATCH /items/:id` round-trip.
   *
   * T-254 motivating case: `upstream_base_url_override` so a
   * connection sharing the shared google.* OAuth credential can point
   * at a per-host upstream (e.g. `people.googleapis.com` for
   * `google.contacts`). Without this seam, the override has to be
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
  credential_id: string;
  activity_id: string;
}

function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

/** Translate manifest.permissions into a runtime-credential
 *  `extension_permissions` map. The `connection.runtime` namespace is
 *  always granted write — the runtime needs it to hydrate its own
 *  cursor state — and any manifest-declared extension grants merge on
 *  top. Same shape the broker uses at refresh time, kept in sync here
 *  so the seed credential and refreshed credentials carry identical
 *  permissions. */
function buildExtensionPermissions(
  manifest: IntegrationManifest,
): Record<string, "read" | "write"> {
  const out: Record<string, "read" | "write"> = {
    "connection.runtime": "write",
  };
  const declared = manifest.permissions?.extension;
  if (declared) {
    for (const [ns, level] of Object.entries(declared)) {
      out[ns] = level;
    }
  }
  return out;
}

function buildEdgePermissions(
  manifest: IntegrationManifest,
): Record<string, "read" | "write"> {
  const declared = manifest.permissions?.edge;
  return declared ? { ...declared } : {};
}

/** Translate manifest.target_types + direction into a `type_permissions`
 *  map. Read-only Integrations get `read` on each target type;
 *  write/both get `write`. The runtime's per-Connection
 *  ConnectionClient enforces these at the server boundary. */
function buildTypePermissions(
  manifest: IntegrationManifest,
): Record<string, "read" | "write"> {
  const level: "read" | "write" =
    manifest.direction === "read" ? "read" : "write";
  const out: Record<string, "read" | "write"> = {};
  for (const t of manifest.target_types) {
    out[t] = level;
  }
  return out;
}

export async function performInstall(
  storage: Storage,
  salt: string,
  input: InstallInput,
): Promise<InstallResult> {
  const manifest = input.manifest as IntegrationManifest;
  const now = new Date().toISOString();

  // -------------------------------------------------------------------
  // Pre-step: validate `credentialRef` resolves to a usable
  // `kind: oauth_token` credential in the caller's tenant. Done BEFORE
  // any writes so a bad ref doesn't leak compensating-write activity.
  // -------------------------------------------------------------------
  if (input.credentialRef !== undefined) {
    const candidate = await storage.items.get(
      input.credentialRef,
      input.tenantId,
    );
    if (candidate?.type !== "system.credential") {
      throw new MarfaError(
        ErrorCode.INVALID_REQUEST,
        `credential_ref ${input.credentialRef} does not resolve to a system.credential item in this tenant`,
        { credential_ref: input.credentialRef },
      );
    }
    const credProps = candidate.properties as { kind?: unknown };
    // T-241: accept both oauth_token (the original kind) and api_token
    // (static-bearer integrations). Both shapes carry an
    // upstream_base_url + an encrypted secret; the connection-proxy
    // branches at request time on `kind`.
    if (credProps.kind !== "oauth_token" && credProps.kind !== "api_token") {
      throw new MarfaError(
        ErrorCode.INVALID_REQUEST,
        `credential_ref ${input.credentialRef} resolves to a system.credential of kind '${String(credProps.kind)}'; expected 'oauth_token' or 'api_token'`,
        { credential_ref: input.credentialRef, kind: credProps.kind },
      );
    }
  }

  // Compensation stack — each step pushes a rollback closure. On any
  // subsequent failure we walk the stack in reverse and re-throw.
  //
  // T-012: do NOT use `compensations.reverse()` — that mutates the array
  // in place. If a recovery path re-invokes rollback (or any code reads
  // `compensations` after rollback returns) the stack is silently
  // backwards from where the caller expects. Iterate via a downward
  // index instead so the original push-order is preserved.
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
    // T-254: seed from optional install-time configuration; falls back
    // to the empty default. The bag stays free-form — per-integration
    // install contracts validate their own keys.
    configuration: input.configuration ?? {},
    direction: manifest.direction,
    triggers: manifest.triggers,
    runtime_status: "healthy" as const,
    feed_activity: false,
  };
  if (input.credentialRef !== undefined) {
    connectionProperties.credential_ref = input.credentialRef;
  }

  const connection = await storage.items.create(
    {
      type: "system.connection",
      properties: connectionProperties,
    },
    input.tenantId,
  );
  compensations.push(async () => {
    // Trash rather than hard-delete — leaves an audit trail. The retention
    // job will purge eventually.
    await storage.items.transition(connection.id, "trashed", input.tenantId);
  });

  // -------------------------------------------------------------------
  // Step 2: mint runtime credential bound to the new connection id.
  // Internal call bypasses the broker-key check on POST
  // /system/runtime-credentials — see file docstring for rationale.
  // -------------------------------------------------------------------
  const rawKey = generateRawKey();
  const keyHash = hashApiKey(rawKey, salt);
  const credentialLabel = input.label.slice(0, 200);
  const credentialSource = `integration:${connection.id}`;

  let credential;
  try {
    credential = await storage.keys.createRuntimeCredential(
      {
        label: credentialLabel,
        source: credentialSource,
        role: "member",
        type_permissions: buildTypePermissions(manifest),
        extension_permissions: buildExtensionPermissions(manifest),
        edge_permissions: buildEdgePermissions(manifest),
        connection_id: connection.id,
      },
      keyHash,
      input.tenantId,
    );
  } catch (err) {
    return rollback(err);
  }
  compensations.push(async () => {
    await storage.keys.revoke(credential.id);
  });

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
            credential_id: credential.id,
          },
        },
      },
      input.tenantId,
    );
  } catch (err) {
    return rollback(err);
  }

  // -------------------------------------------------------------------
  // Audit trail (T-012). Awaited and rolled back on failure — `system.connection`
  // writes are operationally significant and an unaudited install isn't
  // auditable. Pre-T-012 this was `void storage.audit.log(...)`, which
  // swallowed audit-DB failures silently.
  // -------------------------------------------------------------------
  try {
    await storage.audit.log({
      key_id: input.apiKeyId,
      client_ip: input.clientIp ?? null,
      tenant_id: input.tenantId ?? null,
      action: "integration.install",
      resource_type: "item",
      resource_id: connection.id,
      details: {
        integration_ref: input.integrationItemId,
        credential_id: credential.id,
        activity_id: activity.id,
        manifest_name: manifest.name,
        manifest_version: manifest.version,
        ttl_seconds: INSTALL_CREDENTIAL_TTL_SECONDS,
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
    credential_id: credential.id,
    activity_id: activity.id,
  };
}

/**
 * Best-effort: ask the control plane to arm the per-Connection alarm
 * for a freshly-installed integration that has a `schedule` trigger.
 *
 * Called by the install route after `performInstall` completes. Failures
 * here do NOT roll back the install — instead they surface as a
 * `system.activity` of severity `action_required` so an operator sees
 * the dangling install and can retry. A scheduled integration whose
 * alarm wasn't armed sits silent rather than firing; arming is
 * idempotent so a manual re-call is the recovery path.
 */
export async function armScheduleForInstall(
  storage: Storage,
  args: {
    manifest: IntegrationManifest;
    connectionId: string;
    tenantId?: string;
    controlPlaneUrl: string;
    runtimeBrokerKey: string;
  },
): Promise<void> {
  const hasSchedule = args.manifest.triggers.some((t) => t.type === "schedule");
  if (!hasSchedule) return;

  const url = `${args.controlPlaneUrl.replace(/\/$/, "")}/connections/${args.connectionId}/arm-schedule`;
  let outcome: "ok" | "failed" = "failed";
  let detail: Record<string, unknown>;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.runtimeBrokerKey}`,
      },
      body: JSON.stringify({ integration_name: args.manifest.name }),
    });
    const body = (await res.json()) as { ok?: boolean; status?: number };
    detail = { control_plane_status: res.status, result: body };
    if (res.ok && body.ok !== false) {
      outcome = "ok";
    }
  } catch (err) {
    detail = {
      reason: "control_plane_unreachable",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (outcome === "ok") return;

  // Surface as action_required so the operator can investigate +
  // retry. The connection is otherwise installed correctly.
  try {
    await storage.items.create(
      {
        type: "system.activity",
        properties: {
          connection_id: args.connectionId,
          severity: "action_required" as const,
          summary: `Schedule alarm not armed for ${args.manifest.name}`,
          detail: {
            ...detail,
            integration_name: args.manifest.name,
            arm_url: url,
          },
        },
      },
      args.tenantId,
    );
  } catch {
    // Activity emission failure is non-fatal — the install itself
    // succeeded.
  }
}

export { INSTALL_CREDENTIAL_TTL_SECONDS };
