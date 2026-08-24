/**
 * Moving a connection onto a newer registered version of its integration.
 *
 * The missing half of a deliberate freeze. A connection resolves the
 * manifest frozen on its catalog row at install, and nothing ever updated
 * that row, so an integration's declared surface reached its code and never
 * reached anybody who had already installed it. The freeze itself is worth
 * keeping: a connection should not have its surface changed underneath it
 * by an unrelated catalog edit. What was missing was a deliberate act that
 * moves one forward.
 *
 * That it bit rather than merely being untidy: a runtime credential's
 * `type_permissions` is projected from the RESOLVED manifest's
 * `target_types`, and the reserved-root gate admits a `marfa.*` write only
 * when the map carries that exact literal. When a type rename shipped, the
 * inbox integration was refused when writing its own type, on production,
 * with no error a person sees and no activity row.
 *
 * **Three properties this must hold.**
 *
 * 1. **Consent gates widening.** A newer manifest can declare more than the
 *    person approved. The upgrade computes a real permission diff and
 *    refuses anything wider, naming what is new, until a space admin
 *    approves it through the install consent surface. Equal or narrower
 *    proceeds: taking less needs no ceremony.
 *
 * 2. **Both frozen copies move.** `integration_ref` is the one everybody
 *    thinks of, but install also stamps `direction` and `triggers` onto the
 *    connection row itself, and the console reads that copy. Moving one and
 *    not the other produces a connection that disagrees with itself.
 *
 * 3. **Cursors survive.** They live in the `connection.runtime` extension
 *    namespace, not in the properties this rewrites, so an upgrade keeps
 *    them by construction. That is the whole reason this exists rather than
 *    telling people to uninstall and reinstall: reinstall creates a new
 *    connection id with empty cursor state and re-pulls the upstream corpus.
 */
import {
  applyConfigurationDefaults,
  validateConnectionConfiguration,
} from "@withmarfa/shared";
import type { IntegrationManifest, Item } from "@withmarfa/shared";
import { ConnectionMappingSchema } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { withConnectionLifecycleLock } from "./lifecycle-lock.js";
import { resolveConnectionManifest } from "./resolve-manifest.js";
import { diffManifestGrants, describeGrantDelta } from "./manifest-diff.js";
import type { ManifestGrantDelta } from "./manifest-diff.js";

export interface UpgradeInput {
  /** The api_keys row id of the caller, for the audit trail. Absent when
   *  the scheduled pass in `auto-upgrade.ts` is the caller: a non-widening
   *  move applies on its own, so there is no principal to name and the
   *  audit store already documents `key_id` as unset for a
   *  system-initiated row. */
  apiKeyId?: string;
  spaceId?: string;
  connectionId: string;
  clientIp?: string | null;
  /** Set only by the consent surface, once a space admin has approved a
   *  widening delta. Never settable from the JSON route: the whole point is
   *  that a caller cannot wave its own consent through. */
  consentedToWidening?: boolean;
  /** Pin the target row. Omitted, the newest registered version wins. */
  targetIntegrationItemId?: string;
}

export interface UpgradeResult {
  connection_id: string;
  from: { manifest_name: string; manifest_version: string };
  to: { manifest_name: string; manifest_version: string };
  integration_ref: string;
  revoked_credential_ids: string[];
  activity_id: string;
}

export class UpgradeError extends Error {
  constructor(
    public readonly code:
      | "connection_not_found"
      | "wrong_connection_kind"
      | "revoked"
      | "already_current"
      | "no_newer_version"
      | "configuration_invalid"
      | "consent_required"
      | "mapping_would_be_stranded",
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "UpgradeError";
  }
}

interface CatalogProperties {
  manifest_name?: string;
  manifest_version?: string;
  manifest?: unknown;
  registered_at?: string;
}

/**
 * Compare two semver strings numerically, falling back to a string compare
 * for anything non-numeric. Registration validates `version` as semver, so
 * the fallback is a guard rather than a path.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    if (x !== y) return x - y;
  }
  return 0;
}

/** Every registered row for one integration name, newest version first. */
export async function listCatalogVersions(
  storage: Storage,
  manifestName: string,
  spaceId: string | undefined,
): Promise<Item[]> {
  const rows = await storage.items.list({
    spaceId,
    includePlatformScoped: true,
    type: "system.integration",
    filter: `properties.manifest_name eq "${manifestName}"`,
    limit: 200,
  });
  return [...rows.data].sort((a, b) =>
    compareVersions(
      (b.properties as CatalogProperties).manifest_version ?? "0.0.0",
      (a.properties as CatalogProperties).manifest_version ?? "0.0.0",
    ),
  );
}

export interface UpgradePreview {
  connection_id: string;
  current: { manifest_name: string; manifest_version: string };
  candidate: { manifest_name: string; manifest_version: string } | null;
  candidate_integration_ref: string | null;
  delta: ManifestGrantDelta | null;
  /** What a person needs to be told before this may proceed. Empty when
   *  the move takes no more than the connection already had. */
  consent_lines: string[];
}

/**
 * What an upgrade would do, without doing it.
 *
 * Serves both the drift surface and the route's own refusal body, so the
 * thing a person is shown before choosing and the thing they are told when
 * refused are computed once rather than twice.
 */
export async function previewUpgrade(
  storage: Storage,
  input: Pick<
    UpgradeInput,
    "spaceId" | "connectionId" | "targetIntegrationItemId"
  >,
): Promise<UpgradePreview> {
  const connection = await storage.items.get(input.connectionId, input.spaceId);
  if (connection?.type !== "system.connection") {
    throw new UpgradeError(
      "connection_not_found",
      `Connection ${input.connectionId} not found`,
    );
  }
  const resolved = await resolveConnectionManifest(
    storage,
    input.connectionId,
    input.spaceId,
  );
  const current = resolved.manifest;

  const candidateRow = await pickCandidateRow(
    storage,
    input,
    resolved,
    current,
  );
  if (!candidateRow) {
    return {
      connection_id: input.connectionId,
      current: {
        manifest_name: current.name,
        manifest_version: current.version,
      },
      candidate: null,
      candidate_integration_ref: null,
      delta: null,
      consent_lines: [],
    };
  }
  const candidate = (candidateRow.properties as CatalogProperties)
    .manifest as IntegrationManifest;
  const delta = diffManifestGrants(current, candidate, connection.properties);
  return {
    connection_id: input.connectionId,
    current: { manifest_name: current.name, manifest_version: current.version },
    candidate: {
      manifest_name: candidate.name,
      manifest_version: candidate.version,
    },
    candidate_integration_ref: candidateRow.id,
    delta,
    consent_lines: delta.widens ? describeGrantDelta(delta) : [],
  };
}

async function pickCandidateRow(
  storage: Storage,
  input: Pick<
    UpgradeInput,
    "spaceId" | "connectionId" | "targetIntegrationItemId"
  >,
  resolved: { integration_item_id: string },
  current: IntegrationManifest,
): Promise<Item | undefined> {
  if (input.targetIntegrationItemId !== undefined) {
    const row = await storage.items.get(
      input.targetIntegrationItemId,
      input.spaceId,
      { includePlatformScoped: true },
    );
    if (row?.type !== "system.integration") return undefined;
    const props = row.properties as CatalogProperties;
    // Pinning is for choosing among an integration's own versions, never
    // for re-pointing a connection at a different integration.
    if (props.manifest_name !== current.name) return undefined;
    // And never for moving one backwards. The unpinned branch below has
    // always refused a candidate that is not newer; the pinned one refused
    // only a different integration and the row already resolved, which was
    // harmless while nothing set the pin and is not now. A connection
    // upgraded by something else between a caller reading a version and
    // this running would otherwise be walked back to the older one, with
    // the narrowing that implies passing the consent gate unremarked.
    if (
      compareVersions(props.manifest_version ?? "0.0.0", current.version) <= 0
    )
      return undefined;
    // Unreachable through the registrar, which stamps `manifest_version`
    // from the manifest, so the resolved row always compares equal above.
    // It stays for a catalog row written by something else, where the two
    // could disagree.
    return row.id === resolved.integration_item_id ? undefined : row;
  }
  const rows = await listCatalogVersions(storage, current.name, input.spaceId);
  const newest = rows[0];
  if (!newest) return undefined;
  const newestVersion =
    (newest.properties as CatalogProperties).manifest_version ?? "0.0.0";
  if (compareVersions(newestVersion, current.version) <= 0) return undefined;
  return newest;
}

export function performUpgrade(
  storage: Storage,
  input: UpgradeInput,
): Promise<UpgradeResult> {
  return withConnectionLifecycleLock(storage, input.connectionId, () =>
    applyUpgrade(storage, input),
  );
}

/**
 * Would moving this connection leave a stored mapping it can no longer
 * edit? Only when a mapping is actually stored: an integration dropping a
 * capability it never had exercised takes nothing from anybody.
 *
 * Lives here because `applyUpgrade` is the one place every route and the
 * background pass all pass through. It used to live beside the survey, so
 * the pass refused the move and both routes applied it.
 */
export function wouldStrandMapping(
  connection: Item,
  candidateManifest: IntegrationManifest | undefined,
): boolean {
  if (candidateManifest === undefined) return false;
  if (candidateManifest.supports_user_mappings === true) return false;
  return ConnectionMappingSchema.safeParse(
    (connection.properties as { mapping?: unknown }).mapping,
  ).success;
}

/** The manifest on a catalog row, or nothing if the row is not one. */
export async function manifestOfCatalogRow(
  storage: Storage,
  integrationItemId: string | null,
  spaceId: string | undefined,
): Promise<IntegrationManifest | undefined> {
  if (integrationItemId === null) return undefined;
  const row = await storage.items.get(integrationItemId, spaceId, {
    includePlatformScoped: true,
  });
  if (row?.type !== "system.integration") return undefined;
  return (row.properties as { manifest?: IntegrationManifest }).manifest;
}

async function applyUpgrade(
  storage: Storage,
  input: UpgradeInput,
): Promise<UpgradeResult> {
  const connection = await storage.items.get(input.connectionId, input.spaceId);
  if (connection?.type !== "system.connection") {
    throw new UpgradeError(
      "connection_not_found",
      `Connection ${input.connectionId} not found`,
    );
  }
  const kind = connection.properties.kind as string | undefined;
  if (kind !== "integration") {
    throw new UpgradeError(
      "wrong_connection_kind",
      `Connection ${input.connectionId} has kind "${kind ?? "<missing>"}"; upgrade accepts only "integration"`,
    );
  }
  if (connection.state === "revoked") {
    throw new UpgradeError(
      "revoked",
      `Connection ${input.connectionId} is revoked; upgrade applies to live connections`,
    );
  }

  const preview = await previewUpgrade(storage, input);
  if (!preview.candidate || !preview.candidate_integration_ref) {
    throw new UpgradeError(
      input.targetIntegrationItemId === undefined
        ? "already_current"
        : "no_newer_version",
      input.targetIntegrationItemId === undefined
        ? `Connection ${input.connectionId} already resolves the newest registered version of ${preview.current.manifest_name} (${preview.current.manifest_version})`
        : `The requested catalog entry is not a newer version of ${preview.current.manifest_name}`,
    );
  }

  // A manifest that stops declaring mapping support strands a mapping the
  // space already set: the rules keep being applied and nothing can edit
  // them again. This lives here rather than at a caller because both doors
  // pass through it, and it used to live at only one of them. The
  // background pass refused such a move while the manual route applied it,
  // and dropping mapping support does not register as widening, so the
  // consent gate below never saw it either.
  //
  // Not a consent question. A grant is something a person can agree to;
  // this is a capability going away, and agreeing to it would not bring
  // the mapping back. Clear the mapping first, or stay where you are.
  const candidateManifest = await manifestOfCatalogRow(
    storage,
    preview.candidate_integration_ref,
    input.spaceId,
  );
  if (wouldStrandMapping(connection, candidateManifest)) {
    throw new UpgradeError(
      "mapping_would_be_stranded",
      `Moving ${preview.current.manifest_name} to ${preview.candidate.manifest_version} would leave this connection's stored user mapping in place with no way to edit it, because that version does not support mappings. Clear the mapping first.`,
      {
        current_version: preview.current.manifest_version,
        candidate_version: preview.candidate.manifest_version,
      },
    );
  }

  // The gate. A widening move needs a person, and a caller cannot approve
  // its own: `consentedToWidening` is set by the consent surface after a
  // space admin has seen exactly these lines, and by nothing else.
  const delta = preview.delta;
  if (delta?.widens && input.consentedToWidening !== true) {
    throw new UpgradeError(
      "consent_required",
      `Moving ${preview.current.manifest_name} to ${preview.candidate.manifest_version} would grant more than this connection was installed with. A space admin has to approve it.`,
      {
        current_version: preview.current.manifest_version,
        candidate_version: preview.candidate.manifest_version,
        grants: preview.consent_lines,
        delta,
      },
    );
  }

  const candidateRow = await storage.items.get(
    preview.candidate_integration_ref,
    input.spaceId,
    { includePlatformScoped: true },
  );
  const candidate = (candidateRow?.properties as CatalogProperties)
    .manifest as IntegrationManifest;

  // Re-validate the stored configuration against the new contract before
  // anything is written. A configuration that no longer satisfies the
  // manifest must refuse the whole upgrade rather than leave the connection
  // bound to a manifest its own settings do not satisfy.
  const existingConfiguration = (connection.properties.configuration ??
    {}) as Record<string, unknown>;
  const nextConfiguration = applyConfigurationDefaults(
    candidate,
    existingConfiguration,
  );
  // `requireRequired` on purpose, matching install: after the move the
  // connection has to satisfy the new contract completely, and a required
  // key left unfilled would surface as a handler failure on the next
  // dispatch instead of as a refusal here.
  const configurationIssues = validateConnectionConfiguration(
    candidate,
    nextConfiguration,
    { requireRequired: true },
  );
  if (configurationIssues.length > 0) {
    throw new UpgradeError(
      "configuration_invalid",
      `This connection's settings do not satisfy ${candidate.name}@${candidate.version}`,
      { errors: configurationIssues },
    );
  }

  const from = {
    manifest_name: preview.current.manifest_name,
    manifest_version: preview.current.manifest_version,
  };
  const to = {
    manifest_name: candidate.name,
    manifest_version: candidate.version,
  };

  await storage.items.update(
    input.connectionId,
    {
      properties: {
        ...connection.properties,
        integration_ref: preview.candidate_integration_ref,
        configuration: nextConfiguration,
        // The second frozen copy. Install stamps these onto the connection
        // and the console reads them, so leaving them behind would produce
        // a connection whose own row disagrees with the manifest it now
        // resolves.
        direction: candidate.direction,
        triggers: candidate.triggers,
      },
    },
    input.spaceId,
  );

  // Existing runtime credentials still carry permissions projected from the
  // old manifest and outlive this call by their TTL. Revoking them makes
  // the next dispatch mint against the manifest the connection now
  // resolves, which is the half of the acceptance that says the projection
  // follows the move.
  const credentials = await storage.keys.listByConnectionId(
    input.connectionId,
    input.spaceId,
  );
  // Affected rows, not attempts. A credential the supersede path retired
  // between the list and the revoke is not one this upgrade retired, and
  // the count rides onto the activity row an operator reads.
  const revokedCredentialIds: string[] = [];
  for (const cred of credentials) {
    if (await storage.keys.revoke(cred.id)) revokedCredentialIds.push(cred.id);
  }

  const activity = await storage.items.create(
    {
      type: "system.activity",
      properties: {
        connection_id: input.connectionId,
        severity: "info" as const,
        summary: `Updated ${to.manifest_name} from ${from.manifest_version} to ${to.manifest_version}`,
        detail: {
          from_version: from.manifest_version,
          to_version: to.manifest_version,
          integration_ref: preview.candidate_integration_ref,
          credentials_revoked: revokedCredentialIds.length,
          consented_to_widening: input.consentedToWidening === true,
        },
      },
    },
    input.spaceId,
  );

  await storage.audit.log({
    client_ip: input.clientIp ?? null,
    space_id: input.spaceId ?? null,
    key_id: input.apiKeyId,
    action: "integration.upgrade",
    resource_type: "item",
    resource_id: input.connectionId,
    details: {
      from_version: from.manifest_version,
      to_version: to.manifest_version,
      integration_ref: preview.candidate_integration_ref,
      widened: delta?.widens === true,
    },
  });

  return {
    connection_id: input.connectionId,
    from,
    to,
    integration_ref: preview.candidate_integration_ref,
    revoked_credential_ids: revokedCredentialIds,
    activity_id: activity.id,
  };
}
