/**
 * Human names for the four OIDC literals, in the two shapes the surfaces
 * need.
 *
 * Five maps described these same four literals across four files, and while
 * two pairs of entries happened to be byte-identical, no two maps agreed as
 * a whole. `profile` was, depending on which one you reached, "See your name
 * and profile picture.", "Your username, name, bio, and avatar", "Your name"
 * and "See your basic profile". Two of the five even shared the identifier
 * `OIDC_SCOPE_DESCRIPTIONS`, in different files.
 *
 * **One of them was not a wording difference. It was false.** A map in
 * `auth-pages.ts` said granting `profile` lets an application see a person's
 * "username, name, bio, and avatar". `profile` returns `name` and `picture`
 * and nothing else — the claim set is built in `auth/oauth-provider.ts`,
 * where `customIdTokenClaims` and `customUserInfoClaims` gate on exactly
 * those two scopes.
 *
 * **No screen ever rendered it**, because the device renderer had its own
 * map and reached this one's output for OIDC literals nowhere. That is worth
 * stating precisely rather than leaving as an implied near-miss: the string
 * was false and unreachable, and the danger was that the next person to wire
 * that path would have shipped it believing it had been reviewed.
 *
 * **Only one of the five carried `offline_access`.** That one is why a
 * device-approval screen once showed somebody the raw literal sitting
 * between two English sentences.
 *
 * Both maps here are keyed on the literal union rather than on `string`, so
 * a literal added to `OidcScope` fails to compile until it has been named in
 * both. That is the guard `capability-labels.ts` next door already uses for
 * the same reason, and the one the five maps this replaces did not have.
 *
 * Two shapes rather than one, because a toggle row and a prose summary want
 * opposite things from the same string. "Your name" is right above a switch
 * and wrong in the middle of a sentence. A third register was written and
 * deleted in the same change: nothing read it, on either surface.
 */
import type { OidcScope } from "@withmarfa/shared";

/**
 * Consent-toggle labels: a noun phrase for what the application receives,
 * because the row sits above a switch and names a thing rather than an act.
 *
 * `openid` and `offline_access` are mechanisms rather than data and carry no
 * toggle on the consent screen (`HIDDEN_MECHANISM_SCOPES` removes them), but
 * the device-approval screen lists every scope it was asked for, so they are
 * named here rather than left to a fallback that would print the literal.
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
 * Inline-list forms, for the generated sentence on the consent screen.
 *
 * Lower case and comma-free. `summarize` joins these into one sentence and
 * capitalizes whatever ends up first, so a capital here lands mid-clause and
 * a comma turns one item into two.
 */
export const OIDC_SHORT: Record<OidcScope, string> = {
  openid: "confirm your identity",
  // "your name", not "your name and picture", and the difference is the
  // register rather than the facts. These are joined into one sentence with
  // "and" between the last two, so an item carrying its own conjunction
  // produces "your name and picture and your email address" — the same
  // defect the comma rule below exists to prevent, one word along. The
  // picture is on the toggle label and in the description, which is where
  // somebody deciding actually reads it; this is a summary and it
  // understates rather than misleads.
  profile: "your name",
  email: "your email address",
  offline_access: "stay signed in",
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

/** The consent-toggle label for a literal, or undefined when it names no
 *  OIDC scope. A guard rather than a cast, so a literal outside the set
 *  cannot be asserted into a lookup that has no entry for it. */
export function oidcLabel(literal: string): string | undefined {
  return isOidcLiteral(literal) ? OIDC_LABELS[literal] : undefined;
}

/** The inline-list form for a literal, or undefined when it names no OIDC
 *  scope. */
export function oidcShort(literal: string): string | undefined {
  return isOidcLiteral(literal) ? OIDC_SHORT[literal] : undefined;
}
