/**
 * The integrations shipped in this monorepo, and the names they answer to.
 *
 * Two things need this table. The local runtime resolves each integration's
 * source directory from it, and — while the identifier rename is in flight —
 * dispatch resolves an integration by either of its two spellings.
 *
 * **Why two spellings exist at all.** Dispatch routes by manifest name, but a
 * connection resolves the manifest *frozen on its catalog row* rather than
 * the one in the running build. Those move in separate steps, so for the
 * length of the rename one integration is legitimately known by two names.
 * Anything matching on the name has to accept both, or dispatch stops with no
 * error and no activity row.
 *
 * The correspondence cannot be derived. `readwise.reader` to `readwise/reader`
 * is punctuation, but the first-party set changes publisher too
 * (`withmarfa.podcasts` to `marfa/podcasts`), so it is written down.
 *
 * `legacyName` is temporary by construction: it goes when every stored name
 * has moved, and `integrationNameSpellings` goes with it.
 *
 * For npm consumers of `@withmarfa/shared` this is implementation detail; the
 * tree-shaker drops the table for anyone who does not reference it.
 */

export interface InTreeIntegration {
  /** Manifest `name` under the integration-identifier grammar,
   *  `<handle>/<name>` (e.g. `google/calendar`). */
  name: string;
  /** The dot-form name this integration shipped under before the rename.
   *  Present until every catalog row and every stored provenance string
   *  carries `name` instead. */
  legacyName?: string;
  /** Directory under `integrations/` holding this integration's source. */
  dirName: string;
}

export const IN_TREE_INTEGRATIONS: readonly InTreeIntegration[] = [
  {
    name: "marfa/podcasts",
    legacyName: "withmarfa.podcasts",
    dirName: "podcasts",
  },
  {
    name: "marfa/rss-watcher",
    legacyName: "withmarfa.rss-watcher",
    dirName: "rss-watcher",
  },
  {
    name: "marfa/github-webhooks",
    legacyName: "withmarfa.github-webhooks",
    dirName: "github-webhooks",
  },
  {
    name: "marfa/task-auto-archive",
    legacyName: "withmarfa.task-auto-archive",
    dirName: "task-auto-archive",
  },
  {
    name: "marfa/inbox",
    legacyName: "withmarfa.inbox",
    dirName: "inbox",
  },
  { name: "marfa/sync", legacyName: "withmarfa.sync", dirName: "sync" },
  {
    name: "google/calendar",
    legacyName: "google.calendar",
    dirName: "google-calendar",
  },
  { name: "google/tasks", legacyName: "google.tasks", dirName: "google-tasks" },
  { name: "google/drive", legacyName: "google.drive", dirName: "google-drive" },
  {
    name: "google/contacts",
    legacyName: "google.contacts",
    dirName: "google-contacts",
  },
  {
    name: "google/youtube",
    legacyName: "google.youtube",
    dirName: "google-youtube",
  },
  { name: "todoist/tasks", legacyName: "todoist.tasks", dirName: "todoist" },
  {
    name: "readwise/highlights",
    legacyName: "readwise.highlights",
    dirName: "readwise",
  },
  {
    name: "readwise/reader",
    legacyName: "readwise.reader",
    dirName: "readwise-reader",
  },
  {
    name: "raindrop/bookmarks",
    legacyName: "raindrop.bookmarks",
    dirName: "raindrop",
  },
];

/** Resolve a registry entry by manifest name, in either spelling. */
export function findIntegration(name: string): InTreeIntegration | undefined {
  return IN_TREE_INTEGRATIONS.find(
    (i) => i.name === name || i.legacyName === name,
  );
}

/** Resolve a registry entry by directory name (`google-calendar`). */
export function findIntegrationByDir(
  dirName: string,
): InTreeIntegration | undefined {
  return IN_TREE_INTEGRATIONS.find((i) => i.dirName === dirName);
}

/**
 * The canonical spelling of an integration name.
 *
 * For code comparing a manifest name against a literal. A connection's frozen
 * manifest can carry the old spelling while the running build carries the new
 * one, so a bare `===` against either is wrong for the length of the rename.
 * An unknown name is returned unchanged, so a third-party integration compares
 * as itself.
 */
export function canonicalIntegrationName(name: string): string {
  return findIntegration(name)?.name ?? name;
}

/**
 * Every spelling one integration answers to, canonical first.
 *
 * Used wherever a stored name meets a running build: the runtime's by-name
 * registration lookup is the one that matters, because a miss there is a
 * silent skip rather than an error. An unknown name answers for itself only,
 * so a third-party integration is unaffected.
 */
export function integrationNameSpellings(name: string): string[] {
  const entry = findIntegration(name);
  if (!entry) return [name];
  return entry.legacyName ? [entry.name, entry.legacyName] : [entry.name];
}
