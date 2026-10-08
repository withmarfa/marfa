/**
 * Human names for the permissions, in the two shapes the surfaces need.
 *
 * One home because three surfaces read them — the consent screen, the
 * device-approval screen, and the security page's revoke line — and a
 * permission whose name differs between the screen that grants it and the
 * screen that revokes it is worse than one with no name at all.
 *
 * Both maps are keyed on `Permission` rather than `string`, so adding a
 * permission fails to compile until it has been named in both. That is
 * the only guard that matters here: the fallback these replace is
 * `humanizeType`, which takes the last dotted segment, so an unnamed
 * `webhooks.manage` renders as "Webhooks", which reads as a kind of content
 * rather than the power to point a new webhook anywhere, on the one screen
 * where a person decides whether to hand that power over.
 */
import type { Permission } from "@withmarfa/shared";
import { isPermission } from "@withmarfa/shared";

/**
 * Consent-toggle labels: a full verb phrase, because the row is a thing the
 * person is deciding to hand over rather than a category of content, and a
 * noun reads as the latter.
 */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "keys.manage": "See, narrow and revoke any API key",
  "blobs.manage": "Read all files and manage their stored copies",
  "connectors.manage":
    "Manage all connectors and their incoming data endpoints",
  "instance.maintain":
    "Run maintenance that can permanently delete eligible data",
  "instance.read": "Read server health, storage and maintenance reports",
  "webhooks.manage": "Set up webhooks that send your data elsewhere",
  "schema.write": "Replace and remove definitions of the types it can write",
  "config.manage": "Read and change the server configuration",
  "audit.read": "Read your security history",
  "items.purge": "Permanently delete things, past the trash",
  "keys.mint": "Create and revoke API keys",
  "grants.manage": "See and revoke the other apps you have connected",
};

/**
 * Inline-list forms, for a sentence naming several at once.
 *
 * Lower case and comma-free, because these are joined into a list and a
 * label carrying its own comma turns one item into two. Kept beside the
 * toggle labels rather than derived from them: the transformation that would
 * produce these is a lowercase plus a comma strip, which quietly mangles the
 * entries where the comma is load-bearing.
 */
export const PERMISSION_SHORT: Record<Permission, string> = {
  "keys.manage": "view key details and narrow or revoke any key",
  "blobs.manage": "read all files and manage their stored copies",
  "connectors.manage":
    "manage all connectors and their incoming data endpoints",
  "instance.maintain":
    "run maintenance that can permanently delete eligible data",
  "instance.read": "read detailed server reports",
  "webhooks.manage": "set up webhooks that send your data elsewhere",
  "schema.write": "replace and remove definitions of the types it can write",
  "config.manage": "read and change the server configuration",
  "audit.read": "read your security history",
  "items.purge": "permanently delete things past the trash",
  "keys.mint": "create and revoke API keys",
  "grants.manage": "revoke the other apps you have connected",
};

/** The consent-toggle label for a literal, or undefined when it names no
 *  permission. A guard rather than a cast, so a literal outside the set
 *  cannot be asserted into a lookup that has no entry for it. */
export function permissionLabel(literal: string): string | undefined {
  return isPermission(literal) ? PERMISSION_LABELS[literal] : undefined;
}

/** The inline-list form for a literal, or undefined when it names no
 *  permission. */
export function permissionShort(literal: string): string | undefined {
  return isPermission(literal) ? PERMISSION_SHORT[literal] : undefined;
}
