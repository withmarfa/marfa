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
 *      `marfa_at_` / `marfa_rt_` prefixes, and OIDC custom claims for
 *      profile + email.
 *   3. `buildOauthProjectionPlugin(...)` — the before-hook that
 *      defends against refresh-token replay by pre-emptively revoking
 *      access tokens when a stale refresh is detected.
 */

import { oauthProvider } from "@better-auth/oauth-provider";
import { APIError, createAuthMiddleware } from "better-auth/api";
import {
  decodeBasicCredentials,
  stripAccessTokenAuthorizationScheme,
} from "better-auth/oauth2";
import {
  auditGrantReused,
  auditGrantRevoked,
  revokeProjectedGrant,
} from "./grant-lifecycle.js";
import { createHmac } from "node:crypto";
import {
  profilePermissionCovers,
  scopesToProfilePermissions,
  PROFILE_ROWS,
  PROFILE_ROOT,
  SPACE_PERMISSIONS,
  TYPE_REGISTRY,
  EDGE_TYPE_REGISTRY,
  expandBundlesToScopes,
  isValidScope,
} from "@withmarfa/shared";
import type { PermissionBundle } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { getPermissionBundles } from "../config.js";
import { deriveCustomTypeNamespaces } from "./default-bundles.js";
import { dcrDefaultScopes, SESSION_CRITICAL_SCOPES } from "./mint-ceiling.js";
import { log } from "../middleware/logger.js";
import {
  bundlePublishedScopes,
  catchUpClientScopeCeiling,
} from "./ceiling-catchup.js";
import {
  isWithheldFromAllowlist,
  warnOnceAboutWithheldBundleScope,
} from "./allowlist-withholding.js";
import { matchesRegisteredRedirectUri } from "./redirect-uri-match.js";
import { serverAddedResponseParam } from "./redirect-params.js";

/**
 * Minimal context shape we read off the `hooks.before` and `hooks.after`
 * matchers + handlers. Mirrors the slice of Better Auth's
 * `HookEndpointContext` we touch — `path` is widened to `string | undefined`
 * to match the library's type (some internal paths leave it unset).
 * `method` and `authorizeSettings` are read on both sides: the request
 * selector consults both, and the consent-skip audit after the authorize
 * endpoint calls it and keys on `authorizeSettings` directly.
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
  /** The request headers; read for a client that authenticates with HTTP
   *  Basic rather than a `client_id` in the body. */
  headers?: Headers | null;
  /** What the revoke before-hook resolved, handed to the after-hook through
   *  the context merge Better Auth performs on a before-hook's returned
   *  `context`. See {@link resolveClientRevoke}. */
  revokeResolution?: RevokeResolution;
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
    // Category 2, Your profile. The levelled parent and one literal per row.
    // Published rather than withheld because the consent screen has shipped a
    // "Your profile" bundle since before any of this was enforced, and a
    // bundle offering a category no client can request is a screen making a
    // promise the grammar cannot keep.
    `${PROFILE_ROOT}:read`,
    `${PROFILE_ROOT}:write`,
    ...PROFILE_ROWS.flatMap((row) => [
      `${PROFILE_ROOT}.${row}:read`,
      `${PROFILE_ROOT}.${row}:write`,
    ]),
    // The space permission family: authority over one administrative surface,
    // which is handed over by being named and consented to and by nothing
    // else. Nothing inherits it, and no door admits without it.
    //
    // **Emitted from the closed set, deliberately not through a bundle.** The
    // shape this replaces was to put them in an off-by-default bundle so a
    // stale client's ceiling would catch up to them. That fails twice over: a
    // bundle-claimed space permission leaves the consent screen's
    // unclaimed-scope bucket, so it renders inside the bundle's group and
    // inherits the bundle's tick rather than its own rule; and it makes
    // reachability depend on a configuration, so an operator shipping no
    // bundles has an instance whose gates can never be satisfied by anybody.
    // The family is the platform's, so the platform publishes it.
    //
    // **Publishable is not grantable, and the distance between them is the
    // whole design.** Every surface that offers one has to obtain a
    // deliberate yes — `requiresExplicitConsent` is the rule, read by the
    // consent screen and the device screen at their own call sites. The
    // bundle door below still drops a space permission a configuration names,
    // which now guards the stored client ceiling rather than this list.
    ...SPACE_PERMISSIONS,
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
  // Two filters, and they answer different questions. `isValidScope` asks
  // whether the grammar recognizes the literal at all; `isWithheldFromAllowlist`
  // asks whether a bundle may be the thing that publishes one it recognizes.
  //
  // The space permission family is emitted above, from the closed set, so the
  // drop no longer changes this function's output for one. What it still
  // decides is whether a *configuration* can claim the literal, which is the
  // half that reaches a stored client ceiling and the consent screen's
  // grouping.
  for (const scope of expandBundlesToScopes(permissionBundles)) {
    if (!isValidScope(scope)) {
      warnOnceAboutBundleScope(scope);
      continue;
    }
    if (isWithheldFromAllowlist(scope)) {
      warnOnceAboutWithheldBundleScope(scope);
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
// Plugin construction
// ---------------------------------------------------------------------------

export interface OauthProviderOptions {
  /** Per-process API key salt — shared with the bearer middleware so
   *  `hashApiKey(token, salt)` returns identical output, letting the
   *  middleware look up `auth_oauth_access_token.token` directly. */
  apiKeySalt: string;
  /** The Storage handle. Threaded into the custom-claim callbacks and the
   *  grant-projection after-hooks. */
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
export function buildOauthProviderPlugin(
  opts: OauthProviderOptions,
): ReturnType<typeof oauthProvider> {
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
    // The ceiling for the one path with no consent screen in front of it,
    // owned by `auth/mint-ceiling.ts` so the plugin option and the
    // Marfa-owned DCR mirror cannot drift. Without it the default falls
    // through to `scopes`, the ENTIRE allowlist with `*:write` included, so
    // a scope-less registration inherited everything.
    clientRegistrationDefaultScopes: dcrDefaultScopes(),

    // ----- Grants -----
    // **The grants this server has, stated once.** The plugin defaults to
    // its three and dispatches on that list, so leaving it unset and bolting
    // a refusal on in front of the token endpoint left the removal resting on
    // a hook: the endpoint still knew how to mint a client-credentials token,
    // the discovery document still advertised the grant, and a client reading
    // that document would pick the one path that cannot work. Named here, the
    // list is what `grant_types_supported` publishes and what the endpoint
    // checks before its switch, so the grant is absent rather than declined.
    //
    // The device-code URN is not here. It is a Marfa route rather than a
    // plugin grant (`POST /auth/device/token`), so the plugin has no handler
    // to reach for it, and the discovery document appends it separately. The
    // plugin's own registration validator does hold a client's `grant_types`
    // to this list, which would refuse a device-code registration -- and
    // never runs, because Marfa's `POST /oauth2/register` is mounted ahead of
    // the plugin's and validates and persists through its own store. The
    // plugin's client-management endpoints are fenced to 404 separately;
    // registration is shadowed rather than fenced, which `oauth-plugin-fence`
    // records.
    grantTypes: ["authorization_code", "refresh_token"],

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
      refreshToken: REFRESH_TOKEN_PREFIX,
    },

    // ----- Custom claims -----
    // Access tokens are opaque, deliberately: the DB lookup is sub-ms at
    // our scale, revocation stays clean, and scopes never ride inside a
    // token where they could outlive a narrowing. The claims here surface
    // on /oauth2/introspect responses, which the bearer middleware does
    // NOT call (it reads `auth_oauth_access_token` directly + joins
    // `system.connection`). Kept anyway so external resource servers
    // introspecting Marfa-issued tokens get a usable claim set.
    customAccessTokenClaims: ({ user, scopes }) => {
      const claims: Record<string, unknown> = {
        scope: scopes.join(" "),
      };
      if (user) claims.user_id = user.id;
      return claims;
    },

    // id_token claims (OIDC). Reproduces the profile + email gate from
    // the (now-deleted) homegrown /auth/userinfo handler.
    customIdTokenClaims: ({ user, scopes }) => {
      const claims: Record<string, unknown> = {};
      // **The union with Category 2, and it is the half that makes the gate
      // real.** `/oauth/userinfo` and the direct `/profile/*` routes are two
      // doors onto one resource rather than two resources, so a caller reads
      // if it holds the OIDC literal OR the corresponding profile scope.
      // Treating them as disjoint would leave this an ungated read path for
      // exactly the data the direct routes now protect, which is the same
      // defect in a second location rather than a fix.
      const profilePerms = scopesToProfilePermissions(scopes);
      const readsName =
        scopes.includes("profile") ||
        profilePermissionCovers(profilePerms, "name", "read");
      const readsEmail =
        scopes.includes("email") ||
        profilePermissionCovers(profilePerms, "email", "read");
      const readsAvatar =
        scopes.includes("profile") ||
        profilePermissionCovers(profilePerms, "avatar", "read");
      if (readsName) claims.name = user.name;
      if (readsAvatar && "image" in user && user.image) {
        claims.picture = user.image;
      }
      if (readsEmail) {
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
      // **The union with Category 2, and it is the half that makes the gate
      // real.** `/oauth/userinfo` and the direct `/profile/*` routes are two
      // doors onto one resource rather than two resources, so a caller reads
      // if it holds the OIDC literal OR the corresponding profile scope.
      // Treating them as disjoint would leave this an ungated read path for
      // exactly the data the direct routes now protect, which is the same
      // defect in a second location rather than a fix.
      const profilePerms = scopesToProfilePermissions(scopes);
      const readsName =
        scopes.includes("profile") ||
        profilePermissionCovers(profilePerms, "name", "read");
      const readsEmail =
        scopes.includes("email") ||
        profilePermissionCovers(profilePerms, "email", "read");
      const readsAvatar =
        scopes.includes("profile") ||
        profilePermissionCovers(profilePerms, "avatar", "read");
      if (readsName) claims.name = user.name;
      if (readsAvatar && "image" in user && user.image) {
        claims.picture = user.image;
      }
      if (readsEmail) {
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
// Projection plugin shell
// ---------------------------------------------------------------------------

/**
 * Tiny BetterAuthPlugin shell hosting the per-path hooks Marfa wraps
 * around the provider's own endpoints.
 *
 * **Why a plugin shell rather than top-level `hooks`?** Top-level `hooks`
 * on the betterAuth instance only accepts a single before/after callable;
 * PLUGIN-level hooks accept the array+matcher shape needed for per-path
 * routing. The shell carries no endpoints/schema/init of its own — it
 * exists purely to host the before-hook. Same pattern works for adding
 * future plugin-level hooks (additional path matchers) without touching
 * the instance.ts wiring.
 *
 * **Why projection and the person's own revoke stay in explicit routes
 * rather than hooks.** Each is owned by a Marfa-side handler that has the
 * verified context in scope and does the work deterministically:
 *   - consent projection + audit: `POST /auth/authorize/decision`
 *     (`routes/auth-consent.ts`) verifies the signed query, proxies to
 *     `/auth/oauth2/consent`, and projects only after the plugin returns a
 *     code-bearing registered callback. The explicit handler retains the
 *     verified client context needed to gate those side effects.
 *   - revoke cascade + audit for the person's Disconnect:
 *     `DELETE /auth/grants/:id` and `POST /auth/grants/:id/revoke`
 *     (`routes/auth-pages.ts`) run `revokeProjectedGrant` with the client
 *     and user already resolved from the grant record. The one revoke hook
 *     here, `cascadeClientRevoke`, is the client's side of the same
 *     transition: `/oauth2/revoke` takes a token in hand, and a refresh
 *     token resolves to its (client, user) row once the plugin has marked
 *     it, so the same cascade runs off that row.
 *   - `last_used_at` stamping: the bearer middleware stamps on every
 *     authenticated request via `stampOAuthGrantLastUsedByGrantKey`. A
 *     token-issuance after-hook would be redundant in the typical case
 *     (client uses the token immediately) and add a needless DB roundtrip.
 *
 * `apiKeySalt` is threaded in so the hooks that look a token up can
 * compute the same hash format the plugin uses (`hashApiKey(token, salt)`
 * via the custom `storeTokens.hash`): the refresh-replay guard, the code
 * guard, the client-revoke pair and the consent-skip audit. Without it
 * every one of them is omitted and the plugin still constructs, so an
 * instance with no salt keeps the plugin's own behavior on all four
 * surfaces, and the fourth's absence is the silent one: the audit row
 * simply stops being written. The salt is required in production, so that
 * shape is a test fixture's, not a deployment's.
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
    ? new Set([stripTrailingSlash(baseURL)].filter((v) => v.length > 0))
    : undefined;
  return {
    id: "marfa-oauth-projection" as const,
    hooks: {
      after: [
        {
          // Gives the authorize endpoint's failures a signal, and its own
          // consent skip an audit row. See `logAuthorizeOutcome` and
          // `auditProviderConsentSkip`.
          matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/authorize",
          handler: createAuthMiddleware((ctx: HookCtxLite) => {
            logAuthorizeOutcome(ctx);
            if (refreshHasher) {
              auditProviderConsentSkip(ctx, storage, refreshHasher);
            }
            return Promise.resolve();
          }),
        },
        ...(refreshHasher
          ? [
              {
                // A refresh token revoked by its client ends the grant it
                // belongs to. Second half of a pair; the first is the
                // before-hook below. See `cascadeClientRevoke`.
                matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/revoke",
                handler: createAuthMiddleware((ctx: HookCtxLite) =>
                  cascadeClientRevoke(ctx, storage),
                ),
              },
            ]
          : []),
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
                // Resolves the token a revoke presents before the plugin
                // can mark or delete its row, and hands the resolution to
                // the after-hook above. See `resolveClientRevoke`.
                matcher: (ctx: HookCtxLite) => ctx.path === "/oauth2/revoke",
                handler: createAuthMiddleware((ctx: HookCtxLite) =>
                  resolveClientRevoke(ctx, storage, refreshHasher),
                ),
              },
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
// The provider's own consent skip (after-hook)
// ---------------------------------------------------------------------------

/**
 * After-hook for `/oauth2/authorize`: when the plugin answers a request with
 * a code without showing the consent screen, write the `auth.grant.reused`
 * row Marfa's own skip writes.
 *
 * Two paths skip consent. Marfa's, on `GET /auth/authorize`, is reached when
 * the plugin has already redirected the browser to the consent page; it
 * emits `auth.grant.reused` itself. The plugin's own, inside its authorize
 * endpoint, finds a standing consent row covering the request and redirects
 * straight to the callback with a code, and Marfa's route never runs. Every
 * re-authorization by an app whose grant covers what it asks for takes the
 * second path, so the operator trail showed a grant being created once and
 * never used again, while the tokens kept being minted. "Every" means every
 * request the plugin's exact-membership check covered; a request covered
 * only by a pattern fell through to Marfa's page and was audited there.
 *
 * **A request off the wire, that succeeded, without the person asking to be
 * asked.** The plugin re-enters its own authorize endpoint from the consent
 * and continue endpoints, and from its sign-in resume, through
 * `runOAuth2Authorize`, which sets `authorizeSettings` on the context; a
 * request that arrived over HTTP has the field undefined, and that is the
 * whole of how the two are told apart. The sign-in resume is a wire-shaped
 * re-authorization this therefore skips, and that is safe only because of
 * two facts of this deployment: Marfa's sign-in returns to its own
 * `/auth/authorize` rather than posting the plugin's `oauth_query`, and no
 * `selectAccount` page is configured so `/oauth2/continue` is unreachable.
 * Adopting either reopens the gap.
 * A re-entry after a consent decision is a `created`, written by the
 * decision route, and must not also be a `reused`. `prompt=consent` means
 * the client asked for a fresh decision, and the plugin honors it by
 * rendering; if a code came back regardless, nothing was reused. Success is
 * a server-added `code` on the client's own `redirect_uri`, judged by
 * `serverAddedResponseParam` for the reason `logAuthorizeOutcome` gives.
 *
 * **Who, read from the code itself; what, from the request as the plugin
 * answered it.** The hook context carries no session, and the query names
 * the client but not the person. The authorization code the plugin just
 * minted does: its verification row carries `client_id` and `userId`, and
 * Marfa's store resolves it through the same hash the plugin stored it
 * under. That is one read of a row the plugin wrote a moment ago, and it
 * means the audit row names the person the code was minted for rather than
 * whoever the hook guessed. The scopes come from the request as the plugin
 * read it, the form body on a POST and the query on a GET, which is the
 * value the plugin minted for: the ceiling default when the request named
 * none, and the narrowing hook's rewrite when it dropped literals.
 * Marfa's own skip reads the same post-narrowing value, and deduplicates
 * it, so the two doors write one shape for one request. No request IP: the
 * hook context does not carry one, the same as the client-revoke cascade.
 *
 * Fire-and-forget, like the route's own emit: a reporting path must never
 * fail an authorization.
 */
function auditProviderConsentSkip(
  ctx: HookCtxLite,
  storage: Storage,
  hasher: (token: string) => string,
): void {
  try {
    if (ctx.authorizeSettings !== undefined) return;
    // The request as the plugin read it: the form body on a POST, the query
    // on a GET, through the same selection the narrowing hook uses. Reading
    // the query alone would miss a form-post skip entirely and let a caller
    // put its own `scope` on the row through the URL.
    const request = findAuthorizeRequest(ctx);
    if (!request) return;
    const params = request.params;
    const prompt = typeof params.prompt === "string" ? params.prompt : "";
    if (prompt.split(" ").includes("consent")) return;
    const location = redirectLocationOf(ctx.context?.returned);
    if (!location) return;
    const redirectUri =
      typeof params.redirect_uri === "string" ? params.redirect_uri : null;
    if (!serverAddedResponseParam(redirectUri, location, "code")) return;
    const code = new URL(location, "http://localhost").searchParams.get("code");
    if (!code) return;
    if (
      typeof storage.oauthProvider?.findAuthorizationCodeGrantKey !== "function"
    )
      return;
    const scopes =
      typeof params.scope === "string"
        ? [...new Set(params.scope.split(/\s+/).filter(Boolean))]
        : [];
    const provider = storage.oauthProvider;
    void provider
      .findAuthorizationCodeGrantKey(hasher(code))
      .then((row) => {
        if (!row) {
          // Not a race in practice (the code is stored before the redirect
          // is returned), so a miss is worth a line rather than silence.
          log("info", "provider consent skip: code not found, no audit row", {
            client_id: request.clientId,
          });
          return;
        }
        // A code minted with no consent row behind it is the plugin's
        // `skipConsent` path, not a reuse. Registration refuses that field
        // today and the code guard refuses such a code at exchange, so
        // this is the third fence rather than the first; it costs one read
        // already made.
        if (!row.hasConsent) return;
        return auditGrantReused(storage, {
          authUserId: row.userId,
          clientId: row.clientId,
          scopes,
          clientIp: null,
        });
      })
      .catch((err: unknown) => {
        log(
          "warn",
          "provider consent skip: auth.grant.reused audit emit failed",
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
      });
  } catch {
    // A reporting path must never fail a request.
  }
}

// ---------------------------------------------------------------------------
// Client-side revoke (a before-hook and an after-hook)
// ---------------------------------------------------------------------------

/** The prefix the plugin puts on refresh tokens and strips before hashing.
 *  One spelling, because the plugin option, the replay guard, the revoke
 *  pair and the device token step all have to agree on it. */
export const REFRESH_TOKEN_PREFIX = "marfa_rt_";

/** What the revoke before-hook establishes, for the after-hook to act on. */
interface RevokeResolution {
  /** The refresh row the presented token resolved to, as it stood before
   *  the plugin ran. */
  row: {
    clientId: string;
    userId: string;
    revoked: boolean;
  };
  /** The hash the row was found under, so the after-hook can ask whether
   *  the plugin deleted it. */
  tokenHash: string;
  /** The client the request authenticates as, resolved the way the plugin
   *  resolves it, or undefined where this code cannot (a client
   *  assertion). */
  presentedClientId: string | undefined;
}

/**
 * The plugin's own normalization of the `token` field: trimmed, and a
 * `Bearer ` or `DPoP ` scheme stripped, through the same function it calls.
 * A client that sends its token as it would in an Authorization header is
 * accepted by the plugin, so the hook has to see the same string or it
 * skips a revocation the plugin performed.
 */
function normalizeRevokeToken(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const stripped = stripAccessTokenAuthorizationScheme(raw.trim()).trim();
  return stripped.length > 0 ? stripped : undefined;
}

/**
 * The client a revoke request authenticates as, in the plugin's own order
 * of precedence: a client assertion first, then HTTP Basic, then the
 * `client_id` in the body. The order matters because the body field is not
 * an authentication attempt: the plugin admits `Authorization: Basic` beside
 * a bare body `client_id` and never compares the two, so a hook that read
 * the body first would take the caller's word over the credential the
 * plugin verified. An assertion is answered with undefined, since verifying
 * one is the plugin's job and nothing here should pretend to; the caller
 * treats that as "cannot tell" and does nothing.
 *
 * Exported for its test: the precedence is the security property, and the
 * shape that exercises it (a confidential client) is not one the store's
 * public-only registration mints.
 */
export function resolveRevokeClientId(input: {
  body: Record<string, unknown> | undefined;
  headers: Headers | null | undefined;
}): string | undefined {
  if (typeof input.body?.client_assertion === "string") return undefined;
  const authorization = input.headers?.get("authorization");
  if (authorization && /^basic\s+/i.test(authorization)) {
    // The plugin's own decoder, so the two cannot disagree about a form
    // encoding, a padding rule or a separator; a header it refuses is one
    // the plugin refuses too, and the hook then does nothing.
    try {
      return decodeBasicCredentials(authorization).clientId;
    } catch {
      return undefined;
    }
  }
  const fromBody = input.body?.client_id;
  return typeof fromBody === "string" && fromBody.length > 0
    ? fromBody
    : undefined;
}

/**
 * Before-hook for `/oauth2/revoke`: resolve the presented refresh token to
 * its row while the row is still as the client left it.
 *
 * The plugin's own handling of a refresh token stops at the token. It marks
 * the presented row revoked and deletes the access tokens under it, and
 * nothing more: the consent row stands, so the next authorize is answered
 * silently with a fresh code, and the `system.connection` projection
 * stands, so the security page keeps listing an app that has asked to be
 * forgotten. And when the presented token is a rotated-out one, which is
 * the ordinary state after any refresh because rotation marks the old row
 * and keeps it, the plugin treats the request as a replay and deletes the
 * whole family, so every token of the grant is gone while both grant
 * records survive. RFC 7009 is the one thing a client can do to say
 * "disconnect me", and an app that did it correctly was still connected.
 *
 * **Why a before-hook exists at all.** The after-hook cannot learn from the
 * response what happened: the plugin answers a success and the cross-client
 * no-op both with an empty 200, and answers an unknown token and a replayed
 * one with a 400 rather than the 200 RFC 7009 §2.2 asks for (its
 * `error.name === "BAD_REQUEST"` branch never matches, since `APIError.name`
 * is `"APIError"`), and on the replay path the row is deleted before any
 * after-hook can read it. So the row is read here, before the plugin runs,
 * together with the client the request authenticates as, and the pair is
 * handed forward through the context merge Better Auth performs on a
 * before-hook's returned `context`. Nothing is written here; a before-hook
 * runs ahead of the plugin authenticating the client, and a write above
 * that line would be one an unauthenticated caller could drive. The one
 * read it does perform, an indexed lookup on a hash the caller chose, is
 * bounded by the endpoint's own per-IP cap and discloses nothing to the
 * caller.
 */
async function resolveClientRevoke(
  ctx: HookCtxLite,
  storage: Storage,
  hasher: (token: string) => string,
): Promise<{ context: { revokeResolution: RevokeResolution } } | undefined> {
  try {
    const body = ctx.body;
    if (!body || typeof body !== "object") return undefined;
    if (body.token_type_hint === "access_token") return undefined;
    const token = normalizeRevokeToken(body.token);
    if (!token?.startsWith(REFRESH_TOKEN_PREFIX)) return undefined;
    const provider = storage.oauthProvider;
    if (typeof provider?.findRefreshTokenGrantKey !== "function")
      return undefined;
    const tokenHash = hasher(token.slice(REFRESH_TOKEN_PREFIX.length));
    const row = await provider.findRefreshTokenGrantKey(tokenHash);
    if (!row) return undefined;
    return {
      context: {
        revokeResolution: {
          row,
          tokenHash,
          presentedClientId: resolveRevokeClientId({
            body,
            headers: ctx.headers,
          }),
        },
      },
    };
  } catch (err) {
    // Fail open to the plugin: a lookup fault must not refuse a revocation.
    log("warn", "oauth client revoke: token precheck failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * After-hook for `/oauth2/revoke`: end the grant a revoked refresh token
 * belongs to, when the plugin did revoke it.
 *
 * Decided from the before-hook's resolution and one fact about the plugin's
 * run, never from the response body. The row's client has to be the client
 * the request authenticated as; the plugin no-ops a mismatch and so does
 * this, and repeating the check here is what stops a stolen refresh token
 * presented under another registration from becoming a way to disconnect
 * somebody else's app. Then either the plugin answered success, which for
 * a refresh token means it marked the row, or the row the before-hook saw
 * is gone, which only the plugin's replay path does and only after deleting
 * every token of the grant. In both the tokens are dead and the two grant
 * records have to agree with that. A row still there and unmarked behind a
 * refusal (client authentication failed, a malformed request) means the
 * plugin touched nothing, and neither does this; a row still there but
 * marked means the plugin marked it and then failed on the access-token
 * delete behind it, which is a partial run and cascades.
 *
 * Two shapes to know about. Two requests presenting the same live token at
 * once both cascade: the loser meets the plugin's replay path, its row is
 * gone by the time it looks, and it writes a second audit row over a
 * cascade the winner already ran. The write is convergent under the
 * consent lock, so nothing corrupts, and the second row names the same
 * client. And a row deleted between the two hooks by anything else, such
 * as the person's Disconnect landing in the same instant, cascades here
 * too and is audited as the client's; idempotent, and a row nobody will
 * ever act on.
 *
 * **Best-effort past the plugin's own work, and honest about what a
 * failure leaves.** The cascade runs the tokens, the consent row, the
 * device codes and then the projection, and a fault partway through can
 * leave the consent row gone with the projection active. The response is
 * still the plugin's 200, because the tokens under the presented token are
 * already gone and refusing would tell the client to retry a revocation
 * that cannot be retried (the plugin has forgotten the token). The failure
 * is logged at error naming the grant, and the person's Disconnect or the
 * operator key's client delete puts the records right. The person's own
 * Disconnect makes the opposite call and fails loud, because there the
 * cascade is the whole of the work.
 */
async function cascadeClientRevoke(
  ctx: HookCtxLite,
  storage: Storage,
): Promise<void> {
  const resolution = ctx.revokeResolution;
  if (!resolution) return;
  const { row, tokenHash, presentedClientId } = resolution;
  const provider = storage.oauthProvider;
  if (
    typeof provider?.findRefreshTokenGrantKey !== "function" ||
    typeof provider.findGrantItemId !== "function" ||
    typeof provider.revokeTokensForGrant !== "function"
  )
    return;
  if (presentedClientId !== row.clientId) {
    log("warn", "oauth client revoke: token belongs to another client", {
      presented_client_id: presentedClientId,
      token_client_id: row.clientId,
    });
    return;
  }
  let grantItemId: string | null = null;
  try {
    const returned = ctx.context?.returned;
    const succeeded = returned === null || returned === undefined;
    if (!succeeded) {
      const after = await provider.findRefreshTokenGrantKey(tokenHash);
      if (after && !after.revoked) {
        // Refused before touching the row: nothing to agree with.
        return;
      }
      // Either the replay path, where the family is gone, or a row the
      // plugin marked and then failed behind (its access-token delete
      // threw): in both the tokens the client holds are dead and the grant
      // records have to follow.
    }

    grantItemId = await provider.findGrantItemId({
      clientId: row.clientId,
      authUserId: row.userId,
    });
    const item = grantItemId ? await storage.items.get(grantItemId) : null;
    await revokeProjectedGrant(storage, {
      itemId: item ? item.id : null,
      properties: item?.properties,
      clientId: row.clientId,
      authUserId: row.userId,
    });
    auditGrantRevoked(storage, {
      clientId: row.clientId,
      authUserId: row.userId,
      grantItemId: item ? item.id : null,
      clientIp: null,
      source: "client",
    });
    log("info", "oauth client revoke: grant ended", {
      client_id: row.clientId,
      user_id: row.userId,
      grant_item_id: item ? item.id : null,
    });
  } catch (err) {
    log("error", "oauth client revoke: grant cascade failed", {
      client_id: row.clientId,
      user_id: row.userId,
      grant_item_id: grantItemId,
      repair:
        "the grant's records may disagree; Disconnect on the security page or POST /admin/oauth-clients/{client_id}/delete repairs them",
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
 *  3. **Active token with no space → `invalid_grant` (400).** The plugin
 *     copies the presented token's `reference_id` onto the rotated one
 *     rather than resolving it again, so an unbound token rotates into
 *     another unbound token and the bearer middleware turns every request
 *     through it away. Refusing here is what puts a reason in front of a
 *     client, and this is the only grant that reaches a mint without a code,
 *     so no other guard covers it.
 *
 * Every other active token falls through to the plugin's rotation. Any
 * failure of the lookup itself fails open (logs, returns) so a transient DB
 * blip never turns a legitimate refresh into a hard error.
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

/**
 * What a token request is asking for, read once so every guard on
 * `/oauth2/token` reads it the same way.
 *
 * Each guard below turns on an equality against a literal, and an equality
 * against a raw body value is only as strong as what the body may hold. Two
 * shapes are the reason this exists. A `grant_type` that is not a string
 * reaches a comparison with an array or an object, which is a way a strict
 * equality quietly says "no" and skips a guard. And a value spelled with
 * surrounding whitespace is the same request to anything that trims and a
 * different one to anything that does not, so a guard reading it raw would
 * decline to run on a request another reader treats as the grant it names.
 *
 * The endpoint itself is strict rather than tolerant: it matches `grant_type`
 * against the supported list exactly, so a padded value is refused there
 * rather than dispatched. This keeps the guards and the endpoint answering
 * about the same request; it is not the only thing between a padded body and
 * a mint.
 */
function requestedGrantType(ctx: HookCtxLite): string | undefined {
  const body = ctx.body;
  if (!body || typeof body !== "object") return undefined;
  const raw = body.grant_type;
  return typeof raw === "string" ? raw.trim() : undefined;
}

async function guardRefreshTokenGrant(
  ctx: HookCtxLite,
  storage: Storage,
  hasher: (token: string) => string,
): Promise<void> {
  const body = ctx.body;
  if (!body || typeof body !== "object") return;
  if (requestedGrantType(ctx) !== "refresh_token") return;
  const refreshTokenRaw = body.refresh_token;
  if (typeof refreshTokenRaw !== "string" || refreshTokenRaw.length === 0)
    return;
  if (typeof storage.oauthProvider?.findRefreshTokenGrantKey !== "function")
    return;

  // The plugin strips the `prefix.refreshToken` (`marfa_rt_`) in its
  // `decodeRefreshToken` step, BEFORE calling our hasher. Strip here too so
  // the hash matches the stored value.
  const bare = refreshTokenRaw.startsWith(REFRESH_TOKEN_PREFIX)
    ? refreshTokenRaw.slice(REFRESH_TOKEN_PREFIX.length)
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
  if (!row.revoked) {
    return; // active — let the plugin rotate
  }

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
 * Fails open on a lookup error and on an unrecognized code: the plugin owns
 * the real validation, and a transient database blip must not turn a
 * legitimate exchange into a hard failure.
 *
 * **The space check below is the one exception, and it is deliberate.** The
 * plugin resolves a grant's space at authorize time and stores it on the
 * code, so nothing downstream asks the question again: failing open here
 * mints the unbound token this check exists to prevent, which is the one
 * outcome worse than a refusal. It answers 503 rather than the plugin's bare
 * 500, so a client reads a retryable reason instead of an empty body.
 */
async function guardAuthorizationCodeGrant(
  ctx: HookCtxLite,
  storage: Storage,
  hasher: (token: string) => string,
): Promise<void> {
  const body = ctx.body;
  if (!body || typeof body !== "object") return;
  if (requestedGrantType(ctx) !== "authorization_code") return;
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
