/**
 * Human names for the space permissions, in the two shapes the surfaces need.
 *
 * One home because three surfaces read them — the consent screen, the
 * device-approval screen, and the security page's revoke line — and a space
 * permission whose name differs between the screen that grants it and the
 * screen that revokes it is worse than one with no name at all.
 *
 * Both maps are keyed on `SpacePermission` rather than `string`, so adding a
 * space permission fails to compile until it has been named in both. That is
 * the only guard that matters here: the fallback these replace is
 * `humanizeType`, which takes the last dotted segment, so an unnamed
 * `webhooks.manage` renders as "Webhooks" — byte-identical to what
 * `system.webhook:read` gets from the same fallback. One grant is sight of a
 * webhook row and the other is the power to point a new webhook anywhere, and
 * the one place a person inspects that difference would show none.
 */
import type { SpacePermission } from "@withmarfa/shared";
import { isSpacePermission } from "@withmarfa/shared";

/**
 * Consent-toggle labels: a full verb phrase, because the row is a thing the
 * person is deciding to hand over rather than a category of content, and a
 * noun reads as the latter.
 */
export const SPACE_PERMISSION_LABELS: Record<SpacePermission, string> = {
  "webhooks.manage": "Set up webhooks that send your data elsewhere",
  "schema.write": "Change and remove your type definitions",
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
export const SPACE_PERMISSION_SHORT: Record<SpacePermission, string> = {
  "webhooks.manage": "set up webhooks that send your data elsewhere",
  "schema.write": "change your type definitions",
  "config.manage": "read and change the server configuration",
  "audit.read": "read your security history",
  "items.purge": "permanently delete things past the trash",
  "keys.mint": "create and revoke API keys",
  "grants.manage": "revoke the other apps you have connected",
};

/** The consent-toggle label for a literal, or undefined when it names no
 *  space permission. A guard rather than a cast, so a literal outside the set
 *  cannot be asserted into a lookup that has no entry for it. */
export function spacePermissionLabel(literal: string): string | undefined {
  return isSpacePermission(literal)
    ? SPACE_PERMISSION_LABELS[literal]
    : undefined;
}

/** The inline-list form for a literal, or undefined when it names no
 *  space permission. */
export function spacePermissionShort(literal: string): string | undefined {
  return isSpacePermission(literal)
    ? SPACE_PERMISSION_SHORT[literal]
    : undefined;
}
