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
 * What a dynamic client registration gets when it omits `scope`: the
 * configured bundle expansion — exactly the set a consent screen would
 * present — rather than the entire allowlist. Wider scopes (the global
 * wildcards, metadata, edge grants) stay requestable, explicitly.
 */
export function dcrDefaultScopes(): string[] {
  return expandBundlesToScopes(getPermissionBundles());
}
