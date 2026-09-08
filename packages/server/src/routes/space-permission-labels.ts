/**
 * Human names for the capability scopes, in the two shapes the surfaces need.
 *
 * One home because three surfaces read them — the consent screen, the
 * device-approval screen, and the security page's revoke line — and a
 * capability whose name differs between the screen that grants it and the
 * screen that revokes it is worse than one with no name at all.
 *
 * Both maps are keyed on `SpacePermission` rather than `string`, so adding a
 * capability fails to compile until it has been named in both. That is the
 * only guard that matters here: the fallback these replace is
 * `humanizeType`, which takes the last dotted segment, so an unnamed
 * `space.webhooks` renders as "Webhooks" — byte-identical to what
 * `system.webhook:read` gets from the same fallback. One grant is sight of a
 * webhook row and the other is the power to point a new webhook anywhere,
 * and the one place a person inspects that difference would show none.
 */
import type { SpacePermission } from "@withmarfa/shared";
import { isSpacePermission } from "@withmarfa/shared";

/**
 * Consent-toggle labels: a full verb phrase, because the row is a thing the
 * person is deciding to hand over rather than a category of content, and a
 * noun reads as the latter.
 */
export const SPACE_PERMISSION_LABELS: Record<SpacePermission, string> = {
  "space.webhooks": "Set up webhooks that send your data elsewhere",
  "space.connections": "Connect services, and decide what each one can reach",
  "space.upstream_access":
    "Use your connected accounts directly, with everything they can do",
  "space.credentials":
    "Register and remove the sign-in details your connections use",
  "space.schema": "Change and remove your type definitions",
  "space.usage": "See how much of your space is used",
  "space.settings": "Change your space settings",
  "space.audit_read": "Read your security history",
  "space.item_purge": "Permanently delete things, past the trash",
  "space.keys": "Create and revoke API keys",
  "space.app_grants": "See and revoke the other apps you have connected",
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
  "space.webhooks": "set up webhooks that send your data elsewhere",
  "space.connections": "connect and disconnect services",
  "space.upstream_access": "use your accounts at connected services directly",
  "space.credentials": "hold the sign-in details behind your connections",
  "space.schema": "change your type definitions",
  "space.usage": "see how much of your space is used",
  "space.settings": "change your space settings",
  "space.audit_read": "read your security history",
  "space.item_purge": "permanently delete things past the trash",
  "space.keys": "create and revoke API keys",
  "space.app_grants": "revoke the other apps you have connected",
};

/** The consent-toggle label for a literal, or undefined when it names no
 *  capability. A guard rather than a cast, so a literal outside the set
 *  cannot be asserted into a lookup that has no entry for it. */
export function spacePermissionLabel(literal: string): string | undefined {
  return isSpacePermission(literal)
    ? SPACE_PERMISSION_LABELS[literal]
    : undefined;
}

/** The inline-list form for a literal, or undefined when it names no
 *  capability. */
export function spacePermissionShort(literal: string): string | undefined {
  return isSpacePermission(literal)
    ? SPACE_PERMISSION_SHORT[literal]
    : undefined;
}
