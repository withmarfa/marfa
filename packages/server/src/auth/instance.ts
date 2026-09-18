import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { createLocalAccountIssuer } from "better-auth/db";
import * as sqliteSchema from "../storage/sqlite/schema.js";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
import {
  buildOauthProviderPlugin,
  buildOauthProjectionPlugin,
} from "./oauth-provider.js";
import { withIdempotentConsent } from "./consent-idempotent-adapter.js";

/**
 * The first parameter type of better-auth's drizzleAdapter — used to type
 * the `db` handle threaded through `MarfaAuthOptions` so the call site no
 * longer needs an `as never` escape hatch (§3.13). When better-auth bumps
 * and tightens the adapter signature, this alias surfaces the mismatch
 * at compile time at the consumer rather than masking it with a cast.
 */
type DrizzleAdapterDb = Parameters<typeof drizzleAdapter>[0];

/**
 * Constructs the better-auth instance. Plug into the storage factory's
 * `betterAuthDb` handle. Consumed by `app.ts` to mount the catch-all
 * handler under `/auth/*`.
 */

export interface MarfaAuthOptions {
  /** Drizzle handle from the storage factory. Typed against better-auth's
   *  `drizzleAdapter` first-parameter so the call site is statically
   *  checked without an `as never` cast. The Storage interface widens it
   *  to `unknown` (BetterAuthStorageAdapter trait); narrowing happens
   *  here at the only consumer. */
  db: DrizzleAdapterDb;
  /** Hosting issuer URL — protocol + host (and port) the server is reached
   *  at. Used by better-auth to set cookie domains and base paths.
   *  In dev this is typically `http://localhost:8600`. */
  baseURL: string;
  /** Shared secret used to sign cookies and the OAuth authorize query.
   *  When unset, falls back to `BETTER_AUTH_SECRET` / `AUTH_SECRET` and
   *  then to a per-process ephemeral secret — fine for dev (sessions
   *  don't survive a restart), not safe for production. Production
   *  deployments must set `MARFA_AUTH_SECRET`. */
  secret?: string;
  /** Origins permitted to make credentialed (cookie) requests against
   *  the auth surface. Defaults to the `baseURL` plus any `corsOrigins`
   *  from `AppConfig`. */
  trustedOrigins?: string[];
  /** Header carrying the real client address, for deployments where a
   *  proxy terminates the connection. Better Auth keys its own rate
   *  limiter on the address it resolves, and reads `x-forwarded-for`
   *  unless told otherwise; a platform that sends something else instead
   *  leaves it with no address at all, and it then buckets every caller
   *  in the world together on one shared key. Mirrors the value the
   *  client-IP and rate-limit middleware already take, so one setting
   *  answers for the whole server. Left unset, Better Auth's
   *  `x-forwarded-for` default stands, which is what an ordinary reverse
   *  proxy sends, so a self-hoster configures nothing. */
  trustedProxyHeader?: string | null;
  /** Storage handle threaded into the OAuth Provider plugin's
   *  `customAccessTokenClaims` and `hooks.after` matchers. Needed for the
   *  `system.connection` projection of the plugin's grant lifecycle. */
  storage?: Storage;
  /** Per-process API key salt — shared with the bearer middleware so the
   *  plugin's `storeTokens.hash` and the middleware's hash output match,
   *  letting the middleware look up `auth_oauth_access_token.token`
   *  directly by computing the same hash. */
  apiKeySalt?: string;
}

/**
 * Minimal structural view of the Better Auth runtime context the
 * account-creation seam reaches for. The full `AuthContext` lives in
 * `@better-auth/core`, which is not a dependency here and drags in generic
 * machinery this needs none of — the same trade
 * `consent-idempotent-adapter.ts` makes for the adapter surface.
 *
 * The trade has a cost worth stating: nothing checks this shape against
 * Better Auth's real one, so a rename in a minor bump compiles clean and
 * fails at runtime. `instance.test.ts` is what catches that, by signing in
 * as an account this path created.
 */
interface BetterAuthCredentialContext {
  password: {
    hash: (password: string) => Promise<string>;
    config: { minPasswordLength: number; maxPasswordLength: number };
  };
  internalAdapter: {
    findUserByEmail: (
      email: string,
    ) => Promise<{ user: { id: string } } | null>;
    createUser: (
      user: Record<string, unknown>,
      source: { method: string },
    ) => Promise<{ id: string; email: string } | null>;
    linkAccount: (account: Record<string, unknown>) => Promise<unknown>;
  };
}

/**
 * The outcome of `createEmailAccount`. Refusals are values rather than
 * throws because each maps to a different answer for the caller, and a
 * caller that forgets one gets a compile error instead of a 500.
 */
export type CreateEmailAccountResult =
  | { ok: true; authUserId: string; email: string }
  | { ok: false; reason: "email_exists" }
  | { ok: false; reason: "password_too_short"; minLength: number }
  | { ok: false; reason: "password_too_long"; maxLength: number };

/** Authenticated user on a Better Auth session. Reduced surface — only the
 *  fields the OAuth consent flow currently consumes. */
export interface MarfaAuthSessionUser {
  id: string;
  email: string;
  name?: string | null;
}

/** A live Better Auth session (cookie-backed). */
export interface MarfaAuthSession {
  user: MarfaAuthSessionUser;
  session: { id: string };
}

/** Narrow public type — covers everything `app.ts` and future routes need
 *  without re-exporting the full Better Auth generic surface (which drags
 *  in zod internal types and breaks portable .d.ts emit). */
export interface MarfaAuth {
  handler: (request: Request) => Promise<Response>;
  /**
   * Session lookup over the request's cookies. Returns the active
   * Better Auth session, or `null` if no valid cookie is present. The
   * OAuth consent flow uses this to gate `/auth/authorize` without
   * requiring admin bearer tokens.
   */
  getSession: (headers: Headers) => Promise<MarfaAuthSession | null>;
  /**
   * Create an email + password account without going through sign-up.
   *
   * `POST /auth/sign-up/email` is the only endpoint that mints a password
   * account, and it refuses on every instance because `disableSignUp` is
   * set unconditionally. This runs the same machinery the endpoint does:
   * Better Auth's own hasher and its internal adapter. The address arrives
   * already proven, because whoever calls this asked for the account
   * rather than a stranger claiming it.
   *
   * No HTTP door calls this. It is the programmatic seam the test harness
   * uses to put a user behind the OAuth provider's sign-in page; how an
   * instance gets its first user is an open design question, not this
   * function's decision.
   */
  createEmailAccount: (params: {
    email: string;
    password: string;
    name?: string;
  }) => Promise<CreateEmailAccountResult>;
  /** Resolves once Better Auth has finished building its context. Never
   *  rejects: a failure is logged and left for the per-request path to
   *  surface. Callers that need a settled instance await this. */
  ready: Promise<void>;
  /** Public-facing issuer URL the instance advertises (drives
   *  `verification_uri` in the Device Authorization Grant response,
   *  the OAuth issuer field on the discovery doc, and the cookie
   *  domain). Mirrors `MARFA_AUTH_BASE_URL`. */
  baseURL: string;
  /** The secret Better Auth signs with, after resolution — the
   *  configured value, an environment fallback, or a per-process
   *  ephemeral one. Exposed so the consent route can verify the OAuth
   *  Provider plugin's signed authorize query against the same value the
   *  plugin signed it with. Never log or serialize it. */
  signingSecret: string;
  api: unknown;
}

export function createMarfaAuth(options: MarfaAuthOptions): MarfaAuth {
  const schema = {
    user: sqliteSchema.auth_user,
    session: sqliteSchema.auth_session,
    account: sqliteSchema.auth_account,
    verification: sqliteSchema.auth_verification,
    oauthClient: sqliteSchema.auth_oauth_client,
    oauthAccessToken: sqliteSchema.auth_oauth_access_token,
    oauthRefreshToken: sqliteSchema.auth_oauth_refresh_token,
    oauthConsent: sqliteSchema.auth_oauth_consent,
    jwks: sqliteSchema.auth_jwks,
  };

  // Better Auth resolves its signing secret from `secret`, then
  // BETTER_AUTH_SECRET / AUTH_SECRET, then a constant that ships inside
  // the published package. Resolve it here and pass the result
  // explicitly instead, for two reasons. The consent route has to verify
  // the OAuth Provider plugin's signed authorize query, and a verifier
  // reading a different value than the signer used fails open. And an
  // instance that configured nothing should not end up signing with a
  // secret anyone can read off npm. `MARFA_AUTH_SECRET` is mandatory in
  // production, so the ephemeral branch is dev-only — where a restart
  // invalidating sessions is the documented behavior.
  const configuredSecret = [
    options.secret,
    process.env.BETTER_AUTH_SECRET,
    process.env.AUTH_SECRET,
  ].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  );
  const signingSecret = configuredSecret ?? randomBytes(32).toString("hex");

  const instance = betterAuth({
    baseURL: options.baseURL,
    basePath: "/auth",
    secret: signingSecret,
    trustedOrigins: options.trustedOrigins,
    logger: {
      disabled: false,
      level: "info",
      log: (level, message, ...args) => {
        const mapped = level === "debug" ? "info" : level;
        log(
          mapped,
          `Better Auth: ${message}`,
          args.length > 0 ? { args } : undefined,
        );
      },
    },
    // Wrap the drizzle adapter so a `create` on the `oauthConsent` model
    // upserts on `(clientId, userId)` instead of blindly inserting — see
    // `consent-idempotent-adapter.ts`. Paired with the unique constraint
    // on `auth_oauth_consent (client_id, user_id)`; neither half is safe
    // to ship without the other.
    database: withIdempotentConsent(
      drizzleAdapter(options.db, { provider: "sqlite", schema }),
    ),
    emailAndPassword: {
      enabled: true,
      // Auto-sign-in keeps the consent flow seamless when an account
      // approves an OAuth client on first visit.
      autoSignIn: true,
      // There is no self-service sign-up. Accounts are created through
      // `createEmailAccount` only.
      disableSignUp: true,
    },
    plugins: [
      // JWT plugin for id_token signing. The oauth-provider plugin
      // requires it (id_tokens are always JWT) unless
      // `disableJwtPlugin: true` is set — which forces id_tokens to
      // HS256 with the client_secret, breaking public PKCE clients that
      // have no secret. Auto-generates an RSA key pair on first use,
      // stored in `auth_jwks`.
      jwt(),
      ...(options.storage && options.apiKeySalt
        ? [
            buildOauthProviderPlugin({
              storage: options.storage,
              apiKeySalt: options.apiKeySalt,
              baseURL: options.baseURL,
            }),
            // Sibling shell plugin hosting the refresh-replay before-hook,
            // the client-revoke pair and the consent-skip audit. Consent
            // projection and grant revocation remain in the Marfa route
            // handlers that hold the verified client/user context; the two
            // audit emits in the shell read theirs off the plugin's own rows.
            buildOauthProjectionPlugin({
              storage: options.storage,
              apiKeySalt: options.apiKeySalt,
              baseURL: options.baseURL,
            }),
          ]
        : []),
    ],
    advanced: {
      // Better Auth's trusted-origins check is a real defense on this
      // surface: every Marfa-owned auth route that wraps a Better Auth
      // endpoint dispatches an internal cookie-bearing POST, and the
      // check is what stops an origin-less one from being honored. Left
      // unset, Better Auth turns the check OFF whenever it detects a test
      // environment — which would let a regression in that dispatch ship
      // green, since the tests would be the only place it never runs.
      // Setting it explicitly makes tests exercise the production path.
      // `false` matches what an unset value already resolves to outside
      // tests, so deployed behavior is unchanged.
      disableOriginCheck: false,
      // Better Auth resolves a client address for its own rate limiter,
      // and the limiter is the reason this matters: with no address it
      // keys every request on one literal string, so three failed
      // sign-ins from anyone lock out everyone. Its default header is
      // `x-forwarded-for`, which is what an ordinary reverse proxy sends
      // and why the fallback is the unset case rather than a named
      // header. A platform that sends a different one configures it, and
      // the same value already tells the client-IP and rate-limit
      // middleware where to look.
      ...(options.trustedProxyHeader && {
        ipAddress: { ipAddressHeaders: [options.trustedProxyHeader] },
      }),
      // Cookies set on /auth/*; the data plane (/items, /edges, etc.)
      // remains bearer-only and does not consume this cookie.
      cookiePrefix: "marfa.auth",
      defaultCookieAttributes: {
        httpOnly: true,
        // `Secure` is conditional on the auth baseURL using HTTPS.
        // Chrome silently drops `Secure` cookies on plain-HTTP origins
        // except localhost — including HTTP-over-Tailscale, intranet
        // hostnames, and dev deploys behind reverse proxies that
        // terminate TLS upstream. Hardcoding `secure: true` made the
        // session cookie unstoreable in those cases, breaking sign-in
        // entirely. HttpOnly + SameSite=Lax remain unconditional.
        secure: options.baseURL.startsWith("https://"),
        sameSite: "lax",
      },
    },
  });

  // Better Auth builds its context asynchronously and starts that work
  // at construction, but nothing awaits the promise until the first
  // request touches the handler. Anything that rejects inside plugin
  // init therefore surfaces as an unhandled rejection — which, with no
  // handler installed, terminates the process at boot. Attaching here
  // converts that into a logged failure: the auth surface then fails per
  // request, the way every other unreachable dependency does, instead of
  // taking the whole server with it.
  const ready = (
    instance as unknown as { $context: Promise<unknown> }
  ).$context.then(
    () => undefined,
    (err: unknown) => {
      log("error", "auth initialization failed; auth requests will error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    },
  );

  // Wrap better-auth's session-lookup API behind a narrow promise.
  // `getSession` resolves to `null` when no valid cookie is present —
  // either no cookie at all, or a cookie whose session has expired or
  // been signed out. Errors propagate (e.g. a malformed JWT throws).
  const api = instance.api as {
    getSession: (params: {
      headers: Headers;
    }) => Promise<MarfaAuthSession | null>;
  };

  // Account creation. Deliberately reads the built context rather than
  // calling `api.signUpEmail`: that endpoint answers
  // `EMAIL_PASSWORD_SIGN_UP_DISABLED` on every instance.
  //
  // The order below is sign-up's own, and the reasons are its reasons.
  // Hash before anything is written, so a hasher that throws throws
  // before a user row exists. Create the user through the internal
  // adapter. Then link the credential account with the issuer Better
  // Auth's own credential lookup keys on — imported rather than spelled
  // here, because a literal would keep working until the day the format
  // moved and then fail as "wrong password" with nothing naming the cause.
  const createEmailAccount = async (params: {
    email: string;
    password: string;
    name?: string;
  }): Promise<CreateEmailAccountResult> => {
    const authContext = await (
      instance as unknown as { $context: Promise<BetterAuthCredentialContext> }
    ).$context;
    const { minPasswordLength, maxPasswordLength } =
      authContext.password.config;
    if (params.password.length < minPasswordLength) {
      return {
        ok: false,
        reason: "password_too_short",
        minLength: minPasswordLength,
      };
    }
    if (params.password.length > maxPasswordLength) {
      return {
        ok: false,
        reason: "password_too_long",
        maxLength: maxPasswordLength,
      };
    }
    const email = params.email.toLowerCase();
    if (await authContext.internalAdapter.findUserByEmail(email)) {
      return { ok: false, reason: "email_exists" };
    }
    const password = await authContext.password.hash(params.password);
    // The column is NOT NULL, so a name that is absent or blank falls back
    // to the address's local part.
    const submittedName = params.name?.trim() ?? "";
    const name =
      submittedName === "" ? (email.split("@")[0] ?? email) : submittedName;
    let user: { id: string; email: string } | null;
    try {
      user = await authContext.internalAdapter.createUser(
        { email, name, emailVerified: true },
        { method: "email-password" },
      );
    } catch (err) {
      // The lookup above is a fast path, not a lock, so two callers
      // creating one address both pass it and the second meets the unique
      // index on `auth_user.email` — nothing of this call's was written,
      // and "it already exists" is the truth. Read rather than matched on
      // driver-specific constraint text, which would silently stop
      // matching on an upgrade.
      if (await authContext.internalAdapter.findUserByEmail(email)) {
        return { ok: false, reason: "email_exists" };
      }
      throw err;
    }
    if (!user) {
      throw new Error("better-auth created no user");
    }
    // The user and account writes are not one transaction, because the
    // helper that opens one is not reachable from here. A `linkAccount`
    // that throws therefore leaves a user with no password, which a retry
    // then refuses as a duplicate. It takes a database failure to reach,
    // and the caller sees the throw rather than a pretended success.
    await authContext.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      accountId: user.id,
      password,
    });
    return { ok: true, authUserId: user.id, email: user.email };
  };

  return {
    handler: instance.handler,
    api: instance.api,
    getSession: (headers: Headers) => api.getSession({ headers }),
    createEmailAccount,
    ready,
    baseURL: options.baseURL,
    signingSecret,
  };
}
