/**
 * What moving a connection to a newer manifest would newly grant.
 *
 * A connection is installed against a manifest and a person approved that
 * manifest's declared surface at install. A newer version of the same
 * integration can declare more: extra target types, wider extension or edge
 * permissions, a credential requirement that was not there before, a
 * configuration field that is suddenly mandatory. Re-binding the connection
 * on the strength of an API call alone would widen a grant nobody
 * re-approved, and it would do it the way every other defect in this area
 * does it: quietly, with a healthy status and nothing reported.
 *
 * So the upgrade asks this module first. Equal or narrower goes through
 * without ceremony, because a narrowing reprojection is strictly safer than
 * what the connection has today. Anything wider stops and goes to the
 * person, through the same consent surface they used to install it.
 *
 * **It is a permission diff, not a version comparison.** Version numbers
 * say nothing reliable about reach: a patch bump can add a target type and
 * a major bump can remove one. The projection builders in
 * `manifest-permissions.ts` are the single source of truth for what a
 * manifest grants a runtime credential, so the diff is computed from those
 * rather than from a second reading of the manifest.
 */
import type { IntegrationManifest } from "@withmarfa/shared";
import {
  buildEdgePermissions,
  buildExtensionPermissions,
  buildTypePermissions,
} from "./manifest-permissions.js";

export interface GrantAddition {
  /** The map key that is new, or whose level rose. */
  name: string;
  /** Absent when the key is new; set when an existing key escalated. */
  from?: "read" | "write";
  to: "read" | "write";
}

export interface ManifestGrantDelta {
  /** True when the candidate reaches anything the consented manifest did
   *  not. The single question the upgrade route asks. */
  widens: boolean;
  types: GrantAddition[];
  extensions: GrantAddition[];
  edges: GrantAddition[];
  /** Capability keys newly required, or whose mode changed. */
  oauth: { name: string; from?: string; to: string }[];
  tokens: { name: string; to: string }[];
  /** Configuration fields that are required now and were not before. */
  configurationRequired: string[];
}

function diffPermissionMap(
  before: Record<string, "read" | "write">,
  after: Record<string, "read" | "write">,
): GrantAddition[] {
  const out: GrantAddition[] = [];
  for (const [name, to] of Object.entries(after)) {
    const from = before[name];
    if (from === undefined) {
      out.push({ name, to });
      continue;
    }
    // `write` is the only level above `read`, so an escalation is exactly
    // this one transition. A drop from write to read is a narrowing and is
    // deliberately not reported: nothing needs re-approving to take less.
    if (from === "read" && to === "write") out.push({ name, from, to });
  }
  return out;
}

/**
 * Compare what two manifests grant.
 *
 * `connectionProperties` is passed to both sides so the connection's own
 * user mapping, which contributes target types of its own, cancels out.
 * The user chose that mapping and consented to it separately; it is not
 * something the new manifest is asking for.
 */
export function diffManifestGrants(
  consented: IntegrationManifest,
  candidate: IntegrationManifest,
  connectionProperties?: Record<string, unknown>,
): ManifestGrantDelta {
  const types = diffPermissionMap(
    buildTypePermissions(consented, connectionProperties),
    buildTypePermissions(candidate, connectionProperties),
  );
  const extensions = diffPermissionMap(
    buildExtensionPermissions(consented),
    buildExtensionPermissions(candidate),
  );
  const edges = diffPermissionMap(
    buildEdgePermissions(consented),
    buildEdgePermissions(candidate),
  );

  // Credential requirements are treated conservatively: a new capability
  // key, or an existing one whose mode changed, both count as widening.
  // The cost of being wrong here is one consent screen; the cost of the
  // other error is an integration holding a credential shape nobody
  // approved. A key that disappears is a narrowing and is not reported.
  const oauth: ManifestGrantDelta["oauth"] = [];
  for (const [name, to] of Object.entries(candidate.oauth_requirements ?? {})) {
    const from = consented.oauth_requirements?.[name];
    if (from === undefined) oauth.push({ name, to });
    else if (from !== to) oauth.push({ name, from, to });
  }

  const tokens: ManifestGrantDelta["tokens"] = [];
  for (const [name, to] of Object.entries(candidate.token_requirements ?? {})) {
    if (consented.token_requirements?.[name] === undefined) {
      tokens.push({ name, to });
    }
  }

  // A field that becomes mandatory is something new being demanded of the
  // person, so it is surfaced even where a declared default would satisfy
  // validation on its own. Consent here is about being told, not about
  // whether the upgrade would technically succeed.
  const beforeFields = consented.configuration_schema ?? {};
  const afterFields = candidate.configuration_schema ?? {};
  const configurationRequired: string[] = [];
  for (const [name, spec] of Object.entries(afterFields)) {
    if (spec.required !== true) continue;
    if (beforeFields[name]?.required !== true) configurationRequired.push(name);
  }

  return {
    widens:
      types.length > 0 ||
      extensions.length > 0 ||
      edges.length > 0 ||
      oauth.length > 0 ||
      tokens.length > 0 ||
      configurationRequired.length > 0,
    types,
    extensions,
    edges,
    oauth,
    tokens,
    configurationRequired,
  };
}

/** Plain sentences naming exactly what is new, for the refusal body and the
 *  consent screen. Neither should make somebody diff two manifests by eye. */
export function describeGrantDelta(delta: ManifestGrantDelta): string[] {
  const lines: string[] = [];
  for (const t of delta.types) {
    lines.push(
      t.from
        ? `Writes to ${t.name} instead of only reading them`
        : `Writes a new kind of item: ${t.name}`,
    );
  }
  for (const e of delta.extensions) {
    lines.push(
      e.from
        ? `Writes to the ${e.name} extension instead of only reading it`
        : `Reaches a new extension: ${e.name}`,
    );
  }
  for (const e of delta.edges) {
    lines.push(
      e.from
        ? `Creates ${e.name} links instead of only reading them`
        : `Creates a new kind of link: ${e.name}`,
    );
  }
  for (const o of delta.oauth) {
    lines.push(
      o.from
        ? `Changes how it connects to ${o.name}: ${o.from} becomes ${o.to}`
        : `Needs access to a new service: ${o.name}`,
    );
  }
  for (const t of delta.tokens) {
    lines.push(`Needs an API token for ${t.name}`);
  }
  for (const f of delta.configurationRequired) {
    lines.push(`Needs a setting you have not provided yet: ${f}`);
  }
  return lines;
}
