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
  // Deliberate warm policy ("true" to enable). When on, the single instance is
  // kept resident instead of scaling to zero — see the warm policy on the
  // container class below.
  MARFA_CONTAINER_WARM?: string;
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

  // Scale-to-zero idle timer. With the warm policy off this is a true
  // scale-to-zero deadline; with it on it becomes the heartbeat cadence at
  // which the resident instance re-arms its activity window.
  sleepAfter = cfEnv.CONTAINER_SLEEP_AFTER ?? "20m";

  /**
   * Deliberate warm policy (default off; enabled per env via the
   * `MARFA_CONTAINER_WARM` wrangler var). Cold start on this single-instance
   * container is a multi-second boot (image start + Node bring-up + port
   * readiness) that lands on whoever issues the first request after an idle
   * gap — a real product failure on an interactive surface, not an acceptable
   * edge case. When enabled, the instance is kept resident instead of scaling
   * to zero, so a ticket open or first interaction never pays that boot.
   *
   * This is an explicit policy, not a reliance on background/accidental
   * traffic to stay warm: the activity window is alarm-backed, so renewing it
   * on expiry re-arms itself with no inbound request.
   *
   * Operational cost: a resident container (and the Neon connection pool it
   * holds open) is billed for continuous awake-time rather than only while
   * serving traffic. That is the deliberate trade — latency floor over idle
   * spend — and it's the reason this is a toggle, not a hardcoded default:
   * an environment whose compute budget can't absorb always-on (e.g. a free
   * Neon tier) sets `MARFA_CONTAINER_WARM=false` to fall back to scale-to-zero.
   */
  private readonly keepWarm =
    (cfEnv.MARFA_CONTAINER_WARM ?? "").trim().toLowerCase() === "true";

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
   * Fires when the container is running and the activity window
   * (`sleepAfter`) has elapsed. Two policies:
   *
   * - Warm on: re-arm the window instead of stopping. The instance stays
   *   resident across idle gaps, so the next request never pays a cold start.
   * - Warm off: destroy the disposable instance. The helper's graceful idle
   *   stop can leave a stale running state until the process exit is observed;
   *   destroying lets the next request take a clean fresh-start +
   *   port-readiness path.
   */
  override async onActivityExpired(): Promise<void> {
    if (this.keepWarm) {
      this.renewActivityTimeout();
      return;
    }
    await this.destroy();
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.MARFA_SERVER).fetch(request);
  },
};
