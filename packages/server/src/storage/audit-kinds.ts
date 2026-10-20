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

/** Families of sign-ins, accounts, keys, folders and the owner's profile. */
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

/** The most words and characters a search holds. */
export const AUDIT_SEARCH_MAX_LENGTH = 200;
export const AUDIT_SEARCH_MAX_WORDS = 8;

/** The words of a search, lowercased, in the order written, without the extras. */
export function auditSearchWords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, AUDIT_SEARCH_MAX_WORDS);
}

/** What `kind` means, for the contract and the API reference. */
export const AUDIT_KIND_WORDS = {
  access: "sign-ins, accounts, keys, folders and the owner's profile",
  data: "items, edges, types, extensions, files, exports and restores",
  settings: "configuration, webhooks and connectors",
  housekeeping: "what Marfa does on its own, such as clearing the trash",
} as const satisfies Record<AuditKind, string>;
