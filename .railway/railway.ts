/**
 * The hosted deployment's shape, as configuration rather than dashboard state.
 *
 * Every variable is `preserve()`: the name is recorded here, the value stays on
 * the platform and never enters this repository. What this file is for is the
 * shape — which services exist, what they listen on, which volumes and buckets
 * back them, and the settings that are otherwise invisible until something
 * breaks.
 *
 * **The image tags below are a snapshot, not a source of truth.** The deploy
 * workflow moves `web` and `worker` to a new tag on every release, so these go
 * stale the moment anything ships. That is why the companion workflow only ever
 * runs `plan`: an `apply` from a stale checkout would roll production back to
 * whichever build this file last recorded. Applying is deliberate and local,
 * after `railway config pull` has refreshed the tags. Wiring apply-on-merge
 * safely means moving the deploy itself onto `railway config apply`, which is a
 * change to the most load-bearing workflow in the estate and is not this.
 */
import {
  bucket,
  database,
  defineRailway,
  image,
  preserve,
  project,
  service,
  volume,
} from "railway/iac";

export default defineRailway(() => {
  // `database` rather than the `postgres` helper, which hardcodes `postgres:18`.
  // This instance runs Railway's SSL image on 17, and importing with the helper
  // produced a plan that would have swapped the image and jumped a major version
  // on the live database. The tag stays major-only: pinning a minor stops the
  // image tracking Railway's rebuilds, and point-in-time recovery warns about it.
  const postgresDatabase = database("postgres", "postgres", {
    image: "ghcr.io/railwayapp-templates/postgres-ssl:17",
    region: "europe-west4-drams3a",
  });
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "europe-west4-drams3a",
    sizeMB: 50000,
  });
  const marfaBlobs = bucket("marfa-blobs", { region: "ams" });
  const PostgresPITR = bucket("Postgres-PITR", { region: "ams" });
  const web = service("web", {
    source: image("ghcr.io/withmarfa/marfa-server:prod-05b6ca5"),
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "packages/server/Dockerfile",
    },
    healthcheck: "/health",
    healthcheckTimeout: 300,
    preDeploy: "node dist/predeploy.js",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: {
      drainingSeconds: 30,
      preDeployTimeoutSeconds: 600,
      registryCredentials: { password: "*****", username: "*****" },
    },
    domains: [{ domain: "api.marfa.so", port: 8600 }],
    env: {
      API_KEY_SALT: preserve(),
      AUDIT_RETENTION_DAYS: preserve(),
      AUTH_MODE: preserve(),
      BLOB_BACKEND: preserve(),
      CLOUDFLARE_ACCOUNT_ID: preserve(),
      CLOUDFLARE_EMAIL_API_TOKEN: preserve(),
      CORS_ORIGINS: preserve(),
      DATABASE_URL: preserve(),
      DB_DIALECT: preserve(),
      MARFA_AUTH_BASE_URL: preserve(),
      MARFA_AUTH_SECRET: preserve(),
      MARFA_DB_POOL_MODE: preserve(),
      MARFA_DB_POOL_SIZE: preserve(),
      MARFA_EMAIL_BACKEND: preserve(),
      MARFA_EMAIL_FROM: preserve(),
      MARFA_OTEL_ENABLED: preserve(),
      MARFA_OTEL_ENVIRONMENT: preserve(),
      MARFA_PLACEMENT_COUNTRY: preserve(),
      MARFA_PLACEMENT_LOCATION: preserve(),
      MARFA_PLACEMENT_REGION: preserve(),
      MARFA_PROCESS_ROLE: preserve(),
      MARFA_SSE_MAX_VIEWERS: preserve(),
      MAX_SUBSCRIPTION_LISTENERS: preserve(),
      OTEL_EXPORTER_OTLP_HEADERS: preserve(),
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: preserve(),
      OTEL_SERVICE_NAME: preserve(),
      PODCASTINDEX_API_KEY: preserve(),
      PODCASTINDEX_API_SECRET: preserve(),
      PORT: preserve(),
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: preserve(),
      S3_ACCESS_KEY_ID: preserve(),
      S3_BUCKET: preserve(),
      S3_ENDPOINT: preserve(),
      S3_FORCE_PATH_STYLE: preserve(),
      S3_REGION: preserve(),
      S3_SECRET_ACCESS_KEY: preserve(),
      TRUSTED_PROXY_HEADER: preserve(),
    },
  });
  const worker = service("worker", {
    source: image("ghcr.io/withmarfa/marfa-server:prod-05b6ca5"),
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "packages/server/Dockerfile",
    },
    healthcheck: "/health",
    healthcheckTimeout: 300,
    replicas: { "europe-west4-drams3a": 1 },
    deploy: {
      drainingSeconds: 30,
      registryCredentials: { password: "*****", username: "*****" },
    },
    env: {
      API_KEY_SALT: preserve(),
      AUDIT_RETENTION_DAYS: preserve(),
      AUTH_MODE: preserve(),
      BLOB_BACKEND: preserve(),
      CLOUDFLARE_ACCOUNT_ID: preserve(),
      CLOUDFLARE_EMAIL_API_TOKEN: preserve(),
      CORS_ORIGINS: preserve(),
      DATABASE_URL: preserve(),
      DB_DIALECT: preserve(),
      MARFA_API_URL: preserve(),
      MARFA_AUTH_BASE_URL: preserve(),
      MARFA_AUTH_SECRET: preserve(),
      MARFA_DB_POOL_MODE: preserve(),
      MARFA_DB_POOL_SIZE: preserve(),
      MARFA_EMAIL_BACKEND: preserve(),
      MARFA_EMAIL_FROM: preserve(),
      MARFA_OTEL_ENABLED: preserve(),
      MARFA_OTEL_ENVIRONMENT: preserve(),
      MARFA_PLACEMENT_COUNTRY: preserve(),
      MARFA_PLACEMENT_LOCATION: preserve(),
      MARFA_PLACEMENT_REGION: preserve(),
      MARFA_PROCESS_ROLE: preserve(),
      MARFA_SSE_MAX_VIEWERS: preserve(),
      MAX_SUBSCRIPTION_LISTENERS: preserve(),
      OTEL_EXPORTER_OTLP_HEADERS: preserve(),
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: preserve(),
      OTEL_SERVICE_NAME: preserve(),
      PODCASTINDEX_API_KEY: preserve(),
      PODCASTINDEX_API_SECRET: preserve(),
      PORT: preserve(),
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: preserve(),
      S3_ACCESS_KEY_ID: preserve(),
      S3_BUCKET: preserve(),
      S3_ENDPOINT: preserve(),
      S3_FORCE_PATH_STYLE: preserve(),
      S3_REGION: preserve(),
      S3_SECRET_ACCESS_KEY: preserve(),
      TRUSTED_PROXY_HEADER: preserve(),
    },
  });

  return project("marfa", {
    resources: [
      web,
      postgresDatabase,
      worker,
      postgresVolume,
      marfaBlobs,
      PostgresPITR,
    ],
  });
});
