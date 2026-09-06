import { z } from "zod";
import {
  isValidIntegrationIdentifier,
  isValidHandleGrammar,
  isValidTypeIdentifier,
} from "./validation.js";

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
 * The semver applies to the manifest contract itself, not to a published
 * Integration. It started at `1.0.0`; the contract has since crossed a
 * major and 1.x is no longer accepted. Bump rules:
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
 *   - **correction** — a validator that begins refusing what it previously
 *     accepted and silently discarded. Neither major nor minor, and the
 *     bullets above do not name it because the contract never meant to
 *     accept the input in the first place: a plain Zod object strips an
 *     unknown key, so the schema's own output type said the key could not
 *     be there while its input admitted it. Refusing it states what was
 *     always true rather than changing what is true.
 *
 *     **Conditional on measurement, not on the argument.** It is a
 *     correction only where no shipped and no stored manifest is refused,
 *     and the measurement is recorded with its date, the builds it ran
 *     against and the route it read. Without that it is a major, because a
 *     manifest somebody wrote against the permissive reading is refused on
 *     the next resolution and a mint fails closed. The instance is the
 *     2.2.0 strictness pass; the record is in the vault artifact this
 *     policy's ticket names.
 *
 * The majors the server accepts are declared by
 * `MANIFEST_SCHEMA_VERSION_ACCEPTED_MAJORS` below, and anything outside
 * them is refused with a "manifest schema version not supported" error
 * naming the range. Widen or move that constant when the contract
 * crosses a major; it is the single place the range is stated, so prose
 * restating the number here would be a second copy to forget.
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
 *
 * What a manifest has to declare, and what it may leave out.
 *
 * An integration is whatever ships a manifest and installs as a
 * connection, whatever its upstream: a vendor, a protocol, this
 * platform's own infrastructure, or nothing at all. So the fields that
 * only some of them have anything to say about are optional, and
 * `validateManifestCoherence` judges agreement rather than presence — a
 * webhook trigger needs a verification method, a `both` direction needs
 * bidirectional handling, a server-run integration needs a trigger and a
 * client-run one has none. `validateManifestAuthoring` adds the converse
 * rules at the doors a manifest is written behind; they are deliberately
 * not applied to stored rows, and the reason is written at that function.
 */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const SemverSchema = z.string().regex(SEMVER_RE, {
  message: "must be a semver string of the form MAJOR.MINOR.PATCH",
});

/**
 * Manifest `name` follows the integration-identifier grammar,
 * `<namespace>/<name>` (e.g. `acme/calendar-sync`): dots name data, the
 * slash names an installable. The namespace is the data the integration
 * owns rather than whoever wrote it, which `publisher` records separately.
 * The dedupe key stays the name, so this is what the catalog is keyed on.
 *
 * This is deliberately no longer `isValidTypeIdentifier`. The two grammars
 * were the same function while an integration was spelled like a type, and
 * loosening the type validator to admit a slash would have reached every
 * scope literal and permission-map key in the system.
 *
 * The slash is required. A dot-form name parsed alongside it for the length
 * of the migration, because installed connections resolve the manifest frozen
 * on their catalog row and those rows moved in their own step; they have, so
 * it does not.
 */
const ManifestNameSchema = z
  .string()
  .refine((s) => isValidIntegrationIdentifier(s), {
    message:
      "manifest name must follow namespace-slash-name grammar (e.g. acme/calendar-sync)",
  });

const TriggerScheduleSchema = z
  .object({
    type: z.literal("schedule"),
    config: z
      .object({
        cron: z.string().min(1, "schedule trigger requires a cron expression"),
      })
      .strict(),
  })
  .strict();

const TriggerWebhookSchema = z.object({ type: z.literal("webhook") }).strict();

const TriggerItemEventSchema = z
  .object({ type: z.literal("item-event") })
  .strict();

const TriggerManualSchema = z.object({ type: z.literal("manual") }).strict();

const TriggerSchema = z.discriminatedUnion("type", [
  TriggerScheduleSchema,
  TriggerWebhookSchema,
  TriggerItemEventSchema,
  TriggerManualSchema,
]);

const PermissionLevel = z.enum(["read", "write"]);

const PermissionsSchema = z
  .object({
    extension: z.record(z.string().min(1), PermissionLevel).optional(),
    edge: z.record(z.string().min(1), PermissionLevel).optional(),
  })
  .strict();

const TombstoneMappingSchema = z.enum([
  "state-trashed",
  "prompt-user",
  "ignore",
]);

const PartialWriteModeSchema = z.enum(["all-or-nothing", "accept-partial"]);

/**
 * The echo-suppression window a connection runs under when its manifest
 * declares no `bidirectional_handling` at all — a one-directional
 * integration, which has no honest value for `partial_write_mode` and so
 * declares none of the block.
 *
 * Named once and spent in three places: the two schema defaults below and
 * the local runtime's registration builder, which used to read the field
 * unconditionally. A number repeated at the fallback site is how the
 * manifest and the runtime come to disagree about what an unconfigured
 * connection means.
 */
export const DEFAULT_ECHO_TTL_SECONDS = 60;
export const DEFAULT_LAG_WINDOW_SECONDS = 60;

const BidirectionalHandlingSchema = z
  .object({
    /**
     * Echo-suppression TTL (seconds). The integration's `pending_writes` set
     * is keyed by `(external_id, content_hash)` and entries expire after
     * this window. Default 60 per Design Direction line 100; per-Integration
     * override allowed.
     */
    echo_ttl_seconds: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_ECHO_TTL_SECONDS),
    /**
     * External-truth-lag window (seconds). Reactive code that reads items
     * recently written by the same Connection waits at least this long
     * before trusting the read. Default 60.
     */
    lag_window_seconds: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_LAG_WINDOW_SECONDS),
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
  })
  .strict();

const OAuthRequirementValue = z.enum(["proxy", "leased"]);

/**
 * Token-credential requirements — an additive manifest field.
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
 * Optional and additive, so a manifest that does not declare it still
 * validates. It arrived as a minor bump while the contract was at 1.x;
 * that history is why the field is described as additive, and it is not
 * guidance to declare a 1.x version today, which the server refuses.
 */
const TokenRequirementValue = z.literal("required");

const WebhookVerificationSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("hmac-sha256") }).strict(),
  z.object({ method: z.literal("slack") }).strict(),
  z.object({ method: z.literal("stripe") }).strict(),
  z.object({ method: z.literal("github") }).strict(),
  // `google-channel` covers Google Workspace push notifications
  // (Calendar / Drive / Gmail) — body-less; verification by X-Goog-
  // Channel-Token header against the per-channel stored secret.
  z.object({ method: z.literal("google-channel") }).strict(),
  // `cloudflare-email` covers Cloudflare Email Routing → Email Worker
  // → signed JSON envelope. Verification is HMAC-SHA256 over the body
  // (same on-wire shape as `hmac-sha256`); the distinct method declares
  // the body schema (parsed-email envelope) the integration handler expects.
  z.object({ method: z.literal("cloudflare-email") }).strict(),
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
    /**
     * Derive the closed value set from the manifest's declared write
     * families — manifest 1.3.0. The right shape for a key that selects
     * WHICH COHERENT SET of types a connection writes: `from_target_types`
     * offers individual types, which for a multi-type integration is a
     * choice between half-answers.
     */
    from_write_families: z.boolean().optional(),
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

/**
 * One write family: a named, coherent set of target types chosen together —
 * manifest 1.3.0. `types` maps the author's role vocabulary (`show`,
 * `episode`, or just `item` for a single-type integration) to the type each
 * role writes under this family, so a handler indexes the selected family
 * by role instead of hardcoding identifiers.
 */
const WriteFamilySchema = z
  .object({
    description: z
      .string()
      .min(1, "write families describe themselves to the configure surface"),
    types: z.record(
      z.string().min(1),
      z.string().refine((s) => isValidTypeIdentifier(s), {
        message: "write family types must be valid type identifiers",
      }),
    ),
  })
  .strict();

const WriteFamiliesSchema = z
  .object({
    families: z.record(z.string().min(1), WriteFamilySchema),
    /** Family selected when a connection configures none. */
    default: z.string().min(1),
  })
  .strict();

export type WriteFamilies = z.infer<typeof WriteFamiliesSchema>;

export const IntegrationManifestSchema = z
  .object({
    name: ManifestNameSchema,
    /**
     * Human-readable label for surfaces that show the integration to a
     * person — manifest 2.1.0 additive field. Publisher-authored and fixed
     * at publish time: it travels in the manifest, so it is a property of
     * the release rather than something an installer chooses.
     *
     * Optional, and deliberately not unique. `name` stays the identifier
     * and the dedupe key, so nothing resolves by this field, and two
     * publishers picking the same words leaves neither install ambiguous.
     * A manifest omitting it is shown under `name`, which is what every
     * manifest predating this field does.
     *
     * Trimmed before the non-empty check, so whitespace-only is refused.
     * That check is a floor and not a bound, and it is the whole of what
     * this field constrains: a zero-width space is neither whitespace nor
     * empty and passes. Surfaces therefore keep the identifier visible
     * beside a label rather than trusting this field to be legible, which
     * is the guarantee that actually holds.
     */
    display_name: z
      .string()
      .trim()
      .min(1, "display_name cannot be blank")
      .optional(),
    version: SemverSchema,
    /**
     * Who stands behind the code, so who a deployment trusts by installing
     * it — never the service the integration talks to. `google/calendar`
     * is published by `marfa`.
     *
     * **The grammar without the reserved-root refusal, which is a
     * decision rather than an oversight.** `marfa` is a reserved root, so
     * `isValidHandle` refuses it; every first-party manifest declares it,
     * because nobody may claim the platform's own name and the platform
     * publishes under it anyway. Validating this as a claimable handle
     * would take the field from wrong in five manifests to refused in
     * sixteen. Registration already exempts platform credentials from the
     * handle-ownership rule, so the carve-out is one the model has.
     */
    publisher: z
      .string()
      .min(1, "publisher is required")
      .refine(isValidHandleGrammar, {
        message:
          "publisher must be a handle: lowercase letters, digits and single hyphens, 3-32 characters",
      }),
    description: z.string().min(1, "description is required"),
    direction: z.enum(["read", "write", "both"]),
    /**
     * Where this integration's code runs — manifest 2.2.0 additive field.
     *
     * `server` is a deployment's own runtime: the image installs the
     * integration under `MARFA_INTEGRATIONS_ROOT` and dispatches it.
     * `client` is a machine the deployment does not have, which is why
     * the sync client watches a filesystem and Marfa cannot start it.
     *
     * Defaulted rather than optional on the parsed value, so the one
     * parse every resolution already passes through is the single place
     * that decides what absence means. Readers get a value, never a
     * question, and nobody has to remember a helper.
     *
     * The run route reads this before it looks at triggers, and the
     * catalog reconcile reads it instead of inferring a client from a
     * registration miss — an inference that was correct while there was
     * one client and silently wrong the moment there were two.
     */
    runs_on: z.enum(["server", "client"]).default("server"),
    /**
     * When the runtime is asked to run this integration. Optional, and
     * `validateManifestCoherence` decides whether the manifest may omit
     * it: a server-run integration declares at least one trigger, because
     * a deployment that dispatches it has to be told when; a client-run
     * one declares none, because the program that owns the code starts
     * the run and no trigger kind honestly describes that.
     */
    triggers: z.array(TriggerSchema).optional(),
    target_types: z
      .array(
        z.string().refine((s) => isValidTypeIdentifier(s), {
          message: "target_types entries must be valid type identifiers",
        }),
      )
      .min(1, "at least one target_type is required"),
    /**
     * How a two-way integration handles echoes, lag, tombstones and
     * partial writes. Optional: a manifest with one direction has no
     * honest value for `partial_write_mode`, which describes a write path
     * it does not have. `validateManifestCoherence` requires it of a
     * `both` direction and of nothing else.
     */
    bidirectional_handling: BidirectionalHandlingSchema.optional(),
    /**
     * Per-capability OAuth requirements. Optional: an integration whose
     * upstream needs no OAuth grant declares nothing rather than an empty
     * record standing in for one.
     */
    oauth_requirements: z
      .record(z.string().min(1), OAuthRequirementValue)
      .optional(),
    /**
     * Static-API-token requirements — an additive manifest field.
     * Optional; present on integrations whose upstream uses a bearer
     * token rather than OAuth. See `TokenRequirementValue` above.
     */
    token_requirements: z
      .record(z.string().min(1), TokenRequirementValue)
      .optional(),
    /**
     * How an inbound delivery on this connection is verified. Optional,
     * and required by `validateManifestCoherence` exactly when the
     * manifest declares a `webhook` trigger. It used to be required of
     * every manifest, so most declared `hmac-sha256` by convention and a
     * reader of one believed it verified webhooks it never receives.
     */
    webhook_verification: WebhookVerificationSchema.optional(),
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
    /**
     * Named write families — manifest 1.3.0 additive field. Cross-field
     * coherence (default exists, families cover target_types exactly) is
     * enforced by `validateWriteFamilies`, kept outside the Zod schema so
     * the generated JSON Schema artifact stays derivable.
     */
    write_families: WriteFamiliesSchema.optional(),
    /**
     * Whether this integration's handlers consult the per-connection user
     * mapping (`ctx.mapping`) on their write path — manifest 1.3.0. The
     * mapping-configuration surface refuses integrations that do not, so
     * a stored mapping can never be silently ignored by a handler that
     * predates the mechanism.
     */
    supports_user_mappings: z.boolean().optional(),
    /**
     * Type schemas the integration brings with it, registered at catalog
     * registration rather than having to exist on the instance first.
     *
     * The shape is the platform's own type-schema shape, validated by the
     * same validator the in-tree codegen and `POST /types` both use, so a
     * schema that travels in a manifest is a schema in every other sense.
     *
     * Registration is gated on the identifier's namespace: an integration
     * may declare types inside its own namespace and nowhere else, so
     * `google/calendar` owns `google.*`. That is not an optional nicety —
     * without it a third-party package could register into somebody else's
     * namespace, which is exactly what the ownership rule at type
     * registration exists to stop.
     *
     * A declared schema also counts as resolvable when `target_types` is
     * checked, which is why an integration can name a type nobody has
     * registered yet and still be accepted.
     */
    type_schemas: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

/**
 * A manifest as an author writes one — the schema's INPUT view.
 *
 * `runs_on` is optional here because a manifest may omit it and mean
 * `server`; the JSON Schema artifact published alongside this type says the
 * same thing, and the two would otherwise disagree about the same contract.
 * Marfa's own manifests declare it explicitly anyway, because being
 * explicit about where code runs costs one line.
 */
export type IntegrationManifest = z.input<typeof IntegrationManifestSchema>;

/**
 * A manifest as the server holds one, after `validateManifest` — the
 * schema's OUTPUT view, where every default has been applied and `runs_on`
 * is therefore always a value.
 *
 * Two types rather than one because the two questions differ: what an
 * author must supply, and what a reader may rely on. Collapsing them makes
 * one of the two wrong, and it was the reader's half that mattered — a
 * consumer branching on `runs_on` should not have to spell the default
 * again, and the day it does is the day some caller spells it differently.
 */
export type ParsedIntegrationManifest = z.infer<
  typeof IntegrationManifestSchema
>;

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
/**
 * Fill in the defaults a manifest declares for keys the caller left out.
 *
 * A declared `default` used to be inert. Nothing consulted it on a write, so
 * it described the integration's intent while every code path decided for
 * itself what an unconfigured connection meant — and Google Calendar's two
 * branches came to disagree, one writing `core.event` and the other
 * `google.calendar.event` for the same install. Applying the default when
 * the connection is created makes the manifest the single statement of what
 * a connection writes, and makes an in-code fallback unreachable rather than
 * merely discouraged.
 *
 * Applied at install rather than at read time on purpose: a value written
 * into `configuration` is visible to the operator and stays put, whereas a
 * default resolved on every read silently changes what an existing
 * connection writes the moment the manifest changes.
 */
export function applyConfigurationDefaults(
  manifest: Pick<IntegrationManifest, "configuration_schema">,
  configuration: Record<string, unknown>,
): Record<string, unknown> {
  const declared = manifest.configuration_schema ?? {};
  const filled: Record<string, unknown> = { ...configuration };
  for (const [key, spec] of Object.entries(declared)) {
    if (spec.default !== undefined && filled[key] === undefined) {
      filled[key] = spec.default;
    }
  }
  return filled;
}

/**
 * The default a manifest declares for one key, when it declares one of the
 * expected shape. Surfaces that render a choice read it here rather than
 * hardcoding a value that agrees with the manifest only by coincidence.
 */
export function declaredConfigurationDefault(
  manifest: Pick<IntegrationManifest, "configuration_schema">,
  key: string,
): string | undefined {
  const value = manifest.configuration_schema?.[key]?.default;
  return typeof value === "string" ? value : undefined;
}

/**
 * Cross-field coherence for a manifest's write families. Kept beside the
 * Zod schema rather than inside it (the generated JSON Schema artifact
 * must stay derivable from the plain object schema); the server's
 * manifest validation and the shared manifest test convention both call
 * it, which is what retires the per-integration pair-membership tests
 * that used to stand in for a schema feature.
 */
export function validateWriteFamilies(
  manifest: Pick<
    IntegrationManifest,
    "write_families" | "target_types" | "configuration_schema"
  >,
): string[] {
  const issues: string[] = [];
  const wf = manifest.write_families;
  const declaresSelector = Object.values(
    manifest.configuration_schema ?? {},
  ).some((spec) => spec.from_write_families === true);
  if (!wf) {
    if (declaresSelector) {
      issues.push(
        "a configuration field sets from_write_families but the manifest declares no write_families",
      );
    }
    return issues;
  }
  const names = Object.keys(wf.families);
  if (names.length === 0) {
    issues.push("write_families.families must declare at least one family");
    return issues;
  }
  if (!wf.families[wf.default]) {
    issues.push(
      `write_families.default "${wf.default}" is not a declared family`,
    );
  }
  const targets = new Set(manifest.target_types);
  const covered = new Set<string>();
  for (const [name, family] of Object.entries(wf.families)) {
    const members = Object.values(family.types);
    if (members.length === 0) {
      issues.push(`write family "${name}" declares no types`);
    }
    for (const member of members) {
      covered.add(member);
      if (!targets.has(member)) {
        issues.push(
          `write family "${name}" names "${member}", which is not in target_types`,
        );
      }
    }
  }
  for (const target of targets) {
    if (!covered.has(target)) {
      issues.push(
        `target type "${target}" belongs to no write family; every target travels in one`,
      );
    }
  }
  return issues;
}

/**
 * Cross-field coherence a manifest must satisfy wherever it is read.
 *
 * The schema used to demand a value for `webhook_verification`,
 * `bidirectional_handling` and `oauth_requirements` from every manifest,
 * so most supplied a convention — and a convention in a manifest reads as
 * a fact. Presence is no longer the question; agreement is. A field with
 * nothing to say is absent, and a field that is present has to be true of
 * the thing declaring it.
 *
 * **These are the rules every manifest already registered satisfies**,
 * which is what makes them safe in the runtime validator. That validator
 * runs against every connection's STORED manifest on every resolution and
 * a credential mint fails closed, so a rule stored rows do not already
 * meet is not a validation change, it is an outage. The stricter
 * authoring rules live in `validateManifestAuthoring` for exactly that
 * reason. Kept outside the Zod schema, like `validateWriteFamilies`, so
 * the generated JSON Schema artifact stays derivable from a plain object
 * schema.
 */
export function validateManifestCoherence(
  manifest: Pick<
    IntegrationManifest,
    | "triggers"
    | "direction"
    | "webhook_verification"
    | "bidirectional_handling"
    | "runs_on"
  >,
): string[] {
  const issues: string[] = [];
  const triggers = manifest.triggers ?? [];
  const declaresWebhook = triggers.some((t) => t.type === "webhook");

  if (declaresWebhook && manifest.webhook_verification === undefined) {
    issues.push(
      "a webhook trigger needs webhook_verification: an inbound delivery has to be verified by some method, and there is no default",
    );
  }
  if (manifest.direction === "both" && !manifest.bidirectional_handling) {
    issues.push(
      'direction "both" needs bidirectional_handling: a two-way integration has to say how it suppresses echoes and what it does with a tombstone',
    );
  }
  if (manifest.runs_on === "client") {
    if (manifest.triggers !== undefined) {
      issues.push(
        "a client-run integration declares no triggers: its code runs on a machine this deployment does not have, so nothing here can fire one",
      );
    }
  } else if (triggers.length === 0) {
    issues.push(
      "a server-run integration declares at least one trigger, or nothing would ever run it",
    );
  }
  return issues;
}

/**
 * The stricter half, enforced where a manifest is written rather than
 * where one is read.
 *
 * "A field with nothing to say is absent" is an authoring rule. It is held
 * at `POST /integrations`, which judges an incoming body and never a stored
 * row, and at the in-tree manifest tests here. Neither can reach a row
 * somebody already installed against, which is the whole reason the split
 * exists.
 *
 * **The image build is the third door, and it arrived with the pin rather
 * than ahead of it.** The manifests a deployment stages are pinned to a
 * commit of `withmarfa/integrations`, and on the pin before the sweep
 * thirteen of the fourteen staged manifests declared something they had
 * nothing to say about. Holding the image build to the rule then would
 * have failed the build on manifests the deployment was still meant to
 * ship, so the rule and the pin that satisfies it moved together.
 *
 * The boot catalog reconcile is deliberately never on that list. It
 * registers what the image already staged, which may predate a rule, and
 * refusing there would take the catalog down rather than tell an author
 * anything.
 *
 * **Deliberately not in `validateManifestCoherence`.** Replayed over the
 * stored catalog rows on 6 September 2026, these three refuse 46, 52 and
 * 45 of 72 rows on staging and 43, 49 and 42 of 69 on production, 17 and 4
 * of them carrying live connections. Putting them in the runtime validator
 * before those rows move would fail resolution on every one of them, and
 * `previewUpgrade` resolves the stored manifest to compute its diff — so
 * the connections could not then be moved either. They move first, under
 * the rules above; these follow.
 */
export function validateManifestAuthoring(
  manifest: Pick<
    IntegrationManifest,
    | "triggers"
    | "direction"
    | "webhook_verification"
    | "bidirectional_handling"
    | "oauth_requirements"
    | "token_requirements"
    | "permissions"
    | "runs_on"
  >,
): string[] {
  const issues = validateManifestCoherence(manifest);
  const declaresWebhook = (manifest.triggers ?? []).some(
    (t) => t.type === "webhook",
  );

  if (manifest.webhook_verification !== undefined && !declaresWebhook) {
    issues.push(
      "webhook_verification without a webhook trigger: nothing will ever verify a delivery this manifest cannot receive, so drop the field",
    );
  }
  if (manifest.bidirectional_handling && manifest.direction !== "both") {
    issues.push(
      `bidirectional_handling on a "${manifest.direction}" integration: partial_write_mode describes a write path this manifest does not have, so drop the field`,
    );
  }
  for (const field of ["oauth_requirements", "token_requirements"] as const) {
    const value = manifest[field];
    if (value !== undefined && Object.keys(value).length === 0) {
      issues.push(
        `${field} is declared and empty: an empty record is the absence of a requirement wearing the shape of one, so drop the field`,
      );
    }
  }
  // `permissions` is the same shape and was missed the first time this rule
  // was written, which is how `permissions: { edge: {} }` survived on both
  // manifests this repository ships while the rule beside it condemned the
  // identical thing under two other names. A rule that covers two of three
  // instances of a shape is a preference; covering all three makes it a rule.
  if (manifest.permissions !== undefined) {
    if (Object.keys(manifest.permissions).length === 0) {
      issues.push(
        "permissions is declared and empty: drop the field rather than declaring no permissions",
      );
    }
    for (const axis of ["extension", "edge"] as const) {
      const map = manifest.permissions[axis];
      if (map !== undefined && Object.keys(map).length === 0) {
        issues.push(
          `permissions.${axis} is declared and empty: an empty map grants nothing, which is what omitting it says, so drop it`,
        );
      }
    }
  }
  return issues;
}

/** A write family resolved for one connection: its name and role map. */
export interface ResolvedWriteFamily {
  name: string;
  types: Record<string, string>;
}

/**
 * Resolve which write family a connection uses. Precedence:
 *
 * 1. A configured `write_family` naming a declared family.
 * 2. The manifest's declared default family.
 *
 * Returns null for a manifest that declares no families, which is what
 * lets handlers that have not migrated keep their own resolution.
 */
export function resolveWriteFamily(
  manifest: Pick<IntegrationManifest, "write_families">,
  configuration: Record<string, unknown> | undefined,
): ResolvedWriteFamily | null {
  const wf = manifest.write_families;
  if (!wf) return null;
  const pick = (name: string): ResolvedWriteFamily => ({
    name,
    types: wf.families[name]?.types ?? {},
  });
  const configured = configuration?.write_family;
  if (typeof configured === "string" && wf.families[configured]) {
    return pick(configured);
  }
  return pick(wf.default);
}

export function validateConnectionConfiguration(
  manifest: Pick<
    IntegrationManifest,
    "configuration_schema" | "target_types" | "write_families"
  >,
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
    const allowed = spec.from_write_families
      ? Object.keys(manifest.write_families?.families ?? {})
      : spec.from_target_types
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
 * Majors a stored manifest may carry.
 *
 * Held `[1, 2]` while catalog rows written against the previous contract
 * were migrated forward. That migration has run on every deployment, so a
 * 1.x row no longer exists to accept, and continuing to accept one would
 * mean the contract has two answers to what a manifest is.
 *
 * The reason this is a list rather than a single number is worth keeping:
 * `validateManifest` runs against every connection's STORED manifest on
 * every resolution, and a credential mint fails closed when resolution
 * fails. Narrowing it is therefore a change to live data handling, not a
 * constant, and it is only ever safe once the rows have moved.
 *
 * Moving this is one of the four things a narrowing tightens, and it is the
 * one that gets forgotten because nothing in the change mentions it. The
 * other three, and the replay-over-stored-rows check that catches all of
 * them, are under "Narrowing a contract that stored rows already match" in
 * the repository's AGENTS.md.
 */
export const MANIFEST_SCHEMA_VERSION_ACCEPTED_MAJORS: readonly number[] = [2];

/** Parses `manifest_schema_version` and returns its major component. */
export function parseManifestSchemaMajor(version: string): number | null {
  const match = SEMVER_RE.exec(version);
  if (!match) return null;
  return Number.parseInt(match[1] ?? "0", 10);
}
