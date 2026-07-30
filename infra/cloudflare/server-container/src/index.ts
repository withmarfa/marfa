import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import { serveThroughContainer } from "./cold-start.js";

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
 * synchronously on `env`, so a class-level `envVars` is sufficient.
 *
 * The fetch handler waits for the container to be listening before it proxies.
 * A bare passthrough answers the request that triggers a wake with the proxy
 * layer's own failure string, so the first person to open Marfa after a quiet
 * spell saw an error page rather than the app — and the experimental web app
 * reported "Couldn't reach the default instance" for an instance that was
 * merely asleep.
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
  // Direct (unpooled, session-mode) endpoint on the same database as
  // DATABASE_URL. Streaming RLS reserves from this one because it issues a
  // session-level SET ROLE, which strands on a shared backend when it runs
  // over the transaction-mode pooler DATABASE_URL points at.
  MARFA_DATABASE_URL_DIRECT?: string;
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

/**
 * Deliberate warm policy (default off; enabled per env via the
 * `MARFA_CONTAINER_WARM` wrangler var). Cold start on this single-instance
 * container is a multi-second boot (image start + Node bring-up + port
 * readiness) that lands on whoever issues the first request after an idle gap
 * — a real product failure on an interactive surface, not an acceptable edge
 * case.
 *
 * The warm mechanism is the container runtime's own one: a long activity
 * window (`sleepAfter`). Every request renews the window, so under any normal
 * traffic the single instance never reaches the deadline and stays resident;
 * the boot is paid once at deploy, never again on an idle gap. (Renewing the
 * window from `onActivityExpired` instead would fight the runtime's
 * activity-expiry lifecycle and can leave the container stopped-but-unreapable
 * — so we lengthen the window rather than intercept its expiry.)
 *
 * Operational cost: a resident container (and the Neon connection pool it
 * holds open) is billed for continuous awake-time rather than only while
 * serving traffic. That is the deliberate trade — latency floor over idle
 * spend — and it's the reason this is a toggle, not a hardcoded default: an
 * environment whose compute budget can't absorb always-on (e.g. a free Neon
 * tier) sets `MARFA_CONTAINER_WARM=false` to fall back to scale-to-zero.
 */
// CAUTION — cost: enabling warm pins the single instance awake 24/7, which
// Cloudflare bills continuously. Floor is the managing Durable Object
// (~$12.50/mo) plus provisioned memory + disk for the whole resident window —
// on the order of tens of dollars/month per always-on standard-1. Keep off
// (scale-to-zero) unless a latency floor is genuinely required.
const CONTAINER_WARM =
  (cfEnv.MARFA_CONTAINER_WARM ?? "").trim().toLowerCase() === "true";

export class MarfaServerContainer extends Container<Env> {
  defaultPort = 8600;

  // Activity window before scale-to-zero. Warm = a week-long window: normal
  // traffic renews it on every request, so the instance stays resident and
  // never cold-starts in active use, while a truly abandoned deployment still
  // releases after a week. Off = the configured short idle timer. The
  // runtime's time-expression parser accepts only s/m/h units, so the warm
  // window is expressed in hours.
  sleepAfter = CONTAINER_WARM ? "168h" : (cfEnv.CONTAINER_SLEEP_AFTER ?? "20m");

  envVars = definedEnv({
    // Static (hosted) configuration.
    DB_DIALECT: "pg",
    // The hosted DATABASE_URL is Neon's pooled (PgBouncer, transaction-mode)
    // endpoint. Declaring that makes the server refuse to boot without a
    // direct endpoint for streaming RLS, rather than quietly reusing the
    // pooled client and stranding a role on a shared backend.
    MARFA_DB_POOL_MODE: "transaction",
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
    MARFA_DATABASE_URL_DIRECT: cfEnv.MARFA_DATABASE_URL_DIRECT,
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
   * The helper's graceful idle stop can leave a stale running state until the
   * process exit is observed. Destroying the disposable hosted server instead
   * lets the next request take its normal fresh-start and port-readiness path.
   * With the warm policy on, the long `sleepAfter` window means this only fires
   * after a genuinely abandoned week, not on routine idle gaps.
   */
  override async onActivityExpired(): Promise<void> {
    await this.destroy();
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // The waiting and the error shaping live in `cold-start.ts` so they can be
    // tested without the Workers runtime; this stays the thin binding it looks
    // like.
    return serveThroughContainer(request, getContainer(env.MARFA_SERVER));
  },
};
