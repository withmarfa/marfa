/**
 * @better-auth/oauth-provider plugin wiring.
 *
 * The OAuth protocol surface is owned by the @better-auth/oauth-provider
 * plugin; endpoints land under `/auth/oauth2/*` via Better Auth's
 * catch-all (basePath `/auth`).
 *
 * Three coupled pieces in this file:
 *   1. `buildAllowedScopes(...)` — enumerates the Marfa scope grammar at
 *      instance-construction time from the type / edge registries so the
 *      plugin's allowlist accepts every concrete typed scope
 *      (`core.note:read`, `edge.parent-of:write`, …). Custom types
 *      registered at runtime require a server restart to surface
 *      (acceptable tradeoff; documented).
 *   2. `buildOauthProviderPlugin(...)` — constructs the plugin with
 *      opaque tokens hashed via Marfa's `hashApiKey(t, salt)`, the
 *      `marfa_at_` / `marfa_rt_` prefixes, space binding via
 *      `clientReference` + `postLogin.consentReferenceId`, and OIDC
 *      custom claims for profile + email + space_id.
 *   3. `buildOauthProjectionPlugin(...)` — the before-hook that
 *      defends against refresh-token replay by pre-emptively revoking
 *      access tokens when a stale refresh is detected.
 */

import { oauthProvider } from "@better-auth/oauth-provider";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { createHmac } from "node:crypto";
import {
  TYPE_REGISTRY,
  EDGE_TYPE_REGISTRY,
  expandBundlesToScopes,
  isValidScope,
} from "@withmarfa/shared";
import type { PermissionBundle } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { getPermissionBundles } from "../config.js";
import { deriveCustomTypeNamespaces } from "./default-bundles.js";
import {
  CLIENT_CREDENTIALS_DEFAULT_SCOPES,
  dcrDefaultScopes,
  SESSION_CRITICAL_SCOPES,
} from "./mint-ceiling.js";
import { log } from "../middleware/logger.js";
import {
  bundlePublishedScopes,
  catchUpClientScopeCeiling,
} from "./ceiling-catchup.js";
import { matchesRegisteredRedirectUri } from "./redirect-uri-match.js";
import { serverAddedResponseParam } from "./redirect-params.js";

/**
 * Minimal context shape we read off the `hooks.before` and `hooks.after`
 * matchers + handlers. Mirrors the slice of Better Auth's
 * `HookEndpointContext` we touch — `path` is widened to `string | undefined`
 * to match the library's type (some internal paths leave it unset), and
 * `method` and `authorizeSettings` are read only on the before side.
 */
interface HookCtxLite {
  path?: string;
  method?: string;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  /**
   * Set only when the provider re-enters its own authorize endpoint rather
   * than serving a request off the wire, and the marker that tells the two
   * apart. Declared here rather than described in prose because
   * {@link findAuthorizeRequest} reads it to reproduce the provider's own
   * parameter selection, and a field is harder to lose track of than a
   * comment.
   */
  authorizeSettings?: { isAuthorize?: boolean };
  context?: {
    session?: { user?: { id?: string } } | null;
    /** What the endpoint produced. On a redirect this is the thrown
     *  `APIError`-shaped object, whose `headers` carry the `Location`. */
    returned?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Scope enumeration
// ---------------------------------------------------------------------------

/**
 * Reserved metadata sub-resources for the `metadata.<sub>:<verb>` scope
 * grammar. Currently only `types` is enforced (gates `POST /types`); the
 * list grows as new metadata-layer mutations land. Mirrors what
 * `parseScope` in `@withmarfa/shared` recognizes.
 */
const METADATA_SUBRESOURCES = ["types", "edge_types"] as const;

/**
 * Namespaces whose members the static registry never enumerates: an app's
 * own runtime types (`user.*`, `app.*`) and the connected-service
 * namespaces. A type or edge type in one of these is registered per space
 * at runtime, so it does not exist when the allowed-scope set is built and
 * cannot be named concretely in a grant. The namespace wildcard is the only
 * thing that can name it, which is why these stay requestable while
 * deliberately staying out of the default consent bundle: the default grant
 * is the per-type-narrowable content set, and these appear only when an
 * app opts into them.
 *
 * Derived from the registry (`user` + `app` + every shipped publisher
 * root) rather than enumerated by hand — the hand list drifted the same
 * way the bundle lists did. Namespaces of custom types registered at
 * runtime reach the allowlist through {@link setRuntimeNamespaceRoots},
 * which boot installs from the `custom_types` table across every space.
 */
export function customTypeNamespaces(): readonly string[] {
  // Derived on call rather than at module load. The platform vocabulary is
  // seeded at boot, which happens after this module is evaluated, so a
  // constant computed here would describe the build's shipped set instead of
  // the set this instance actually holds — and a publisher root that arrived
  // by seed alone would be missing from the allowlist, narrowing away every
  // scope literal under it before consent could see one.
  return deriveCustomTypeNamespaces();
}

/**
 * Runtime custom-namespace roots admitted into the scope allowlist,
 * installed once at boot (same restart-re-enumeration model as the rest
 * of the allowlist). Spans every space deliberately: admission is not
 * disclosure. The allowlist only decides whether a requested literal can
 * survive to consent — which space's data a granted wildcard reaches is
 * decided per-token by the data plane, and every user-visible surface
 * (the consent screen's bundles, the advertised discovery metadata) stays
 * scoped to the consenting space or the instance baseline.
 */
let runtimeNamespaceRoots: readonly string[] = [];

/**
 * Install the runtime namespace roots {@link buildAllowedScopes} folds in.
 * Called at boot after storage is up, before the auth instance is built,
 * and by tests exercising the runtime-namespace path.
 */
export function setRuntimeNamespaceRoots(roots: readonly string[]): void {
  runtimeNamespaceRoots = roots;
}

/**
 * Build the complete list of scope literals the plugin will accept.
 * Includes OIDC literals + every concrete `<type>:<verb>` from the type
 * registry + every `edge.<edgeType>:<verb>` from the edge registry + the
 * metadata sub-resource grammar + the global type wildcards (`*:read` /
 * `*:write`, the "Customize" full-access path) + the runtime / connected-
 * service namespace wildcards (`user.*`, `app.*`, `google.*`, …) + every
 * grammatically valid scope referenced by a configured permission bundle.
 *
 * This is the set of scopes that CAN be requested, which is wider than the
 * default consent bundle (the curated, per-type content set). Custom types
 * registered at runtime via `POST /types` are NOT picked up as concrete
 * scopes — a server restart re-enumerates from the (now-larger) registry.
 * The namespace wildcards are how an app reaches its own `user.*` types
 * without that restart: the wildcard is granted, and matches whatever
 * `user.*` types exist at check time. The same applies to a space's own
 * publisher-handle namespaces, whose roots boot installs via
 * {@link setRuntimeNamespaceRoots}.
 */
export function buildAllowedScopes(
  permissionBundles: PermissionBundle[] = getPermissionBundles(),
  runtimeRoots: readonly string[] = runtimeNamespaceRoots,
): string[] {
  const out = new Set<string>([
    // OIDC literals
    "openid",
    "profile",
    "email",
    "offline_access",
    // Metadata top-level
    "metadata:read",
    "metadata:write",
    // The content category, the parent grant over everything a person
    // saves. Withheld until this build for one reason: both literals share
    // the type pattern `content`, which is the key both consent surfaces
    // resolve copy on, so the authorize screen rendered one identical toggle
    // for read and for write — and the device screen, which dedupes on the
    // resolved string, printed ONE row where two grants had been approved.
    // Writing a sentence would have taken the write level off that screen
    // rather than merely leaving it undescribed.
    //
    // Both halves are closed. A row label carries its operation, so the two
    // literals resolve different strings and neither screen folds one away;
    // and the pattern now has curated copy on both maps rather than falling
    // through to a title-cased fragment of itself.
    //
    // Requestable, and in no default bundle. An app opts into the category
    // the way it opts into `*:read` — deliberately, by name. The default
    // grant stays the curated per-type set, because a bundle reaching every
    // content type is a wider promise than any shipped bundle makes today
    // and is not a decision publishing the literal should make by itself.
    "content:read",
    "content:write",
    // Global type wildcards — full access, offered only via "Customize".
    "*:read",
    "*:write",
    // Core subtree wildcards — requestable for back-compat (an app that asks
    // for all content at once). The default bundle uses concrete per-type
    // scopes instead; a requested wildcard renders as a single toggle.
    "core.*:read",
    "core.*:write",
    // Runtime + connected-service namespace wildcards. These cover an app's
    // own `user.*` / `app.*` runtime types and the integration namespaces the
    // static registry never enumerates. They stay REQUESTABLE (an app can ask
    // for them explicitly) but are deliberately NOT in the default consent
    // bundle — the default grant is the curated, per-type-narrowable content
    // set, so these only appear when an app opts into them.
    ...customTypeNamespaces().flatMap((ns) => [
      `${ns}.*:read`,
      `${ns}.*:write`,
    ]),
    // Runtime publisher-handle roots, installed at boot. Same rationale as
    // the registry-derived set above; enumerated from the database rather
    // than the registry because a space's registrations live only there.
    ...runtimeRoots.flatMap((ns) => [`${ns}.*:read`, `${ns}.*:write`]),
  ]);

  // Item type scopes: `<typeId>:read|write` for every registered type.
  for (const typeId of TYPE_REGISTRY.keys()) {
    out.add(`${typeId}:read`);
    out.add(`${typeId}:write`);
  }

  // Edge type scopes: `edge.<edgeType>:read|write` for every edge type,
  // plus the `edge.*:read|write` wildcards.
  for (const edgeType of EDGE_TYPE_REGISTRY.keys()) {
    out.add(`edge.${edgeType}:read`);
    out.add(`edge.${edgeType}:write`);
  }
  out.add("edge.*:read");
  out.add("edge.*:write");

  // Namespace wildcards for edge types the static registry never
  // enumerates, for exactly the reason the item-type namespaces above
  // exist: a custom edge type is registered per space at runtime, so it
  // does not exist when this set is built and can never be named
  // concretely in a grant. Without these the only expressible scope for a
  // space's own relation edges is the global `edge.*`, which grants every
  // edge type on the instance — so an app asking narrowly was silently
  // narrowed to nothing and its relation writes were refused, while an app
  // asking for everything worked.
  for (const namespace of [...customTypeNamespaces(), ...runtimeRoots]) {
    out.add(`edge.${namespace}.*:read`);
    out.add(`edge.${namespace}.*:write`);
  }

  // Metadata sub-resource scopes.
  for (const sub of METADATA_SUBRESOURCES) {
    out.add(`metadata.${sub}:read`);
    out.add(`metadata.${sub}:write`);
  }

  // Every scope referenced by a configured bundle (namespace wildcards).
  //
  // Checked through the grammar rather than trusted, which the rest of this
  // function does not need to do: every literal above is assembled here from
  // a registry key, so it is well-formed by construction. A bundle's scopes
  // are configuration — the operator override parses arbitrary JSON — and
  // this loop is the only way into the allowlist that does not pass a
  // parser. A misspelled literal admitted here is requestable, survives
  // narrowing, and reaches a token as a grant nothing can enforce and
  // nothing will ever refuse, which is indistinguishable from working until
  // the day the name it was meant to be starts meaning something.
  for (const scope of expandBundlesToScopes(permissionBundles)) {
    if (!isValidScope(scope)) {
      warnOnceAboutBundleScope(scope);
      continue;
    }
    out.add(scope);
  }

  return Array.from(out).sort();
}

/**
 * Literals already reported, so a permanently misconfigured bundle costs one
 * log line rather than one per call. This runs on the discovery path, which
 * is per-request; a silent drop would be the wrong trade on a permission
 * question, and an unbounded repeat would be the wrong trade on a hot one.
 * The set is bounded by the configured bundles, not by request input.
 */
const reportedInvalidBundleScopes = new Set<string>();

function warnOnceAboutBundleScope(scope: string): void {
  if (reportedInvalidBundleScopes.has(scope)) return;
  reportedInvalidBundleScopes.add(scope);
  log("warn", "permission bundle names a scope the grammar rejects", {
    scope,
    action: "dropped from the OAuth scope allowlist",
  });
}

// ---------------------------------------------------------------------------
// Space resolution (auth_user.id → space_id via users table)
// ---------------------------------------------------------------------------

/**
 * Resolve a Better Auth user's space_id by joining through the `users`
 * table. Returns `undefined` in keys-mode (no users
 * table) or when the user has no space assigned yet.
 *
 * Used by:
 *   - `clientReference` at client-registration time
 *   - `customAccessTokenClaims` at token-issuance time
 *   - the consent after-hook when projecting `system.connection`
 */
export async function resolveSpaceIdForAuthUser(
  storage: Storage,
  authUserId: string,
): Promise<string | undefined> {
  if (!storage.users) return undefined;
  const user = await storage.users.getByAuthUserId(authUserId);
  return user?.space_id ?? undefined;
}

// ---------------------------------------------------------------------------
// Plugin construction
// ---------------------------------------------------------------------------

export interface OauthProviderOptions {
  /** Per-process API key salt — shared with the bearer middleware so
   *  `hashApiKey(token, salt)` returns identical output, letting the
   *  middleware look up `auth_oauth_access_token.token` directly. */
  apiKeySalt: string;
  /** The Storage handle. Threaded into clientReference + custom-claim
   *  callbacks and the grant-projection after-hooks. */
  storage: Storage;
  /** Base URL for the issuer (used in id_token claims). */
  baseURL: string;
}

/**
 * Same hash function the bearer middleware uses — keeps token validation
 * symmetric so a token-in-hand can be resolved to its `auth_oauth_access_token`
 * row by computing the same hash and looking up by primary key.
 */
function makeTokenHasher(salt: string) {
  return (token: string): string =>
    createHmac("sha256", salt).update(token).digest("hex");
}

/**
 * Construct the @better-auth/oauth-provider plugin with Marfa-specific
 * configuration. Used as one entry in the better-auth `plugins: [...]`
 * array in `instance.ts`.
 */
export function buildOauthProviderPlugin(opts: OauthProviderOptions) {
  const tokenHasher = makeTokenHasher(opts.apiKeySalt);
  const allowedScopes = buildAllowedScopes();

  return oauthProvider({
    // ----- Page wiring (Marfa-owned routes for both) -----
    loginPage: "/auth/sign-in",
    consentPage: "/auth/authorize",

    // ----- Dynamic client registration (RFC 7591) -----
    // `POST /auth/clients` is a public, no-auth endpoint for the
    // public-client model (PKCE replaces the client secret as the
    // binding). The plugin's deprecation note on unauthenticated DCR
    // is a future-watch item; revisit if MCP standardizes it.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,

    // ----- Space binding -----
    // `clientReference` is invoked at CLIENT-REGISTRATION time. The
    // returned value is written to `auth_oauth_client.reference_id`
    // and is immutable for the life of the client. Used for things
    // like "list all clients a space has registered."
    clientReference: async ({ user }) => {
      if (!user) return undefined;
      return resolveSpaceIdForAuthUser(opts.storage, user.id);
    },

    // `postLogin.consentReferenceId` is invoked at TOKEN-ISSUANCE
    // time (verified in @better-auth/oauth-provider@1.6.13). The return
    // value is written to
    // `auth_oauth_access_token.reference_id` for every minted token.
    //
    // The bearer middleware reads that column as the per-token
    // `space_id`:
    //
    //   middleware/auth.ts:325:
    //     const oauthSpaceId = oauthToken.referenceId ?? undefined;
    //
    // Without this callback, `reference_id` is NULL on every issued
    // token → the bearer middleware sees `space_id=undefined` →
    // keys-mode behavior → multi-space scoping breaks. With it, each
    // token is bound to the consenting user's space at issuance, so
    // the same client can serve users from different spaces without
    // cross-space leakage.
    //
    // The plugin's `postLogin` config wraps an OPTIONAL account-
    // selection flow (multi-account UX); Marfa has single-account-per-
    // session, so `shouldRedirect` always returns false and the
    // `/auth/post-login` page is never hit. We only wire this block
    // for the `consentReferenceId` field.
    //
    // Single-space self-hosts return `undefined` here (no `users`
    // store, so no space to resolve); their tokens land with
    // `reference_id=NULL` which is correct for keys-mode.
    postLogin: {
      page: "/auth/post-login",
      shouldRedirect: () => false,
      consentReferenceId: async ({ user }) =>
        resolveSpaceIdForAuthUser(opts.storage, user.id),
    },

    // ----- Scope grammar -----
    // Default scopes (clients can request these). `clientRegistrationAllowedScopes`
    // widens to the same set (registration accepts everything). Custom types
    // registered at runtime require a server restart to surface here.
    scopes: allowedScopes,
    clientRegistrationAllowedScopes: allowedScopes,
    // The acceptance set above spans every space's runtime namespace roots,
    // but the discovery document is public and unauthenticated — advertising
    // those roots there would disclose one space's namespace names to
    // everyone. Pin the advertisement to the baseline enumeration (grammar +
    // configured bundles, no runtime roots); the plugin otherwise advertises
    // `scopes` verbatim as `scopes_supported`.
    advertisedMetadata: {
      scopes_supported: buildAllowedScopes(undefined, []),
    },
    // Ceilings for the paths with no consent screen in front of them —
    // values owned by `auth/mint-ceiling.ts` so the plugin options and
    // the Marfa-owned DCR mirror cannot drift. Without these, both
    // defaults fall through to `scopes` (the ENTIRE allowlist, `*:write`
    // included): a scope-less client_credentials request and a
    // scope-less registration each inherited everything.
    clientCredentialGrantDefaultScopes: CLIENT_CREDENTIALS_DEFAULT_SCOPES,
    clientRegistrationDefaultScopes: dcrDefaultScopes(),

    // ----- Silence the OAuth discovery-doc location warning -----
    // The plugin emits a WARN at construct time advising operators to
    // serve the issuer-suffixed discovery URL
    // (`/.well-known/oauth-authorization-server/auth` for our `/auth`
    // basePath). Marfa deliberately serves the bare-root variant
    // (`/.well-known/oauth-authorization-server` — see `app.ts`) and
    // documents the partial RFC 8414 §3 deviation in
    // `packages/server/CLAUDE.md` under "Discovery doc issuer field". The
    // `issuer` value matches what id_token signatures use, so RP-side token
    // validation works; only strict-RFC-validators that string-compare the
    // discovery URL host bite. Silence the WARN since the deviation is
    // intentional. Same rationale for the `openid-configuration` sibling.
    silenceWarnings: {
      oauthAuthServerConfig: true,
      openidConfig: true,
    },

    // ----- Token storage -----
    // Custom hash matching `hashApiKey(token, salt)` in middleware/auth.ts
    // so bearer-middleware lookup paths are symmetric: compute the same
    // hash, query `auth_oauth_access_token.token` directly.
    storeTokens: {
      hash: (token) => tokenHasher(token),
    },

    // ----- Token prefix -----
    // Preserves the `marfa_at_*` contract the bearer middleware uses to
    // distinguish OAuth tokens from API keys (`marfa_k1_*`). The middleware
    // ignores anything not matching one of these prefixes.
    prefix: {
      opaqueAccessToken: "marfa_at_",
      refreshToken: "marfa_rt_",
    },

    // ----- Custom claims -----
    // Access tokens are opaque, deliberately: the DB lookup is sub-ms at
    // our scale, revocation stays clean, and scopes never ride inside a
    // token where they could outlive a narrowing. The claims here surface
    // on /oauth2/introspect responses, which the bearer middleware does
    // NOT call (it reads `auth_oauth_access_token` directly + joins
    // `system.connection`). Kept anyway so external resource servers
    // introspecting Marfa-issued tokens get a usable claim set.
    customAccessTokenClaims: ({ user, scopes, referenceId }) => {
      const claims: Record<string, unknown> = {
        scope: scopes.join(" "),
      };
      if (referenceId) claims.space_id = referenceId;
      if (user) claims.user_id = user.id;
      return claims;
    },

    // id_token claims (OIDC). Reproduces the profile + email gate from
    // the (now-deleted) homegrown /auth/userinfo handler.
    customIdTokenClaims: ({ user, scopes }) => {
      const claims: Record<string, unknown> = {};
      if (scopes.includes("profile")) {
        claims.name = user.name;
        if ("image" in user && user.image) claims.picture = user.image;
      }
      if (scopes.includes("email")) {
        claims.email = user.email;
        if ("emailVerified" in user) {
          claims.email_verified = user.emailVerified;
        }
      }
      return claims;
    },

    // /userinfo response shape (OIDC) — same gating as id_token.
    customUserInfoClaims: ({ user, scopes }) => {
      const claims: Record<string, unknown> = {};
      if (scopes.includes("profile")) {
        claims.name = user.name;
        if ("image" in user && user.image) claims.picture = user.image;
      }
      if (scopes.includes("email")) {
        claims.email = user.email;
        if ("emailVerified" in user) {
          claims.email_verified = user.emailVerified;
        }
      }
      return claims;
    },
  });
}

// ---------------------------------------------------------------------------
// Projection plugin shell (refresh-replay before-hook only)
// ---------------------------------------------------------------------------

/**
 * Tiny BetterAuthPlugin shell hosting a single `hooks.before` matcher
 * for refresh-replay access-token cleanup.
 *
 * **Why a plugin shell rather than top-level `hooks`?** Top-level `hooks`
 * on the betterAuth instance only accepts a single before/after callable;
 * PLUGIN-level hooks accept the array+matcher shape needed for per-path
 * routing. The shell carries no endpoints/schema/init of its own — it
 * exists purely to host the before-hook. Same pattern works for adding
 * future plugin-level hooks (additional path matchers) without touching
 * the instance.ts wiring.
 *
 * **Why no after-hooks for projection / cascade / last_used_at?** Every
 * one of those flows is already owned by an explicit Marfa-side handler
 * that does the work deterministically:
 *   - consent projection + audit: `POST /auth/authorize/decision`
 *     (`routes/auth-consent.ts`) verifies the signed query, proxies to
 *     `/auth/oauth2/consent`, and projects only after the plugin returns a
 *     code-bearing registered callback. The explicit handler retains the
 *     verified client context needed to gate those side effects.
 *   - revoke cascade + audit: `DELETE /auth/grants/:id` and
 *     `POST /auth/grants/:id/revoke` (`routes/auth-pages.ts`) call
 *     `storage.oauthProvider.revokeTokensForGrant` and emit
 *     `auth.grant.revoked`. The plugin's `/oauth2/revoke` takes a
 *     token-in-hand, not a (client, user) pair, so resolving the right
 *     grant in a hook would require a before-hook table read pre-deletion
 *     — wasted effort when the user-facing revoke path already has the
 *     resolved client + user in scope.
 *   - `last_used_at` stamping: the bearer middleware stamps on every
 *     authenticated request via `stampOAuthGrantLastUsedByGrantKey`. A
 *     token-issuance after-hook would be redundant in the typical case
 *     (client uses the token immediately) and add a needless DB roundtrip.
 *
 * `apiKeySalt` is threaded in so the refresh-replay before-hook can
 * compute the same hash format the plugin uses (`hashApiKey(token, salt)`
 * via the custom `storeTokens.hash`). Without it, the before-hook is
 * conditionally omitted — the plugin still constructs (the shell is a
 * no-op surface).
 */
export function buildOauthProjectionPlugin(opts: {
  storage: Storage;
  apiKeySalt?: string;
  /** Issuer base URL; when set, the token endpoint validates and strips the
   *  RFC 8707 `resource` parameter so mints stay opaque. */
  baseURL?: string;
}) {
  const { storage, apiKeySalt, baseURL } = opts;
  const refreshHasher = apiKeySalt ? makeTokenHasher(apiKeySalt) : undefined;
  // The same enumeration `buildOauthProviderPlugin` hands the plugin as
  // `scopes`. Both are built at instance construction from the same
  // registries and the same configured bundles, so the narrowing hook and
  // the validation it runs ahead of always agree on what exists.
  const liveScopes = new Set(buildAllowedScopes());
  // What discovery advertises to every client, as opposed to everything a
  // client may request. `liveScopes` is the wider set (wildcards, every
  // registered type); this is the curated bundle union the metadata document
  // publishes, and the distinction is what lets a stored ceiling stop
  // freezing without becoming no ceiling at all. Device initiation builds the
  // same set from the same helper, because a ceiling widened by two
  // differently-filtered sets is two ceilings.
  const bundleScopes = bundlePublishedScopes(getPermissionBundles());
  const acceptedResources = baseURL
    ? new Set(
        [
          stripTrailingSlash(baseURL),
          `${stripTrailingSlash(baseURL)}/mcp`,
        ].filter((v) => v.length > 0),
      )
    : undefined;
  return {
    id: "marfa-oauth-projection" as const,
    hooks: {
      after: [
        {
          // Gives the authorize endpoint's failures a signal. See
          // `logAuthorizeOutcome` for why nothing else produces one.
          matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/authorize",
          handler: createAuthMiddleware((ctx: HookCtxLite) => {
            logAuthorizeOutcome(ctx);
            return Promise.resolve();
          }),
        },
      ],
      before: [
        {
          // Narrows the requested scope set on the authorize endpoint so a
          // scope the server cannot grant costs the requester that scope
          // rather than the whole authorization.
          //
          // The plugin validates with `new Set(client.scopes ?? opts.scopes)`
          // and redirects with `invalid_scope` the moment any requested
          // literal misses. Two things make that fire on requests that ought
          // to succeed. `auth_oauth_client.scopes` is written once at
          // registration and never refreshed, so it is a snapshot of an
          // allowlist that moves whenever the type registry does — stale in
          // both directions, holding scopes for deleted types and missing
          // scopes for new ones. And a client caching its discovered scope
          // set can ask for a literal that has since been retired.
          //
          // Narrowing is what RFC 6749 §3.3 provides for, and the granted set
          // travels back to the client on the token response, so an app that
          // asked for more than it got can tell. Dead-ending cannot be
          // recovered from at all: the client is 302'd to its own redirect
          // URI with an error and no way forward.
          matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/authorize",
          handler: createAuthMiddleware((ctx: HookCtxLite) =>
            narrowAuthorizeScopes(ctx, storage, liveScopes, bundleScopes),
          ),
        },
        ...(acceptedResources
          ? [
              {
                // RFC 8707 `resource` on the token endpoint, made safe for
                // opaque tokens. MCP clients MUST send the canonical URI of
                // the endpoint they will use the token against; the plugin
                // validates it against its audience list and then, whenever
                // a resource survives, mints a JWT-format access token
                // instead of the opaque one the bearer middleware resolves —
                // a token that verifies nowhere. Every audience this
                // deployment accepts is this same server, so restricting the
                // token's audience adds nothing the issuer boundary does not
                // already provide: no other resource server trusts this
                // authorization server. Validate against the accepted set,
                // refuse unknown resources up front with the RFC 8707 error,
                // and strip the parameter so the mint stays opaque.
                matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/token",
                handler: createAuthMiddleware((ctx: HookCtxLite) => {
                  normalizeResourceParameter(ctx, acceptedResources);
                  return Promise.resolve();
                }),
              },
            ]
          : []),
        ...(refreshHasher
          ? [
              {
                // Guards POST /auth/oauth2/token for the refresh_token grant:
                //  (1) an UNKNOWN/orphaned refresh token gets a clean RFC 6749
                //      `invalid_grant` (400) BEFORE the plugin can 500 on it —
                //      a 500 is non-terminal to clients, so a stale token (e.g.
                //      orphaned by a data reset) turns into a hard retry storm.
                //  (2) a REVOKED (replayed) token: pre-emptively zap the chain's
                //      access tokens (the plugin then returns invalid_grant),
                //      closing the gap where they'd outlive the refresh chain.
                //  Active tokens fall through to the plugin's rotation. The
                //  invalid_grant throw MUST propagate (not be swallowed).
                matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/token",
                handler: createAuthMiddleware((ctx: HookCtxLite) =>
                  guardRefreshTokenGrant(ctx, storage, refreshHasher),
                ),
              },
              {
                // Guards the same endpoint for the authorization_code grant:
                // a code whose grant the user has revoked must not redeem.
                // Revocation deletes outstanding codes, so in the ordinary
                // case this never fires; it holds for a code minted in the
                // window between the two writes, and for any future
                // revocation path that forgets to sweep them.
                matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/token",
                handler: createAuthMiddleware((ctx: HookCtxLite) =>
                  guardAuthorizationCodeGrant(ctx, storage, refreshHasher),
                ),
              },
            ]
          : []),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Refresh-token grant guard (before-hook)
// ---------------------------------------------------------------------------

/**
 * Before-hook for `/oauth2/token` with `grant_type=refresh_token`. One
 * lookup of the refresh-token row drives two behaviours:
 *
 *  1. **Unknown token → clean `invalid_grant` (400).** The
 *     @better-auth/oauth-provider plugin 500s when handed a refresh token
 *     with no matching row (e.g. orphaned by a data reset). A 500 is
 *     non-terminal to most OAuth clients, so they retry hard and the storm
 *     saturates the auth rate limit. We throw the RFC 6749 `invalid_grant`
 *     instead — terminal, so a well-behaved client stops. The throw
 *     propagates (it is NOT swallowed) to short-circuit the request.
 *
 *  2. **Revoked (replayed) token → zap the chain's access tokens.** The
 *     plugin marks the old refresh token `revoked` on rotation and returns
 *     `invalid_grant` on replay, but leaves the chain's access tokens valid
 *     until TTL. We pre-emptively delete them for (clientId, userId) so a
 *     parallel request can't slip through with one. Best-effort.
 *
 * Active tokens fall through to the plugin's rotation. Any failure of the
 * lookup itself fails open (logs, returns) so a transient DB blip never
 * turns a legitimate refresh into a hard error.
 */
function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function normalizeResourceParameter(
  ctx: HookCtxLite,
  accepted: Set<string>,
): void {
  const body = ctx.body;
  if (!body || typeof body !== "object") return;
  const resource = body.resource;
  if (resource === undefined) return;
  const values =
    typeof resource === "string"
      ? [resource]
      : Array.isArray(resource)
        ? resource
        : null;
  if (
    !values ||
    values.some(
      (v) => typeof v !== "string" || !accepted.has(stripTrailingSlash(v)),
    )
  ) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_target",
      error_description:
        "The requested resource is not served by this authorization server.",
    });
  }
  delete body.resource;
}

/**
 * The object the vendored provider will read an authorize request's
 * parameters out of, together with the client the request names. This is the
 * object a before-hook has to rewrite for a rewrite to mean anything.
 *
 * It reproduces the provider's own selection rather than inferring one:
 *
 *     ctx.method === "POST" && settings?.isAuthorize === true
 *       ? ctx.body
 *       : ctx.query
 *
 * with `settings` being `ctx.authorizeSettings ?? { isAuthorize: true }`.
 * Reproducing it is what makes the two impossible to disagree; anything
 * inferred from the shape of the request is a second rule that can drift
 * against the first, and drifting means failing open without saying so.
 *
 * The verb alone does not settle it, which is the part worth knowing. The
 * endpoint re-enters itself from six places: twice from the consent
 * endpoint, once when it cannot satisfy a `prompt=login` and once when it is
 * done; once after a sign-in; and once from each of the three branches of
 * `/oauth2/continue`. Each dispatches this same endpoint with the parameters
 * lifted onto the query while the method still reads POST, and every one of
 * them leaves `isAuthorize` unset — which is exactly how the provider tells
 * a re-entry from a form post it is serving directly.
 *
 * `undefined` when the selected object names no client. The provider refuses
 * a request with no `client_id` itself, and there is no grant in it to
 * narrow, so there is nothing here to fail open on.
 *
 * If a future version changes that selection, this diverges silently. Two
 * things bound how far: the dependency is pinned to an exact version rather
 * than a range, so arriving at a different one is an edit somebody made on
 * purpose; and the coverage is end-to-end rather than a unit test on this
 * function, so a form POST that stops being narrowed fails a test about the
 * redirect it produces rather than one about which object was read.
 *
 * **The `isAuthorize` half of that test passes every test in the suite if it
 * is deleted, and it must not be.** Dropping it reads the consent or
 * continue body on a re-entry instead of the query. That is a no-op only
 * because those two endpoints declare their bodies as plain `z.object`
 * without `.passthrough()`, so an unknown `client_id` is stripped out before
 * dispatch and this finds nothing to act on — where the authorize endpoint's
 * own body schema does passthrough, which is why the same key survives on a
 * form post. The no-op is therefore a property of those schemas rather than
 * of what a client happens to send, and a re-entry body that ever carried a
 * `client_id` would turn it into this hook rewriting the scope list a person
 * just consented to. It is here because it reproduces the rule, not because
 * a test caught it.
 */
function findAuthorizeRequest(
  ctx: HookCtxLite,
): { params: Record<string, unknown>; clientId: string } | undefined {
  const settings = ctx.authorizeSettings ?? { isAuthorize: true };
  const source =
    ctx.method === "POST" && settings.isAuthorize === true
      ? ctx.body
      : ctx.query;
  if (!source || typeof source !== "object") return undefined;

  const clientId = source.client_id;
  if (typeof clientId !== "string" || clientId.length === 0) return undefined;
  return { params: source, clientId };
}

/**
 * Before-hook for `GET|POST /oauth2/authorize`. Rewrites the request's
 * `scope` — on the query string or the form body, whichever the provider
 * will read it from, see {@link findAuthorizeRequest} — to the intersection
 * of what was requested, what this server can grant, and what the client is
 * registered for, so an unsatisfiable literal is dropped instead of failing
 * the authorization.
 *
 * **It refuses to narrow in two cases, each deliberately leaving the
 * plugin's own `invalid_scope` to fire:**
 *
 *  1. **The client cannot be resolved.** An unknown or unreadable client is
 *     the plugin's refusal to make, and narrowing against a ceiling we
 *     failed to read would be guessing at authority.
 *  2. **The intersection is empty.** An emptied `scope` reaches a consent
 *     screen with nothing on it, which the decision handler treats as a
 *     denial — a confusing dead-end swapped for a clear one. A request in
 *     which nothing at all is grantable is a genuine `invalid_scope`.
 *
 * A request with **no `scope` parameter** is narrowed too. The plugin
 * defaults that grant to the client's stored ceiling, which is a
 * registration-time snapshot — deferring to it asks the user to approve
 * scopes for types that no longer exist. The default request the client
 * makes by omission is "everything I am registered for", and the honest
 * reading of that today is the ceiling intersected with what this server
 * can still grant.
 *
 * The dropped literals reach the client on the token response's `scope`
 * field and the operator through the logs below. They cannot reach the
 * consent page: the plugin's authorize endpoint validates its query with a
 * stripping schema, so no custom parameter survives into the signed
 * redirect the page renders from, and an unsigned parameter is exactly
 * what the page must never trust. The machine channel is the honest one.
 *
 * A read failure fails open (log, return) so a transient database blip
 * degrades to the pre-existing behavior rather than breaking sign-in.
 *
 * **Order is a security property here, not a style choice.** Everything
 * above the stale-ceiling catch-up is a pure read, and the catch-up is the
 * only thing on this path that persists anything. The gates that keep it
 * that way carry their own note at the call site.
 */
async function narrowAuthorizeScopes(
  ctx: HookCtxLite,
  storage: Storage,
  liveScopes: Set<string>,
  bundleScopes: Set<string>,
): Promise<void> {
  const request = findAuthorizeRequest(ctx);
  if (!request) return;
  const { params, clientId } = request;

  const oauth = storage.oauthProvider;
  if (!oauth) return;

  let ceiling: readonly string[] | null;
  let registeredRedirectUris: readonly string[];
  try {
    const client = await oauth.getClient(clientId);
    if (!client) return;
    // Mirrors the plugin's own `client.scopes ?? opts.scopes`: a null ceiling
    // tracks the live set, and an empty array is a real, empty ceiling that
    // narrows everything away — which case 2 below then declines to act on.
    ceiling = client.scopes;
    // Read off the same row, so the redirect-URI gate below costs no extra
    // query.
    registeredRedirectUris = client.redirectUris;
  } catch (err) {
    log("warn", "oauth authorize scope-narrowing precheck failed", {
      client_id: clientId,
      error: err,
    });
    return;
  }

  const rawScope = params.scope;
  const requested =
    typeof rawScope === "string"
      ? rawScope.split(" ").filter((s) => s.length > 0)
      : [];
  if (requested.length === 0) {
    // No scope named. With no stored ceiling the plugin already defaults to
    // the live allowlist; with one, spell out the request the omission
    // means — the ceiling minus what this server can no longer grant — so
    // a stale snapshot cannot put dead scopes in front of the user.
    if (ceiling === null || ceiling.length === 0) return;
    const grantable = ceiling.filter((s) => liveScopes.has(s));
    const dead = ceiling.filter((s) => !liveScopes.has(s));
    if (dead.length === 0) return;
    if (grantable.length === 0) {
      // An entirely dead ceiling: nothing honest to write, so leave the
      // plugin's own behavior in place and say so.
      log("warn", "oauth authorize: stored client ceiling is entirely dead", {
        client_id: clientId,
        ceiling,
      });
      return;
    }
    params.scope = grantable.join(" ");
    log("info", "oauth authorize: defaulted scope to the live ceiling", {
      client_id: clientId,
      dropped_scopes: dead,
      granted_scopes: grantable,
    });
    return;
  }

  // ---------------------------------------------------------------------
  // What the caller has to already know, before anything writes.
  //
  // Everything above this point is a pure read; the catch-up below is a
  // persistent `UPDATE` on `auth_oauth_client.scopes`. This hook is a
  // `hooks.before` matcher, so it runs ahead of the endpoint handler body:
  // ahead of the plugin resolving a session, and ahead of the plugin
  // validating `redirect_uri`. Without these gates, an unauthenticated caller
  // who knows a public `client_id` could name the whole bundle union and move
  // that client's stored row — and the row is what the client is given when
  // it omits `scope`, so the next genuine sign-in would meet a consent screen
  // pre-ticked with the union rather than the narrow set the client
  // registered for. Phishing-shaped against the user.
  //
  // **Call this what it is: a second thing the caller has to know, not proof
  // that it controls the client.** Nothing here demonstrates control. A
  // request naming a registered callback still drives the widening, and it
  // still does so unauthenticated. What changes is the precondition: one
  // public identifier becomes two, and the second is not one this server
  // will hand out. There is no endpoint that discloses a client's registered
  // redirect URIs, so an attacker has to have observed one — from a browser
  // client's address bar during a sign-in, most easily — rather than looked
  // one up. That is why the bar rises at all, and it is the whole of what
  // rises. An attacker who has watched one sign-in has both halves.
  //
  // The gates below reproduce four of the plugin's own refusals, in its
  // order, and stop there. **They do not establish that the plugin will
  // accept the request**, and an earlier version of this comment claimed
  // they did. The plugin runs a whole query schema between them — a
  // malformed `max_age` is `invalid_request` and nothing here notices —
  // so what this can honestly say is narrower: it declines to write on the
  // request shapes it can recognize cheaply and unambiguously as refused,
  // and a shape it cannot recognize still reaches the catch-up. Reproducing
  // the schema is not worth it; that is a whole validator to keep in step
  // with a pinned dependency, and every shape it would add is one the caller
  // already needed the registered redirect URI to reach.
  //
  // `initDeviceFlow` states the neighboring rule on the device surface:
  // nothing that writes may run above the checks that clear the request.
  //
  // The plugin's `disabled` and `clientAllowsGrant` gates sit BELOW the
  // redirect-URI check in its order and are deliberately not reproduced.
  // Both refuse a caller who has already cleared the bar this hook sets, so
  // what they would additionally stop is somebody widening the ceiling of a
  // client they can already reach. The four gates below are different: every
  // one of them sits ABOVE the redirect-URI check, so leaving them out let a
  // request through that the plugin was certain to refuse.
  //
  // **What this closes and what it does not.** It stops an attacker who
  // knows only a public `client_id` from widening a THIRD-PARTY client's
  // ceiling, which is the phishing-shaped harm: the victim is a user who
  // trusts an app that registered narrowly. It does not stop an attacker who
  // has also observed that client's callback. And it does not stop somebody
  // self-registering a client through public dynamic registration and
  // widening their own — but a ceiling on a client only they control grants
  // nothing, because a ceiling is permission to ask and a person still
  // approves the screen. Both distinctions matter, because "unauthenticated
  // callers cannot write here" is what this will be mistaken for, and it is
  // not true.

  // The plugin refuses a JAR request object outright, and refuses a
  // `request_uri` because `requestUriResolver` is unconfigured. Matched on
  // `typeof === "string"` rather than truthiness because that is how the
  // plugin reads them: an empty string is present, and a non-string is not.
  //
  // These two also bound what the rest of this function may assume. The
  // parameters are read off the wire, which is the only place they are; a
  // request that carried them indirectly would be one whose real parameters
  // a before-hook cannot see.
  if (typeof params.request === "string") return;
  if (typeof params.request_uri === "string") return;

  // `prompt=select_account` is `unsupported_prompt_select_account` unless the
  // provider is configured with a `selectAccount.page`, and this deployment
  // configures none. Reproduces `parsePrompt`, which splits on spaces and
  // trims, so `prompt=login select_account` is caught too. If a select-account
  // page is ever configured this gate becomes stricter than the plugin, which
  // costs a stale client one more sign-in before it self-heals — the safe
  // direction for a divergence to fall in.
  const rawPrompt = params.prompt;
  if (
    typeof rawPrompt === "string" &&
    rawPrompt.split(" ").some((prompt) => prompt.trim() === "select_account")
  ) {
    return;
  }

  // Anything other than `code` is `unsupported_response_type`, and there is
  // no grant in it to catch a ceiling up for.
  if (params.response_type !== "code") return;

  // The request has to name a callback the client registered. This is the
  // gate the ordering exists for: it is the one parameter an attacker
  // working from a public `client_id` alone cannot supply, because no
  // endpoint discloses it. Matched the way the plugin matches it — exact, or
  // a loopback-IP relaxation on port, because a native or CLI client binds an
  // ephemeral port and those are exactly the clients the catch-up repairs.
  const requestedRedirectUri = params.redirect_uri;
  if (
    typeof requestedRedirectUri !== "string" ||
    !matchesRegisteredRedirectUri(registeredRedirectUris, requestedRedirectUri)
  ) {
    return;
  }

  // **There is deliberately no live-allowlist pass here, and that is the one
  // place this ordering does not copy the device surface.** `initDeviceFlow`
  // clears the whole request against the allowlist before its catch-up runs,
  // because it refuses a request it cannot fully satisfy and so must not move
  // a row on the way out. This surface narrows instead: a scope for a type
  // this server has since deleted is dropped from the request below and the
  // authorization still succeeds, which is the entire reason the hook exists.
  // Refusing to act on a request naming one would hand it back untouched, and
  // the plugin — which validates against the client's stored ceiling rather
  // than the live allowlist — would then offer the user consent to a type
  // that does not exist, or dead-end a client whose other scopes were fine.
  //
  // Nothing is lost by its absence, because the write is already bounded by
  // something strictly narrower. `catchUpClientScopeCeiling` widens only by
  // scopes the bundles publish, and `buildAllowedScopes` folds every
  // grammatically valid bundle scope into the live allowlist by construction,
  // so the bundle set is a subset of it and a literal this server cannot
  // grant can never reach the row. The one class of scope neither of them
  // folds in — a grammatical literal this build withholds — is dropped by
  // both, so the containment survives the exception rather than depending on
  // there not being one.
  // `authorize-ceiling-catch-up-client-control.test.ts` pins that
  // containment, because it is an invariant two functions hold between them
  // rather than one either states, so nothing fails when it stops holding.

  // ---------------------------------------------------------------------

  // Catch the ceiling up to what this request asks for, before anything is
  // narrowed against it. Device initiation performs the same catch-up before
  // its own comparison; the helper carries the three bounds and why each one
  // is there.
  ceiling = await catchUpClientScopeCeiling({
    storage,
    clientId,
    requested,
    ceiling,
    bundleScopes,
    surface: "authorize",
  });

  // Both tests below are exact membership, and both stay that way even
  // though the consent comparisons one file over now understand breadth.
  //
  // This hook rewrites the request's `scope` and hands it straight back to
  // the vendored provider, which re-validates what it receives against the
  // very same values: `new Set(client.scopes ?? opts.scopes)` and
  // `.has(scope)`, exact, with no pattern matching anywhere in it. So a
  // literal waved through here on the grounds that a wildcard in the
  // ceiling covers it is refused a moment later — and refused as
  // `invalid_scope` on the WHOLE request, riding a redirect the app may
  // never render. That is a worse outcome than the narrowing this loop
  // performs, and it is the dead end the hook exists to prevent.
  //
  // The repair that works on this path is above rather than here: the
  // stale-ceiling catch-up writes the requested literal INTO the stored row,
  // so the plugin's exact test then passes. Breadth belongs in what gets
  // written, not in what gets compared.
  //
  // `mint-ceiling.ts` records the same conclusion from the other direction,
  // about admitting the session scopes at the point of reading a ceiling,
  // and device initiation compares the row the same exact way. Three
  // attempts, one rule: every reader of a ceiling stays a plain membership
  // test against what the row says, and the catch-up is what moves the row.
  const granted: string[] = [];
  const unknownToServer: string[] = [];
  const outsideClientCeiling: string[] = [];
  for (const scope of requested) {
    if (!liveScopes.has(scope)) {
      unknownToServer.push(scope);
      continue;
    }
    if (ceiling !== null && !ceiling.includes(scope)) {
      outsideClientCeiling.push(scope);
      continue;
    }
    granted.push(scope);
  }

  if (unknownToServer.length === 0 && outsideClientCeiling.length === 0) return;
  if (granted.length === 0) return;

  // Narrowing trades a clear failure for a smaller grant, and that trade is
  // only good while the dropped scope costs a permission. These two cost the
  // session model instead: without `offline_access` there is no refresh token,
  // and without `openid` there is no id_token. Dropping either silently
  // succeeds here and then fails two steps later inside the SDK — a token
  // exchange that cannot find `refresh_token`, or a sign-out that cannot find
  // an id_token — with nothing pointing back at the scope that went missing.
  // A named `invalid_scope` at the authorize step is the better answer,
  // because it says which literal to go and register.
  const droppedSessionScopes = [
    ...unknownToServer,
    ...outsideClientCeiling,
  ].filter((s) => SESSION_CRITICAL.has(s));
  if (droppedSessionScopes.length > 0) {
    log("warn", "oauth authorize: refusing to narrow a session scope", {
      client_id: clientId,
      dropped_scopes: droppedSessionScopes,
    });
    return;
  }

  params.scope = granted.join(" ");

  // Two log lines because they are two different events. A scope this server
  // has never heard of points at a client built against a different registry
  // or a type that has been deleted; a scope the server knows but the client
  // is not registered for points at the client's stored ceiling having fallen
  // behind the platform. Collapsing them loses the distinction that says
  // which one to go and fix.
  if (unknownToServer.length > 0) {
    log("info", "oauth authorize: dropped scopes this server cannot grant", {
      client_id: clientId,
      dropped_scopes: unknownToServer,
      granted_scopes: granted,
    });
  }
  if (outsideClientCeiling.length > 0) {
    log("info", "oauth authorize: dropped scopes outside the client ceiling", {
      client_id: clientId,
      dropped_scopes: outsideClientCeiling,
      granted_scopes: granted,
    });
  }

  // And an audit row, because a log line is not a record anybody goes
  // looking through afterwards. A narrowed authorize is a grant that is
  // quietly smaller than the one the user was shown a screen for, and the
  // operator trail already carries `auth.grant.created` next to it — this
  // is the line that says the two do not match and why.
  //
  // No space: the narrowing happens before the plugin resolves a session,
  // so there is no user to attribute it to yet, and inventing one by
  // guessing would be worse than the null the audit store already admits
  // for system-initiated rows. The client is the subject here anyway.
  void storage.audit.log({
    space_id: null,
    action: "auth.scopes.narrowed",
    resource_type: "oauth_client",
    resource_id: clientId,
    client_ip: null,
    details: {
      client_id: clientId,
      requested_scopes: requested,
      granted_scopes: granted,
      // Two fields rather than one, for the same reason there are two log
      // lines: a scope this server has never heard of points at a client
      // built against a different registry, and a scope it knows but the
      // client is not registered for points at the client's ceiling. They
      // want different fixes.
      dropped_unknown_to_server: unknownToServer,
      dropped_outside_client_ceiling: outsideClientCeiling,
    },
  });
}

/**
 * OAuth error codes the authorize endpoint returns as ordinary flow control
 * rather than as a fault. A person declining consent, or a `prompt=none`
 * probe discovering it needs interaction, is the protocol working.
 *
 * Everything NOT in this set means a request that should have worked did
 * not: a client asking for a scope the server will not grant, an unknown or
 * disabled client, an unregistered redirect URI. Those are the operator's to
 * see.
 */
/**
 * Scopes whose absence breaks the session model rather than costing a
 * permission, so narrowing them away is worse than refusing.
 *
 * `offline_access` is what mints the refresh token; without it the SDK's
 * token exchange throws `invalid_grant` because `refresh_token` is missing.
 * `openid` is what mints the id_token; without it sign-out cannot build its
 * end-session URL. In both cases the failure surfaces well after the
 * authorization succeeded, naming neither the scope nor the client.
 *
 * The set itself is owned by `auth/mint-ceiling.ts`, which also puts these
 * into every registered ceiling — so refusing to narrow one here can only
 * ever mean a client named a scope this server does not have, never that
 * its own registration was minted unable to hold a session.
 */
const SESSION_CRITICAL = new Set(SESSION_CRITICAL_SCOPES);

const EXPECTED_AUTHORIZE_ERRORS = new Set([
  "access_denied",
  "login_required",
  "consent_required",
  "interaction_required",
  "account_selection_required",
]);

/**
 * After-hook for `/oauth2/authorize`. Emits a log line whenever the endpoint
 * redirects with an OAuth error.
 *
 * **Without this, an authorize failure is indistinguishable from a success.**
 * The plugin signals failure with `throw ctx.redirect(...)`, which
 * `better-call` converts to a `Response` before Hono sees it — so
 * `app.onError` never runs, the 100%-on-error trace sampling never triggers,
 * and a fleet alert keyed on `level='error'` cannot fire. The request logger
 * records the path but not the query string, and the endpoint answers 302 on
 * every outcome, so neither the status nor the body separates them. A total
 * sign-in outage ran for days logging nothing but `GET /auth/oauth2/authorize
 * 302` at `info`, and was found by a person opening the app.
 *
 * The level is chosen from the error code rather than fixed, because these
 * are two different events sharing a shape. A declined consent is the
 * protocol working and would be noise at `warn`; an `invalid_scope` is a
 * client that cannot get in and is the whole reason this exists.
 *
 * Best-effort throughout: this is a reporting path, and it must never be the
 * reason an authorization fails.
 */
/**
 * The message every authorize refusal is logged under. The fleet alert
 * counts on this exact string, so it is exported rather than repeated —
 * a signal nothing queries is the defect this whole path exists to fix,
 * and two independently-written copies of a string is how that happens.
 */
export const AUTHORIZE_REFUSED_MESSAGE = "oauth authorize refused the request";

/**
 * `error_description` is developer-facing by RFC 6749 §4.1.2.1 and carries
 * the diagnostic value — it names which scopes or parameter was at fault.
 * It is also built from the caller's own input (`The following scopes are
 * invalid: ${requested}`), so it is attacker-chosen text on an endpoint that
 * accepts 30 requests a minute per IP. Bounded so a log record cannot be
 * used as a place to put kilobytes of someone else's choosing.
 */
const MAX_ERROR_DESCRIPTION_CHARS = 300;

/** Pull the redirect target off whatever the endpoint produced. */
function redirectLocationOf(returned: unknown): string | null {
  if (!returned || typeof returned !== "object") return null;

  // The thrown-redirect shape: a browser navigation. `better-call` converts
  // this to a Response, which is why `app.onError` never sees it.
  const headers = (returned as { headers?: unknown }).headers;
  if (headers instanceof Headers) return headers.get("location");

  // The returned-redirect shape: `{ redirect: true, url }`, which the plugin
  // produces instead of throwing whenever the request came from `fetch` or
  // asked for JSON. That covers the first-party app's post-sign-in resume and
  // every SPA silent-renewal probe — in other words, the common path. Reading
  // only the thrown shape left exactly those blind.
  const value = returned as { redirect?: unknown; url?: unknown };
  if (value.redirect === true && typeof value.url === "string")
    return value.url;

  return null;
}

function logAuthorizeOutcome(ctx: HookCtxLite): void {
  try {
    const location = redirectLocationOf(ctx.context?.returned);
    if (!location) return;

    // `location` is relative-safe: a base is supplied only so URL parses, and
    // nothing downstream reads the origin.
    const params = new URL(location, "http://localhost").searchParams;
    const error = params.get("error");
    if (!error) return;

    // A redirect can carry both an error and a code, and only one of them is
    // ever the server's. A client may register a redirect URI whose own query
    // contains either parameter, registration does not forbid it, and dynamic
    // client registration is unauthenticated.
    //
    // So the presence of `code` decides nothing: read that way, a client that
    // registers `?code=` silences every genuine refusal it receives, which is
    // a false negative on exactly the counter a sign-in outage is measured by.
    // Read the other way, a client that registers `?error=` turns every one of
    // its successful sign-ins into a refusal carrying an error code of its own
    // choosing. Diffing against what was registered keys the decision on the
    // one thing the client cannot supply: whether the server added it.
    if (
      serverAddedResponseParam(
        typeof ctx.query?.redirect_uri === "string"
          ? ctx.query.redirect_uri
          : null,
        location,
        "code",
      )
    ) {
      return;
    }

    const description = params.get("error_description");
    const expected = EXPECTED_AUTHORIZE_ERRORS.has(error);
    log(expected ? "info" : "warn", AUTHORIZE_REFUSED_MESSAGE, {
      error_code: error,
      error_description:
        description === null
          ? undefined
          : description.slice(0, MAX_ERROR_DESCRIPTION_CHARS),
      client_id:
        typeof ctx.query?.client_id === "string"
          ? ctx.query.client_id
          : undefined,
    });
  } catch {
    // A reporting path must never fail a request.
  }
}

async function guardRefreshTokenGrant(
  ctx: HookCtxLite,
  storage: Storage,
  hasher: (token: string) => string,
): Promise<void> {
  const body = ctx.body;
  if (!body || typeof body !== "object") return;
  if (body.grant_type !== "refresh_token") return;
  const refreshTokenRaw = body.refresh_token;
  if (typeof refreshTokenRaw !== "string" || refreshTokenRaw.length === 0)
    return;
  if (typeof storage.oauthProvider?.findRefreshTokenGrantKey !== "function")
    return;

  // The plugin strips the `prefix.refreshToken` (`marfa_rt_`) in its
  // `decodeRefreshToken` step, BEFORE calling our hasher. Strip here too so
  // the hash matches the stored value.
  const REFRESH_PREFIX = "marfa_rt_";
  const bare = refreshTokenRaw.startsWith(REFRESH_PREFIX)
    ? refreshTokenRaw.slice(REFRESH_PREFIX.length)
    : refreshTokenRaw;

  let row: Awaited<
    ReturnType<
      NonNullable<Storage["oauthProvider"]>["findRefreshTokenGrantKey"]
    >
  >;
  try {
    row = await storage.oauthProvider.findRefreshTokenGrantKey(hasher(bare));
  } catch (err) {
    // Fail open to the plugin — never 500 a legitimate refresh on a blip.
    log("warn", "oauth refresh-token precheck failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!row) {
    // Unknown token — terminal, spec-correct rejection (prevents the
    // plugin 500ing and the resulting client retry storm).
    throw new APIError("BAD_REQUEST", {
      error: "invalid_grant",
      error_description: "The refresh token is invalid, expired, or revoked.",
    });
  }
  if (!row.revoked) return; // active — let the plugin rotate

  // Confirmed replay. Zap access tokens for this grant chain so they can't
  // outlive the now-poisoned refresh chain. Best-effort + idempotent.
  try {
    if (
      typeof storage.oauthProvider.revokeAccessTokensForGrant === "function"
    ) {
      await storage.oauthProvider.revokeAccessTokensForGrant(
        row.clientId,
        row.userId,
      );
      log("info", "oauth refresh-replay: revoked access tokens for grant", {
        client_id: row.clientId,
        user_id: row.userId,
      });
    }
  } catch (err) {
    log("warn", "oauth refresh-replay zap failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Authorization-code grant guard (before-hook)
// ---------------------------------------------------------------------------

/**
 * Before-hook for `/oauth2/token` with `grant_type=authorization_code`.
 * Refuses a code whose grant the user has revoked.
 *
 * Revocation now deletes outstanding codes, so in the ordinary case this
 * never fires. It exists because the deletion alone is a sweep, and a sweep
 * has a window: a code minted between the consent-row delete and the code
 * delete would survive one and miss the other. It also holds if some later
 * revocation path is added and forgets the codes, which is exactly how this
 * defect arose in the first place — every existing path swept the token
 * tables and none of them knew codes lived somewhere else.
 *
 * Why this is worth two mechanisms rather than one. The obvious reading is
 * that a code expires in ten minutes so the exposure is ten minutes. That
 * bounds only when the code can be redeemed. What redemption yields is not
 * bounded: with `offline_access` the exchange returns a refresh token that
 * rotates indefinitely. A short race converts into a permanent grant, and
 * the user's own security page reports the app as revoked the whole time.
 *
 * Fails open on a lookup error and on an unrecognised code: the plugin owns
 * the real validation, and a transient database blip must not turn a
 * legitimate exchange into a hard failure.
 */
async function guardAuthorizationCodeGrant(
  ctx: HookCtxLite,
  storage: Storage,
  hasher: (token: string) => string,
): Promise<void> {
  const body = ctx.body;
  if (!body || typeof body !== "object") return;
  if (body.grant_type !== "authorization_code") return;
  const code = body.code;
  if (typeof code !== "string" || code.length === 0) return;
  if (
    typeof storage.oauthProvider?.findAuthorizationCodeGrantKey !== "function"
  )
    return;

  let row: Awaited<
    ReturnType<
      NonNullable<Storage["oauthProvider"]>["findAuthorizationCodeGrantKey"]
    >
  >;
  try {
    row = await storage.oauthProvider.findAuthorizationCodeGrantKey(
      hasher(code),
    );
  } catch (err) {
    log("warn", "oauth authorization-code precheck failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Unknown code: not ours to judge. The plugin returns the spec error.
  if (!row) return;
  if (row.hasConsent) return;

  log("info", "oauth authorization-code refused: grant revoked", {
    client_id: row.clientId,
  });
  throw new APIError("BAD_REQUEST", {
    error: "invalid_grant",
    error_description:
      "The authorization code is invalid, expired, or revoked.",
  });
}
