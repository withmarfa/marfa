/**
 * The one place this SDK tells `oauth4webapi` to talk to a non-HTTPS
 * endpoint, so the reasoning lives once rather than at each call.
 *
 * The library refuses plain http by default and is right to: for a
 * public client on the open web, an http token endpoint is a downgrade
 * attack, not a configuration choice. Marfa's case is the narrow
 * exception the default cannot see. Self-hosted instances run over plain
 * http on a LAN or a Tailscale host — the same deployment shape that
 * makes the hand-written SHA-256 in `sha256.ts` necessary, because a
 * browser withholds `crypto.subtle` on exactly those origins. Refusing
 * would rule out a supported configuration rather than catch a mistake.
 *
 * What bounds the risk is where the URL comes from. The issuer is the
 * application's own configuration, fixed at construction; it is never
 * taken from a redirect, a discovery document, or any other value an
 * attacker gets to choose. So this widens what a deployer may point the
 * SDK at, and nothing about what a third party can point it at.
 *
 * The upstream option carries a deprecation tag. That is upstream making
 * it conspicuous — its own note says "to make it stand out as something
 * you shouldn't use" — rather than scheduling removal, and there is no
 * replacement to migrate to.
 */
import { allowInsecureRequests } from "oauth4webapi";

/** Spread into any `oauth4webapi` request options. */
export const ALLOW_INSECURE_HTTP = {
  [allowInsecureRequests]: true,
} as const;
