/**
 * `@mymehq/runtime-sdk/cloudflare` — Cloudflare-specific surface.
 *
 * Imported by per-Integration Workers (`integrations/<name>/src/worker.ts`)
 * for the Workers-runtime bootstrap. Drags in `@cloudflare/workers-types`
 * via the symbols exported here.
 *
 * The substrate-agnostic surface (handler registry, `ConnectionContext`,
 * `ConsumerEnvironment`, `consumeBatch`, types, cron helpers,
 * `verifyHandler`, `PerConnectionStateCore`) lives at the root
 * `@mymehq/runtime-sdk` entry and is reused by the local-runtime
 * substrate inside `@mymehq/server` without any Cloudflare dependency.
 */
export { PerConnectionState } from "./per-connection-state.js";
export type { PerConnectionAlarmEnv } from "./per-connection-state.js";

export { createIntegrationWorker, buildConsumerEnv } from "./worker-entry.js";
export type {
  IntegrationWorkerEnv,
  IntegrationWorkerConfig,
  IntegrationWorkerExport,
} from "./worker-entry.js";
