import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

/**
 * Worker front for the Marfa server running on Cloudflare Containers.
 *
 * The container runs the full Node server image (`packages/server/Dockerfile`).
 * This Worker is a thin front: a Durable-Object-backed `Container` manages one
 * instance's lifecycle, and the fetch handler proxies every request to it.
 *
 * Single instance by design — the server holds in-process pubsub + the
 * reactive-run drainer + the unguarded background sweeps, so all traffic must
 * land on ONE container. `max_instances: 1` in wrangler.jsonc enforces this on
 * the platform side; routing here always targets the singleton.
 *
 * Config reaches the container through `envVars`: plain values come from
 * wrangler `[vars]`, secrets from `wrangler secret put` — both surface
 * synchronously on `env`, so a class-level `envVars` is sufficient (no async
 * `startAndWaitForPorts` needed).
 */
interface Env {
  MARFA_SERVER: DurableObjectNamespace<MarfaServerContainer>;
  // Idle scale-to-zero timer; tunable per env without a code change.
  CONTAINER_SLEEP_AFTER?: string;
  // Plain vars (wrangler [vars]).
  BLOB_BACKEND?: string;
  MARFA_AUTH_BASE_URL?: string;
  CORS_ORIGINS?: string;
  MARFA_RUNTIME_CONTROL_URL?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  MARFA_EMAIL_FROM?: string;
  S3_BUCKET?: string;
  S3_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?: string;
  // Deployment environment tag (staging | production) stamped onto the OTel
  // `deployment.environment` resource attribute so staging and prod logs are
  // distinguishable in their PostHog projects. Without it the bootstrap falls
  // back to NODE_ENV, which is "production" in the container on both envs.
  MARFA_OTEL_ENVIRONMENT?: string;
  // Secrets (wrangler secret put — not in wrangler config).
  DATABASE_URL?: string;
  MARFA_AUTH_SECRET?: string;
  API_KEY_SALT?: string;
  MARFA_RUNTIME_BROKER_KEY?: string;
  CLOUDFLARE_QUEUES_API_TOKEN?: string;
  CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS?: string;
  CLOUDFLARE_EMAIL_API_TOKEN?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
}

/** Drop unset/empty values so the container env doesn't get literal "undefined". */
function definedEnv(
  vars: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

// `env` from cloudflare:workers is typed against Cloudflare's global env;
// cast to our binding shape (vars + secrets). The deploy script + secrets
// scripts are the source of truth for what's actually set.
const cfEnv = env as unknown as Env;

export class MarfaServerContainer extends Container<Env> {
  defaultPort = 8600;

  // Scale-to-zero idle timer. Production may move to always-warm (a large
  // value) once streaming + background-job continuity are validated.
  sleepAfter = cfEnv.CONTAINER_SLEEP_AFTER ?? "20m";

  envVars = definedEnv({
    // Static (hosted) configuration.
    DB_DIALECT: "pg",
    AUTH_MODE: "hosted",
    MARFA_AUTH_ALLOW_SIGNUP: "true",
    MARFA_SEED_STARTER_CONTENT: "true",
    PORT: "8600",
    NODE_ENV: "production",
    ENABLE_HSTS: "true",
    MARFA_INTEGRATION_RUNTIME: "hosted",
    // Hosted defaults to R2 via the S3 API (durable across scale-to-zero);
    // overridable to "fs" for validation deploys before R2 creds exist.
    BLOB_BACKEND: cfEnv.BLOB_BACKEND ?? "s3",
    S3_REGION: "auto",
    MARFA_EMAIL_BACKEND: "cloudflare",
    MARFA_OTEL_ENABLED: "true",
    OTEL_SERVICE_NAME: "marfa-server",
    MARFA_OTEL_SAMPLE_RATIO: "0.05",
    // Per-env plain vars.
    MARFA_AUTH_BASE_URL: cfEnv.MARFA_AUTH_BASE_URL,
    CORS_ORIGINS: cfEnv.CORS_ORIGINS,
    MARFA_RUNTIME_CONTROL_URL: cfEnv.MARFA_RUNTIME_CONTROL_URL,
    CLOUDFLARE_ACCOUNT_ID: cfEnv.CLOUDFLARE_ACCOUNT_ID,
    MARFA_EMAIL_FROM: cfEnv.MARFA_EMAIL_FROM,
    S3_BUCKET: cfEnv.S3_BUCKET,
    S3_ENDPOINT: cfEnv.S3_ENDPOINT,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: cfEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    MARFA_OTEL_ENVIRONMENT: cfEnv.MARFA_OTEL_ENVIRONMENT,
    // Secrets.
    DATABASE_URL: cfEnv.DATABASE_URL,
    MARFA_AUTH_SECRET: cfEnv.MARFA_AUTH_SECRET,
    API_KEY_SALT: cfEnv.API_KEY_SALT,
    MARFA_RUNTIME_BROKER_KEY: cfEnv.MARFA_RUNTIME_BROKER_KEY,
    CLOUDFLARE_QUEUES_API_TOKEN: cfEnv.CLOUDFLARE_QUEUES_API_TOKEN,
    CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS:
      cfEnv.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS,
    CLOUDFLARE_EMAIL_API_TOKEN: cfEnv.CLOUDFLARE_EMAIL_API_TOKEN,
    S3_ACCESS_KEY_ID: cfEnv.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: cfEnv.S3_SECRET_ACCESS_KEY,
    OTEL_EXPORTER_OTLP_HEADERS: cfEnv.OTEL_EXPORTER_OTLP_HEADERS,
  });

  /**
   * A scale-to-zero wake can receive its first proxy request before Node has
   * opened the HTTP port. Wait for the declared port rather than exposing
   * Cloudflare's transient "container is not listening" response to clients.
   */
  override async fetch(request: Request): Promise<Response> {
    await this.startAndWaitForPorts();
    return this.containerFetch(request);
  }

  override onError(error: unknown): void {
    console.error("Marfa server container failed", error);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.MARFA_SERVER).fetch(request);
  },
};
