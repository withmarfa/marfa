/**
 * Build the published OpenAPI document — the spec committed at the repo root
 * and synced to the public API reference.
 *
 * `createApp` mounts a few route groups only under a particular `AUTH_MODE`,
 * so reflecting a single app instance yields the surface of one deployment
 * shape rather than the API contract. The published spec is instead the union
 * across every auth mode, with each mode-exclusive operation marked so a
 * reader can tell what their own instance serves. The live `/openapi.json`
 * served by a running server stays a per-deployment document, which is the
 * honest answer to "what does THIS server expose".
 *
 * `scripts/generate-openapi.ts` is a thin wrapper over `buildPublishedOpenAPISpec`
 * so the committed artifact and any test that checks it exercise the same code
 * path rather than two copies of the assembly.
 */

import { createSqliteStorage } from "./storage/sqlite/index.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";
import { createApp } from "./app.js";
import {
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
} from "./openapi-finalize.js";
import type { AppConfig } from "./config.js";

type AuthMode = AppConfig["authMode"];

/**
 * Every auth mode the server can boot in. The `Record<AuthMode, …>` shape is
 * the guard: a new member on the union fails to type-check until it is listed
 * here, so a future mode's routes cannot silently vanish from the reference.
 */
const AUTH_MODE_COVERAGE: Record<AuthMode, true> = {
  keys: true,
  hosted: true,
};

const AUTH_MODES = Object.keys(AUTH_MODE_COVERAGE) as AuthMode[];

const BLOB_PATH = "/tmp/marfa-openapi-blobs";

function specGenerationConfig(authMode: AuthMode): AppConfig {
  return {
    port: 8600,
    storageDialect: "sqlite",
    sqlitePath: ":memory:",
    databaseUrl: "",
    blobPath: BLOB_PATH,
    blobBackend: "fs",
    maxBlobSize: 50 * 1024 * 1024,
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: "openapi-generation-salt-not-for-production",
    corsOrigins: [],
    cdnBaseUrl: "",
    authMode,
    versionSnapshotIntervalMs: 600_000,
    rateLimitEnabled: false,
    enableHsts: false,
    auditRetentionDays: 90,
    auditCleanupIntervalMs: 86_400_000,
    eventLogRetentionHours: 168,
    versionThinningIntervalMs: 3_600_000,
    versionRecentDays: 30,
    versionDailySnapshotDays: 90,
    versionWeeklySnapshotDays: 365,
    versionMaxVersions: 500,
    trashRetentionDays: 60,
    trashPurgeIntervalMs: 86_400_000,
    errorWebhookUrl: "",
    trustedProxyCidrs: [],
    authBaseUrl: "http://localhost:8600",
    authAllowSignup: false,
    seedStarterContent: false,
    authSecret: "openapi-generation-secret-not-for-production",
    oidcProviders: [],
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
    mcpEnabled: false,
  };
}

/** Reflect and finalize the spec for one auth mode. */
async function buildSpecForAuthMode(
  authMode: AuthMode,
): Promise<Record<string, unknown>> {
  const storage = await createSqliteStorage(":memory:", { authMode });
  try {
    const app = createApp(
      storage,
      new FilesystemBlobBackend(BLOB_PATH),
      specGenerationConfig(authMode),
    );
    return finalizeOpenAPISpec(
      app.getOpenAPIDocument({
        openapi: "3.1.0",
        info: OPENAPI_DOCUMENT_INFO,
      }),
    ) as unknown as Record<string, unknown>;
  } finally {
    await storage.close();
  }
}

/**
 * Vendor extension naming the auth modes that serve an operation. Present only
 * on operations some mode does not serve; its absence means "every mode".
 */
const AUTH_MODES_EXTENSION = "x-marfa-auth-modes";

/** Prose counterpart to the extension, for renderers that show descriptions. */
function authModeNote(modes: readonly AuthMode[]): string {
  const list = modes.map((mode) => `\`AUTH_MODE=${mode}\``).join(" or ");
  return `**Auth mode:** served only by deployments running ${list}. Instances in any other auth mode do not expose this endpoint.`;
}

type Operation = Record<string, unknown>;
type Paths = Record<string, Record<string, Operation>>;
type Components = Record<string, Record<string, unknown>>;

/**
 * Union the per-mode documents into the published contract.
 *
 * Insertion order drives the output: modes are walked in a fixed order and a
 * path or method is placed the first time it is seen, so the generated JSON is
 * stable and the freshness diff stays meaningful.
 */
function mergeAuthModeSpecs(
  perMode: readonly { mode: AuthMode; spec: Record<string, unknown> }[],
): Record<string, unknown> {
  // Reusing the first document as the envelope keeps the top-level key order
  // (openapi, info, components, paths, tags), so an empty list has no
  // envelope to shape and there is nothing honest to return.
  const [base, ...rest] = perMode;
  if (!base) {
    throw new Error("Cannot merge an empty set of auth-mode OpenAPI documents");
  }

  const merged = new Map<string, Map<string, Operation>>();
  const servedBy = new Map<Operation, AuthMode[]>();

  for (const { mode, spec } of perMode) {
    for (const [path, methods] of Object.entries((spec.paths ?? {}) as Paths)) {
      let pathEntry = merged.get(path);
      if (!pathEntry) {
        pathEntry = new Map();
        merged.set(path, pathEntry);
      }
      for (const [method, operation] of Object.entries(methods)) {
        const kept = pathEntry.get(method) ?? operation;
        pathEntry.set(method, kept);
        servedBy.set(kept, [...(servedBy.get(kept) ?? []), mode]);
      }
    }
  }

  const paths: Paths = {};
  for (const [path, methods] of merged) {
    const entry: Record<string, Operation> = {};
    for (const [method, operation] of methods) {
      const modes = servedBy.get(operation) ?? [];
      if (modes.length < perMode.length) {
        operation[AUTH_MODES_EXTENSION] = modes;
        const note = authModeNote(modes);
        operation.description =
          typeof operation.description === "string" &&
          operation.description.length > 0
            ? `${operation.description}\n\n${note}`
            : note;
      }
      entry[method] = operation;
    }
    paths[path] = entry;
  }

  const document = base.spec;
  const components = { ...((document.components ?? {}) as Components) };
  for (const { spec } of rest) {
    for (const [section, entries] of Object.entries(
      (spec.components ?? {}) as Components,
    )) {
      components[section] = { ...entries, ...(components[section] ?? {}) };
    }
  }
  document.components = components;
  document.paths = paths;
  return document;
}

/** Assemble the document published as the public API reference. */
export async function buildPublishedOpenAPISpec(): Promise<
  Record<string, unknown>
> {
  const perMode: { mode: AuthMode; spec: Record<string, unknown> }[] = [];
  for (const mode of AUTH_MODES) {
    perMode.push({ mode, spec: await buildSpecForAuthMode(mode) });
  }
  return mergeAuthModeSpecs(perMode);
}

export { AUTH_MODES, buildSpecForAuthMode };
