/**
 * Registry of the in-tree integrations shipped in this monorepo.
 *
 * Single source of truth for the dispatch sites that used to maintain
 * structurally-identical lists of integrations:
 *
 *   - `packages/runtime-control/src/routes/arm-schedule.ts`
 *   - `packages/runtime-control/src/routes/verify.ts`
 *   - `packages/runtime-control/src/routes/webhooks.ts`
 *   - `infra/cloudflare/provision.ts`
 *   - `packages/server/src/integrations/local-runtime/registrations.ts`
 *
 * Adding a new in-tree integration: add one entry below and the five
 * sites above pick it up automatically.
 *
 * The `triggers` array mirrors the manifest's declared trigger types
 * verbatim. Drift between the registry and the manifest manifests as
 * either a routing bug (a webhook lands on no queue) or a dead queue
 * (the provisioner mints a queue no Worker consumes), so review
 * keeps these in sync. The `<integration>/src/manifest.test.ts`
 * sibling parses the manifest through `IntegrationManifestSchema`,
 * which catches manifest-shape drift independently.
 *
 * For npm consumers of `@withmarfa/shared` this is implementation
 * detail; the tree-shaker drops the table for any consumer that
 * doesn't reference `IN_TREE_INTEGRATIONS` or its helpers.
 */

/** Trigger types declared in `IntegrationManifestSchema.triggers`. */
export type IntegrationTriggerType =
  | "webhook"
  | "schedule"
  | "item-event"
  | "manual";

export interface InTreeIntegration {
  /** Manifest `name` (publisher-dot grammar, e.g. `google.calendar`). */
  name: string;
  /** Directory under `integrations/` containing this integration's
   *  source. Matches the kebab-case suffix used in queue and Worker
   *  names (e.g. `google-calendar`). */
  dirName: string;
  /** Trigger types the manifest declares. Mirror of the manifest's
   *  `triggers` array — kept in sync by review. */
  triggers: readonly IntegrationTriggerType[];
  /** True when the integration deploys as a Cloudflare Worker (hosted
   *  substrate). False for local-only integrations like `withmarfa.sync`. */
  hasWorker: boolean;
  /** `ControlPlaneEnv` field for the Service Binding the control
   *  plane uses to call `/arm-schedule` and `/verify` on this
   *  integration's Worker. Set when `hasWorker` is true. */
  serviceBinding?: string;
  /** `ControlPlaneEnv` field for the dedicated per-integration
   *  webhook-receipt queue producer. Set only when this integration
   *  consumes from its own queue; undefined means it uses the legacy
   *  shared `WEBHOOK_RECEIPT_QUEUE` (currently just
   *  `withmarfa.github-webhooks`). */
  webhookQueueBinding?: string;
  /** Override for the scheduled-poll queue slug. Defaults to
   *  `dirName` for integrations declaring a `schedule` trigger. The
   *  only override today is `todoist` → `todoist-tasks` because the
   *  consumer's `wrangler.toml` historically used the manifest-derived
   *  slug for that one. */
  scheduledPollQueueSlug?: string;
}

export const IN_TREE_INTEGRATIONS: readonly InTreeIntegration[] = [
  {
    name: "withmarfa.rss-watcher",
    dirName: "rss-watcher",
    triggers: ["schedule"],
    hasWorker: true,
    serviceBinding: "INTEGRATION_RSS_WATCHER",
  },
  {
    name: "withmarfa.github-webhooks",
    dirName: "github-webhooks",
    triggers: ["webhook"],
    hasWorker: true,
    serviceBinding: "INTEGRATION_GITHUB_WEBHOOKS",
    // No `webhookQueueBinding` — still on the legacy shared queue.
    // Migrating to a dedicated queue is a separate operational task
    // (consumer-side queue switch + drain of the shared queue).
  },
  {
    name: "withmarfa.task-auto-archive",
    dirName: "task-auto-archive",
    triggers: ["item-event", "schedule"],
    hasWorker: true,
    serviceBinding: "INTEGRATION_TASK_AUTO_ARCHIVE",
  },
  {
    name: "google.calendar",
    dirName: "google-calendar",
    triggers: ["schedule", "item-event", "webhook"],
    hasWorker: true,
    serviceBinding: "INTEGRATION_GOOGLE_CALENDAR",
    webhookQueueBinding: "WEBHOOK_RECEIPT_QUEUE_GOOGLE_CALENDAR",
  },
  {
    name: "google.tasks",
    dirName: "google-tasks",
    triggers: ["schedule", "item-event"],
    hasWorker: true,
    serviceBinding: "INTEGRATION_GOOGLE_TASKS",
  },
  {
    name: "google.drive",
    dirName: "google-drive",
    triggers: ["schedule", "item-event", "webhook"],
    hasWorker: true,
    serviceBinding: "INTEGRATION_GOOGLE_DRIVE",
    webhookQueueBinding: "WEBHOOK_RECEIPT_QUEUE_GOOGLE_DRIVE",
  },
  {
    name: "google.contacts",
    dirName: "google-contacts",
    triggers: ["schedule", "item-event"],
    hasWorker: true,
    serviceBinding: "INTEGRATION_GOOGLE_CONTACTS",
  },
  {
    name: "google.youtube",
    dirName: "google-youtube",
    triggers: ["schedule"],
    hasWorker: true,
    serviceBinding: "INTEGRATION_GOOGLE_YOUTUBE",
  },
  {
    name: "todoist.tasks",
    dirName: "todoist",
    triggers: ["schedule", "item-event"],
    hasWorker: true,
    serviceBinding: "INTEGRATION_TODOIST_TASKS",
    scheduledPollQueueSlug: "todoist-tasks",
  },
  {
    name: "readwise.highlights",
    dirName: "readwise",
    triggers: ["schedule"],
    hasWorker: true,
    serviceBinding: "INTEGRATION_READWISE",
  },
  {
    name: "raindrop.bookmarks",
    dirName: "raindrop",
    triggers: ["schedule"],
    hasWorker: true,
    serviceBinding: "INTEGRATION_RAINDROP",
  },
  {
    name: "withmarfa.inbox",
    dirName: "withmarfa-inbox",
    triggers: ["webhook"],
    hasWorker: true,
    serviceBinding: "INTEGRATION_MYMEHQ_INBOX",
    webhookQueueBinding: "WEBHOOK_RECEIPT_QUEUE_MYMEHQ_INBOX",
  },
  {
    name: "withmarfa.sync",
    dirName: "sync",
    triggers: ["manual"],
    hasWorker: false,
    // No `serviceBinding` — local-substrate only, no deployed Worker.
  },
];

/** Resolve a registry entry by manifest name (`google.calendar`). */
export function findIntegration(name: string): InTreeIntegration | undefined {
  return IN_TREE_INTEGRATIONS.find((i) => i.name === name);
}

/** Resolve a registry entry by directory name (`google-calendar`). */
export function findIntegrationByDir(
  dirName: string,
): InTreeIntegration | undefined {
  return IN_TREE_INTEGRATIONS.find((i) => i.dirName === dirName);
}

/** All integrations that declare the given trigger type. */
export function integrationsWithTrigger(
  triggerType: IntegrationTriggerType,
): InTreeIntegration[] {
  return IN_TREE_INTEGRATIONS.filter((i) => i.triggers.includes(triggerType));
}

/** All integrations that deploy as Cloudflare Workers. */
export function deployedWorkers(): InTreeIntegration[] {
  return IN_TREE_INTEGRATIONS.filter((i) => i.hasWorker);
}

/** Scheduled-poll queue slug for an integration. Falls back to
 *  `dirName` when no override is declared. */
export function scheduledPollSlugFor(integration: InTreeIntegration): string {
  return integration.scheduledPollQueueSlug ?? integration.dirName;
}
