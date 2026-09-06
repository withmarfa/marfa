import {
  IntegrationManifestSchema,
  MANIFEST_SCHEMA_VERSION_ACCEPTED_MAJORS,
  parseManifestSchemaMajor,
  validateWriteFamilies,
  validateManifestCoherence,
} from "@withmarfa/shared";
import type { ParsedIntegrationManifest } from "@withmarfa/shared";

export interface ValidateManifestError {
  path: string;
  message: string;
}

export type ValidateManifestResult =
  | { ok: true; manifest: ParsedIntegrationManifest }
  | { ok: false; errors: ValidateManifestError[] };

/**
 * Pure-function validator for an Integration manifest input. Wraps
 * `IntegrationManifestSchema.safeParse` and adds a manifest-schema-version
 * range check so the server can reject manifests authored against a
 * future major (which it cannot honor) with a clear error.
 *
 * The inbound webhook subscription handler consumes the validated
 * manifest's `webhook_verification` field to dispatch to the right
 * adapter; the install-flow route calls this at install time.
 *
 * Error shape: `path` is the dot-joined Zod issue path (e.g.
 * `triggers.0.config.cron`) and `message` is the human-readable Zod
 * message. The version-range check yields a synthetic
 * `manifest_schema_version` path with a "not supported" message so
 * callers can surface a single error structure regardless of the
 * rejection cause.
 */
export function validateManifest(input: unknown): ValidateManifestResult {
  const parsed = IntegrationManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "_root",
        message: issue.message,
      })),
    };
  }

  // Coherence, not presence: the manifest's own fields have to agree with
  // each other. Deliberately the half every stored row already satisfies —
  // this function runs against a connection's persisted manifest on every
  // resolution and a mint fails closed, so a rule stored rows do not meet
  // is an outage rather than a validation change. The stricter authoring
  // rules are held at the doors a manifest is written behind instead.
  const coherenceIssues = validateManifestCoherence(parsed.data);
  if (coherenceIssues.length > 0) {
    return {
      ok: false,
      errors: coherenceIssues.map((message) => ({
        path: "_root",
        message,
      })),
    };
  }

  const familyIssues = validateWriteFamilies(parsed.data);
  if (familyIssues.length > 0) {
    return {
      ok: false,
      errors: familyIssues.map((message) => ({
        path: "write_families",
        message,
      })),
    };
  }

  const major = parseManifestSchemaMajor(parsed.data.manifest_schema_version);
  if (
    major === null ||
    !MANIFEST_SCHEMA_VERSION_ACCEPTED_MAJORS.includes(major)
  ) {
    return {
      ok: false,
      errors: [
        {
          path: "manifest_schema_version",
          message: `manifest schema version not supported (expected major ${MANIFEST_SCHEMA_VERSION_ACCEPTED_MAJORS.join(" or ")}.x.x, got ${parsed.data.manifest_schema_version})`,
        },
      ],
    };
  }

  return { ok: true, manifest: parsed.data };
}
