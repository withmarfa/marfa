/**
 * Human names for the capability scopes, in the two shapes the surfaces need.
 *
 * One home because three surfaces read them — the consent screen, the
 * device-approval screen, and the security page's revoke line — and a
 * capability whose name differs between the screen that grants it and the
 * screen that revokes it is worse than one with no name at all.
 *
 * Both maps are keyed on `CapabilityScope` rather than `string`, so adding a
 * capability fails to compile until it has been named in both. That is the
 * only guard that matters here: the fallback these replace is
 * `humanizeType`, which takes the last dotted segment, so an unnamed
 * `capability.webhooks` renders as "Webhooks" — byte-identical to what
 * `system.webhook:read` gets from the same fallback. One grant is sight of a
 * webhook row and the other is the power to point a new webhook anywhere,
 * and the one place a person inspects that difference would show none.
 */
import type { CapabilityScope } from "@withmarfa/shared";
import { isCapabilityScope } from "@withmarfa/shared";

/**
 * Consent-toggle labels: a full verb phrase, because the row is a thing the
 * person is deciding to hand over rather than a category of content, and a
 * noun reads as the latter.
 */
export const CAPABILITY_LABELS: Record<CapabilityScope, string> = {
  "capability.webhooks": "Set up webhooks that send your data elsewhere",
  "capability.connections":
    "Connect services, and decide what each one can reach",
  "capability.upstream_access":
    "Use your connected accounts directly, with everything they can do",
  "capability.credentials":
    "Register and remove the sign-in details your connections use",
  "capability.schema": "Change and remove your type definitions",
  "capability.space_usage": "See how much of your space is used",
  "capability.space_settings": "Change your space settings",
  "capability.audit_read": "Read your security history",
  "capability.item_purge": "Permanently delete things, past the trash",
  "capability.keys": "Create and revoke API keys",
  "capability.app_grants": "See and revoke the other apps you have connected",
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
export const CAPABILITY_SHORT: Record<CapabilityScope, string> = {
  "capability.webhooks": "set up webhooks that send your data elsewhere",
  "capability.connections": "connect and disconnect services",
  "capability.upstream_access":
    "use your accounts at connected services directly",
  "capability.credentials": "hold the sign-in details behind your connections",
  "capability.schema": "change your type definitions",
  "capability.space_usage": "see how much of your space is used",
  "capability.space_settings": "change your space settings",
  "capability.audit_read": "read your security history",
  "capability.item_purge": "permanently delete things past the trash",
  "capability.keys": "create and revoke API keys",
  "capability.app_grants": "revoke the other apps you have connected",
};

/** The consent-toggle label for a literal, or undefined when it names no
 *  capability. A guard rather than a cast, so a literal outside the set
 *  cannot be asserted into a lookup that has no entry for it. */
export function capabilityLabel(literal: string): string | undefined {
  return isCapabilityScope(literal) ? CAPABILITY_LABELS[literal] : undefined;
}

/** The inline-list form for a literal, or undefined when it names no
 *  capability. */
export function capabilityShort(literal: string): string | undefined {
  return isCapabilityScope(literal) ? CAPABILITY_SHORT[literal] : undefined;
}
