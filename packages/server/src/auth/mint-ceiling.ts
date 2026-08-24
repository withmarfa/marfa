/**
 * The credential-minting invariant, stated once:
 *
 * No minting path may issue a credential whose authority exceeds, on any
 * axis, the authority of the principal or governing declaration that
 * authorized the mint — role at or below the caller's rank
 * (`canGrantRole`); `is_platform` only from a platform caller; space
 * binding inherited from the caller or the resource being minted for,
 * never chosen by the request and never absent on a hosted deployment;
 * and permission or scope breadth at or below the caller's own grant,
 * the governing manifest, or the explicitly requested scope set. The
 * one-shot bootstrap seed is the sole stated exception.
 *
 * Enforcement lives where each axis is checked — `canGrantRole` at
 * `POST /keys`, the platform clamp there too, `assertMintableSpaceScope`
 * on the runtime-credential paths, `manifest-permissions.ts` for their
 * breadth — but the CEILING VALUES for the paths that are configuration
 * rather than code live here, so the plugin options and the DCR mirror
 * cannot drift apart. `routes/credential-mint-doors.test.ts` is the
 * guard that fails when a new way of asking appears without a stated
 * ceiling.
 */

import { expandBundlesToScopes } from "@withmarfa/shared";
import { getPermissionBundles } from "../config.js";

/**
 * What a `client_credentials` token gets when the request names no scope
 * and the client registered none: nothing. The grant has no user, so no
 * consent screen ever reviews it — a machine client states what it needs
 * or receives a credential with no data-plane reach. Falling back to the
 * full allowlist here handed an anonymous-registered client `*:write`.
 */
export const CLIENT_CREDENTIALS_DEFAULT_SCOPES: string[] = [];

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
  // not arrive that way: its whole meaning is that a person ticked it. The
  // union used to include them, so an off-by-default bundle landed in every
  // anonymously-registered client's ceiling automatically, which is the
  // ceiling the device flow then measures a request against. A client that
  // genuinely wants one names it at registration.
  const bundles = getPermissionBundles().filter((b) => b.default_on);
  return withSessionScopes(expandBundlesToScopes(bundles));
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
