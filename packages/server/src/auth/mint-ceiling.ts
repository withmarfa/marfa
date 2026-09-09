/**
 * The credential-minting invariant, stated once:
 *
 * No minting path may issue a credential whose authority exceeds, on any
 * axis, the authority of the principal or governing declaration that
 * authorized the mint — space permissions at or below the creator's own
 * set; `is_operator` only from an operator caller, and only for another
 * operator key; space binding inherited from the caller or the resource
 * being minted for, never chosen by the request and never absent on a
 * hosted deployment; and content breadth at or below the caller's own
 * grant, the governing manifest, or the explicitly requested scope set.
 * The three seeds the design names are the stated exceptions, because no
 * creator set exists above them to be bounded by.
 *
 * Enforcement lives where each axis is checked — the creator ceiling and
 * the operator rule at `POST /keys`, `assertMintableSpaceScope` on the
 * runtime-credential paths, `manifest-permissions.ts` for their
 * breadth — but the CEILING VALUES for the paths that are configuration
 * rather than code live here, so the plugin options and the DCR mirror
 * cannot drift apart. `routes/credential-mint-doors.test.ts` is the
 * guard that fails when a new way of asking appears without a stated
 * ceiling.
 */

import { isValidScope } from "@withmarfa/shared";
import { getPermissionBundles } from "../config.js";
import { publishableBundleScopes } from "./allowlist-withholding.js";

/**
 * What a `client_credentials` token gets when the request names no scope
 * and the client registered none: nothing. The grant has no user, so no
 * consent screen ever reviews it — a machine client states what it needs
 * or receives a credential with no data-plane reach. Falling back to the
 * full allowlist here handed an anonymous-registered client `*:write`.
 */
export const CLIENT_CREDENTIALS_DEFAULT_SCOPES: string[] = [];

/**
 * The four literals the OAuth plugin treats as delegated by a person, and
 * therefore refuses on the `client_credentials` grant (verified in
 * `@better-auth/oauth-provider@1.7.1`, `isUserDelegatedScope`).
 *
 * Restated here rather than imported because the plugin does not export it,
 * and the copy is load-bearing in one direction only: a literal this set
 * misses is one a machine ceiling would carry and the token endpoint would
 * then refuse, which fails at the mint rather than silently.
 */
const USER_DELEGATED_SCOPES: ReadonlySet<string> = new Set([
  "openid",
  "profile",
  "email",
  "offline_access",
]);

/**
 * The ceiling on a machine client: what the person registering it holds.
 *
 * **Today that is everything grantable in their space**, because the first
 * person in a space holds everything and an account belongs to exactly one
 * space. It is written as a clamp against a stated set rather than as "the
 * check would pass, so skip it", for the reason the one model states the rule
 * at all: the day a person holds less than their whole space, this is the
 * line that has to narrow, and a clamp nobody wrote is a clamp nobody will
 * find.
 *
 * The user-delegated literals are out of it whatever the person holds. They
 * name a session and a machine grant has none, so a ceiling carrying one is a
 * ceiling the token endpoint will refuse to spend.
 */
export function machineClientCeiling(held: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const scope of held) {
    if (USER_DELEGATED_SCOPES.has(scope)) continue;
    out.add(scope);
  }
  return out;
}

/**
 * The scopes that carry a session rather than data: `openid` mints the
 * id_token a sign-out needs, `offline_access` the refresh token a client
 * needs to stay signed in without asking again.
 *
 * They belong in every registered ceiling because they reach no user
 * content — a consent screen shows nothing for them — while their absence
 * is unrecoverable. A client cannot amend its own registration, so a
 * ceiling minted without them refuses the client's first authorize for a
 * literal it was never told to name, and the CLI persists its `client_id`,
 * so the refusal survives every retry.
 *
 * Also the set the authorize hook refuses to narrow away, so a request for
 * one is answered rather than silently dropped: `oauth-provider.ts`.
 */
export const SESSION_CRITICAL_SCOPES: readonly string[] = [
  "openid",
  "offline_access",
];

/**
 * What a dynamic client registration gets when it omits `scope`: the
 * configured bundle expansion — the instance-wide curated set — rather
 * than the entire allowlist, plus the session scopes above. Wider scopes
 * (the global wildcards, metadata, edge grants) stay requestable,
 * explicitly, and so do a space's runtime handle namespaces: a hosted
 * consent screen derives those per space at render, so this ceiling is
 * deliberately narrower than what a consent screen may present. A client
 * that wants a handle namespace names it at registration; a generic
 * registration does not silently inherit reach into namespaces it never
 * asked for.
 */
export function dcrDefaultScopes(): string[] {
  // On-by-default bundles only. This is what a registration gets for naming
  // nothing, and a bundle declaring itself off is precisely one that should
  // not arrive that way: its whole meaning is that a person ticked it. A
  // client registered with nobody present therefore reaches only what is
  // offered by default, and that ceiling is what the device flow measures a
  // request against. A client that genuinely wants an off-by-default bundle
  // names it at registration.
  //
  // **The third bundle door, and it has to apply the same drop as the other
  // two.** `publishableBundleScopes` exists because a drop applied at one
  // door and not another is the defect it closes, and this one read the
  // bundles raw. That was invisible while space permissions were
  // unpublishable — the registration validated its own defaults against an
  // allowlist holding none, so an operator bundle naming one made every
  // anonymous registration fail `invalid_scope`, loudly. With the family
  // published the check passes instead, and the literal is written into a
  // stored client row that outlives the configuration that introduced it.
  // Loud became silent, which is the direction that matters.
  const bundles = getPermissionBundles().filter((b) => b.default_on);
  return withSessionScopes(
    publishableBundleScopes(bundles, (scope) => isValidScope(scope)),
  );
}

/**
 * Admit the session scopes into a ceiling, preserving order and adding
 * nothing already present. Applied to an explicitly requested set too: a
 * registration naming one narrow type still has to be able to hold a
 * session, and admitting these widens no data reach.
 */
export function withSessionScopes(scopes: readonly string[]): string[] {
  const out = [...scopes];
  for (const scope of SESSION_CRITICAL_SCOPES) {
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

/**
 * A ceiling is read in two places and must mean the same thing in both.
 *
 * Admitting the session scopes at the point of READING one is tempting,
 * because it would repair a client whose ceiling was minted without them.
 * It does not work: on the authorize path the vendored plugin re-validates
 * the narrowed request against that same stored ceiling, so a scope this
 * side waved through is refused a moment later, and the refusal then names
 * `openid` instead of whatever the client actually over-asked for. A worse
 * error than the one it set out to prevent.
 *
 * So the rule lives at the mint, where it is enforceable, and both readers
 * stay a plain membership test against what the row says.
 */
