/**
 * The four kinds the audit log's `kind` filter sorts every entry into, from
 * the entry's `action`. An action is a family and what happened, such as
 * `key.create`; the family decides the kind, except for the actions Marfa
 * writes on its own, which are housekeeping whatever their family, and
 * `blob.stores_configured`, a setting. An action in none of these is data.
 */

export const AUDIT_KINDS = [
  "access",
  "data",
  "settings",
  "housekeeping",
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

/** Actions written by Marfa's own upkeep, not by a request. */
export const HOUSEKEEPING_ACTIONS: readonly string[] = [
  "items.trash_purged",
  "items.feed_expired",
  "item.versions_thinned",
  "item.enrich",
  "auth.grants.purged",
  "auth.grant.retired",
  "auth.clients.purged",
  "keys.purged",
  "blob.purge",
  "blob.copy_struck",
  "blob.copy_dropped",
  "blob.copy_replicated",
];

/** Families of sign-ins, keys, folders and the profile. */
export const ACCESS_FAMILIES: readonly string[] = [
  "auth",
  "owner",
  "key",
  "keys",
  "instance",
  "profile",
  "folder",
];

/** Families of how Marfa is set up and what it connects to. */
export const SETTINGS_FAMILIES: readonly string[] = [
  "config",
  "webhook",
  "connector",
  "connector_state",
  "inbound_endpoint",
];

export const SETTINGS_ACTIONS: readonly string[] = ["blob.stores_configured"];

/** The most characters a search holds. */
export const AUDIT_SEARCH_MAX_LENGTH = 200;

/**
 * The words of a search, in the order written, with A to Z lowercased and
 * nothing else: SQLite's `lower()` folds only those, so both sides agree.
 */
export function auditSearchWords(q: string): string[] {
  return q
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .split(/\s+/)
    .filter(Boolean);
}

/** What `kind` means, for the contract and the API reference. */
export const AUDIT_KIND_WORDS = {
  access: "sign-ins, keys, folders and the profile",
  data: "items, edges, types, files and restores",
  settings: "configuration, webhooks and connectors",
  housekeeping: "what Marfa does on its own",
} as const satisfies Record<AuditKind, string>;
