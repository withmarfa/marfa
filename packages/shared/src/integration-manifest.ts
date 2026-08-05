import { z } from "zod";
import { isValidTypeIdentifier } from "./validation.js";

/**
 * Integration manifest — Zod schema is the canonical definition.
 *
 * The committed JSON Schema artifact at
 * `packages/types/integration-manifest-schema.json` is generated from this
 * file by `packages/shared/scripts/generate-manifest-schema.ts` and exists
 * for documentation and external-consumer use only — it is NOT the source
 * of truth. A drift test in `integration-manifest.test.ts` regenerates the
 * JSON Schema in-memory and asserts byte-equality with the committed file
 * so the artifact never silently desynchronizes from the Zod schema.
 *
 * `manifest_schema_version` evolution policy.
 *
 * Initial value: `1.0.0`. The semver applies to the manifest contract
 * itself, not to a published Integration. Bump rules:
 *   - **major** — breaking change to the contract: a removed field, a
 *     renamed field, an enum value retired, a default semantically
 *     altered. Server rejects manifests whose major doesn't match a
 *     supported range.
 *   - **minor** — additive optional field, additional enum value, or
 *     newly-recognized verification-method shape. Older servers ignore
 *     unknown additive fields; newer ones consume them.
 *   - **patch** — clarification, doc-only change, more permissive
 *     validator on an already-defined field. Forward- and
 *     backward-compatible by definition.
 *
 * Server validator currently accepts any 1.x.x and rejects 2.x.x with a
 * clear "manifest schema version not supported" error. Bump the
 * server-side range when the contract crosses a major.
 *
 * Triggers — design intent.
 *
 *   - **schedule**   — runs on a cron expression. Manifest declares the
 *                      cron string; the runtime enforces.
 *   - **webhook**    — external service POSTs to a per-Connection inbound
 *                      URL when a relevant event occurs upstream. The
 *                      manifest declares this trigger; the inbound webhook
 *                      subscription consumes the manifest's verification
 *                      declaration.
 *   - **item-event** — a Marfa item changes. The integration subscribes via
 *                      the item-event bus; cycle-detection metadata
 *                      protects against A→B→A loops.
 *   - **manual**     — the Integration declares it accepts user-initiated
 *                      runs. The runtime surfaces this as a UI affordance
 *                      ("Run now"). A manifest opting out of this trigger
 *                      means the UI does not offer manual invocation.
 *
 * Bidirectional handling — declared per-Integration in the manifest, not
 * per-space or platform-wide. Defaults match the design's stated defaults.
 */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const SemverSchema = z.string().regex(SEMVER_RE, {
  message: "must be a semver string of the form MAJOR.MINOR.PATCH",
});

/**
 * Manifest `name` must follow the publisher-namespaced type-identifier
 * grammar (e.g. `acme.calendar-sync`). This keeps the marketplace dedupe
 * key stable, matches Marfa's identifier conventions, and lets the server
 * reuse `isValidTypeIdentifier` for the format check.
 */
const ManifestNameSchema = z.string().refine((s) => isValidTypeIdentifier(s), {
  message:
    "manifest name must follow publisher-namespaced grammar (e.g. acme.calendar-sync)",
});

const RuntimeCompatibilityValue = z.enum(["hosted", "self-hosted", "local"]);

const TriggerScheduleSchema = z.object({
  type: z.literal("schedule"),
  config: z.object({
    cron: z.string().min(1, "schedule trigger requires a cron expression"),
  }),
});

const TriggerWebhookSchema = z.object({
  type: z.literal("webhook"),
});

const TriggerItemEventSchema = z.object({
  type: z.literal("item-event"),
});

const TriggerManualSchema = z.object({
  type: z.literal("manual"),
});

const TriggerSchema = z.discriminatedUnion("type", [
  TriggerScheduleSchema,
  TriggerWebhookSchema,
  TriggerItemEventSchema,
  TriggerManualSchema,
]);

const PermissionLevel = z.enum(["read", "write"]);

const PermissionsSchema = z.object({
  extension: z.record(z.string().min(1), PermissionLevel).optional(),
  edge: z.record(z.string().min(1), PermissionLevel).optional(),
});

const TombstoneMappingSchema = z.enum([
  "state-trashed",
  "prompt-user",
  "ignore",
]);

const PartialWriteModeSchema = z.enum(["all-or-nothing", "accept-partial"]);

const BidirectionalHandlingSchema = z.object({
  /**
   * Echo-suppression TTL (seconds). The integration's `pending_writes` set
   * is keyed by `(external_id, content_hash)` and entries expire after
   * this window. Default 60 per Design Direction line 100; per-Integration
   * override allowed.
   */
  echo_ttl_seconds: z.number().int().positive().default(60),
  /**
   * External-truth-lag window (seconds). Reactive code that reads items
   * recently written by the same Connection waits at least this long
   * before trusting the read. Default 60.
   */
  lag_window_seconds: z.number().int().positive().default(60),
  /**
   * Tombstone mapping — what happens when the external service deletes
   * something Marfa has locally.
   *   - `state-trashed` (default for read-only Connections): set
   *     `state: trashed` on the item.
   *   - `prompt-user`   (default for read-write Connections): emit a
   *     `system.activity` with `severity: action_required` for the user
   *     to resolve.
   *   - `ignore`        : do not propagate the delete.
   */
  tombstone_mapping: TombstoneMappingSchema,
  /**
   * Partial-write mode — what the integration does when an external write
   * partially succeeds.
   *   - `all-or-nothing` (default): roll back the local optimistic write
   *     and surface an error.
   *   - `accept-partial`: persist the partial outcome (Notion-style
   *     per-property errors).
   */
  partial_write_mode: PartialWriteModeSchema,
});

const OAuthRequirementValue = z.enum(["proxy", "leased"]);

/**
 * Token-credential requirements — manifest 1.1.0 additive field.
 *
 * For integrations whose upstream uses a static API token rather than
 * an OAuth flow. The map key names the capability (typically the
 * integration's name, e.g. `todoist`); the value is always `"required"`
 * today. The install pipeline accepts a `credential_ref` pointing at a
 * `system.credential` of `kind: api_token` whose `api_token_config`
 * carries the upstream base URL; the connection proxy reads the bearer
 * at request time and stamps `Authorization: Bearer …` directly, with
 * no refresh primitive.
 *
 * Optional and additive: existing manifests at 1.0.0 keep validating
 * without declaring this field. Integrations that declare it bump
 * `manifest_schema_version` to `1.1.0`.
 */
const TokenRequirementValue = z.literal("required");

const WebhookVerificationSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("hmac-sha256") }),
  z.object({ method: z.literal("slack") }),
  z.object({ method: z.literal("stripe") }),
  z.object({ method: z.literal("github") }),
  // `google-channel` covers Google Workspace push notifications
  // (Calendar / Drive / Gmail) — body-less; verification by X-Goog-
  // Channel-Token header against the per-channel stored secret.
  z.object({ method: z.literal("google-channel") }),
  // `cloudflare-email` covers Cloudflare Email Routing → Email Worker
  // → signed JSON envelope. Verification is HMAC-SHA256 over the body
  // (same on-wire shape as `hmac-sha256`); the distinct method declares
  // the body schema (parsed-email envelope) the integration handler expects.
  z.object({ method: z.literal("cloudflare-email") }),
]);

/**
 * Connection configuration contract — manifest 1.2.0 additive field.
 *
 * Declares every configuration key the integration reads from the
 * Connection's `properties.configuration`, so the install pipeline can
 * refuse a key no handler will honor and a configuration surface can
 * render a form for any integration without knowing it specifically. An
 * undeclared key an integration quietly reads is the defect this field
 * ends: only its author could know the key existed.
 */
const ConfigurationFieldSchema = z
  .object({
    type: z.enum(["string", "number", "boolean", "string_array"]),
    description: z
      .string()
      .min(1, "configuration fields describe themselves to the surface"),
    required: z.boolean().optional(),
    /** Closed value set for string fields. */
    values: z.array(z.string()).min(1).optional(),
    /**
     * Derive the closed value set from the manifest's own target_types,
     * so a type-picking key cannot drift from what the credential may
     * actually write.
     */
    from_target_types: z.boolean().optional(),
    default: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
      .optional(),
  })
  .strict();

export type ConfigurationFieldSpec = z.infer<typeof ConfigurationFieldSchema>;

/**
 * Configuration keys the platform itself owns on every Connection,
 * whatever the manifest declares. Validation admits them alongside the
 * declared set.
 */
export const RESERVED_CONFIGURATION_KEYS: ReadonlySet<string> = new Set([
  "upstream_base_url_override",
]);

export const IntegrationManifestSchema = z
  .object({
    name: ManifestNameSchema,
    version: SemverSchema,
    publisher: z.string().min(1, "publisher is required"),
    description: z.string().min(1, "description is required"),
    direction: z.enum(["read", "write", "both"]),
    triggers: z.array(TriggerSchema).min(1, "at least one trigger is required"),
    target_types: z
      .array(
        z.string().refine((s) => isValidTypeIdentifier(s), {
          message: "target_types entries must be valid type identifiers",
        }),
      )
      .min(1, "at least one target_type is required"),
    runtime_compatibility: z
      .array(RuntimeCompatibilityValue)
      .min(1, "at least one runtime_compatibility entry is required"),
    bidirectional_handling: BidirectionalHandlingSchema,
    oauth_requirements: z.record(z.string().min(1), OAuthRequirementValue),
    /**
     * Static-API-token requirements — manifest 1.1.0 additive field.
     * Optional; present on integrations whose upstream uses a bearer
     * token rather than OAuth. See `TokenRequirementValue` above.
     */
    token_requirements: z
      .record(z.string().min(1), TokenRequirementValue)
      .optional(),
    webhook_verification: WebhookVerificationSchema,
    manifest_schema_version: SemverSchema,
    permissions: PermissionsSchema.optional(),
    /**
     * Connection configuration contract — manifest 1.2.0 additive field.
     * Optional; an integration that accepts no configuration omits it,
     * and supplying any configuration to such an integration is refused.
     */
    configuration_schema: z
      .record(z.string().min(1), ConfigurationFieldSchema)
      .optional(),
  })
  .strict();

export type IntegrationManifest = z.infer<typeof IntegrationManifestSchema>;

export interface ConfigurationIssue {
  key: string;
  message: string;
}

/**
 * Judge a Connection configuration payload against the manifest's declared
 * contract. One enforcement point for every surface that writes
 * `properties.configuration` — install, the configuration surface, and any
 * future update path — so the rules cannot drift between them.
 *
 * `requireRequired` distinguishes the install case (the whole configuration
 * is being established, so a missing required key is a refusal) from a
 * partial update (only the supplied keys are judged).
 */
export function validateConnectionConfiguration(
  manifest: Pick<IntegrationManifest, "configuration_schema" | "target_types">,
  configuration: Record<string, unknown>,
  options?: { requireRequired?: boolean },
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const declared = manifest.configuration_schema ?? {};

  for (const [key, value] of Object.entries(configuration)) {
    if (RESERVED_CONFIGURATION_KEYS.has(key)) continue;
    const spec = declared[key];
    if (!spec) {
      issues.push({
        key,
        message: `"${key}" is not a configuration key this integration declares`,
      });
      continue;
    }
    const typeOk =
      spec.type === "string"
        ? typeof value === "string"
        : spec.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : spec.type === "boolean"
            ? typeof value === "boolean"
            : Array.isArray(value) && value.every((v) => typeof v === "string");
    if (!typeOk) {
      issues.push({
        key,
        message: `"${key}" must be a ${spec.type.replace("_", " ")}`,
      });
      continue;
    }
    const allowed = spec.from_target_types
      ? manifest.target_types
      : spec.values;
    if (allowed && typeof value === "string" && !allowed.includes(value)) {
      issues.push({
        key,
        message: `"${key}" must be one of: ${allowed.join(", ")}`,
      });
    }
  }

  if (options?.requireRequired) {
    for (const [key, spec] of Object.entries(declared)) {
      if (
        spec.required === true &&
        spec.default === undefined &&
        configuration[key] === undefined
      ) {
        issues.push({ key, message: `"${key}" is required` });
      }
    }
  }

  return issues;
}

/**
 * Highest manifest_schema_version major this library accepts. Used by the
 * server's validate-manifest helper. Bump when the contract crosses a
 * breaking-change boundary.
 */
export const MANIFEST_SCHEMA_VERSION_SUPPORTED_MAJOR = 1;

/** Parses `manifest_schema_version` and returns its major component. */
export function parseManifestSchemaMajor(version: string): number | null {
  const match = SEMVER_RE.exec(version);
  if (!match) return null;
  return Number.parseInt(match[1] ?? "0", 10);
}
