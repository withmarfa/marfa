/**
 * Human names for the four OIDC literals.
 *
 * Keyed on the literal union rather than on `string`, so a literal added to
 * `OidcScope` fails to compile until it has a name here, as
 * `permission-labels.ts` does for permissions.
 *
 * `profile` returns `name` and `picture` and nothing else: the claim set is
 * built in `auth/oauth-provider.ts`, where `customIdTokenClaims` and
 * `customUserInfoClaims` gate on those scopes. A name here says no more.
 */
import type { OidcScope } from "@withmarfa/shared";

/**
 * A row's title: a noun phrase for what the application receives, because
 * the row sits beside a switch and names a thing rather than an act.
 *
 * `openid` and `offline_access` are mechanisms, which neither approval page
 * shows; they are named because the map's type requires every literal.
 */
export const OIDC_LABELS: Record<OidcScope, string> = {
  openid: "Confirm your identity",
  // Both halves, because both are what the scope returns. Saying only "Your
  // name" understates it and the entry this replaces said so; saying
  // "username, name, bio, and avatar" overstates it and the other entry
  // this replaces said that.
  profile: "Your name and picture",
  email: "Your email address",
  offline_access: "Stay signed in",
};

/**
 * Whether a literal is one this build has copy for.
 *
 * Derived from the copy itself rather than from a separate list, so the two
 * questions — is this an OIDC literal, and do we have words for it — cannot
 * drift apart. A second list is what this file exists to delete.
 */
function isOidcLiteral(literal: string): literal is OidcScope {
  return Object.prototype.hasOwnProperty.call(OIDC_LABELS, literal);
}

/** The row title for a literal, or undefined when it names no
 *  OIDC scope. A guard rather than a cast, so a literal outside the set
 *  cannot be asserted into a lookup that has no entry for it. */
export function oidcLabel(literal: string): string | undefined {
  return isOidcLiteral(literal) ? OIDC_LABELS[literal] : undefined;
}
