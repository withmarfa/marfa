/**
 * The integrations shipped in this monorepo, and where their source lives.
 *
 * The local runtime resolves each integration's source directory from this
 * table. The mapping cannot be derived — a manifest name carries a publisher
 * handle (`marfa/podcasts`) while the directory does not (`podcasts`) — so it
 * is written down.
 *
 * For npm consumers of `@withmarfa/shared` this is implementation detail; the
 * tree-shaker drops the table for anyone who does not reference it.
 */

export interface InTreeIntegration {
  /** Manifest `name` under the integration-identifier grammar,
   *  `<handle>/<name>` (e.g. `google/calendar`). */
  name: string;
  /** Directory under `integrations/` holding this integration's source. */
  dirName: string;
}

export const IN_TREE_INTEGRATIONS: readonly InTreeIntegration[] = [
  {
    name: "marfa/podcasts",
    dirName: "podcasts",
  },
  {
    name: "marfa/rss-watcher",
    dirName: "rss-watcher",
  },
  {
    name: "marfa/github-webhooks",
    dirName: "github-webhooks",
  },
  {
    name: "marfa/task-auto-archive",
    dirName: "task-auto-archive",
  },
  {
    name: "marfa/inbox",
    dirName: "inbox",
  },
  { name: "marfa/sync", dirName: "sync" },
  {
    name: "google/calendar",
    dirName: "google-calendar",
  },
  { name: "google/tasks", dirName: "google-tasks" },
  { name: "google/drive", dirName: "google-drive" },
  {
    name: "google/contacts",
    dirName: "google-contacts",
  },
  {
    name: "google/youtube",
    dirName: "google-youtube",
  },
  { name: "todoist/tasks", dirName: "todoist" },
  {
    name: "readwise/highlights",
    dirName: "readwise",
  },
  {
    name: "readwise/reader",
    dirName: "readwise-reader",
  },
  {
    name: "raindrop/bookmarks",
    dirName: "raindrop",
  },
];

/** Resolve a registry entry by manifest name. */
export function findIntegration(name: string): InTreeIntegration | undefined {
  return IN_TREE_INTEGRATIONS.find((i) => i.name === name);
}

/** Resolve a registry entry by directory name (`google-calendar`). */
export function findIntegrationByDir(
  dirName: string,
): InTreeIntegration | undefined {
  return IN_TREE_INTEGRATIONS.find((i) => i.dirName === dirName);
}
