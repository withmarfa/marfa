import {
  IntegrationManifestSchema,
  MANIFEST_SCHEMA_VERSION_SUPPORTED_MAJOR,
  parseManifestSchemaMajor,
} from "@withmarfa/shared";
import type { IntegrationManifest } from "@withmarfa/shared";

export interface ValidateManifestError {
  path: string;
  message: string;
}

export type ValidateManifestResult =
  | { ok: true; manifest: IntegrationManifest }
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

  const major = parseManifestSchemaMajor(parsed.data.manifest_schema_version);
  if (major === null || major !== MANIFEST_SCHEMA_VERSION_SUPPORTED_MAJOR) {
    return {
      ok: false,
      errors: [
        {
          path: "manifest_schema_version",
          message: `manifest schema version not supported (expected major ${String(MANIFEST_SCHEMA_VERSION_SUPPORTED_MAJOR)}.x.x, got ${parsed.data.manifest_schema_version})`,
        },
      ],
    };
  }

  return { ok: true, manifest: parsed.data };
}
