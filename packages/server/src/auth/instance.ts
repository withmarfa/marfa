import { rememberRecentAuthentication } from "./request-authority.js";
import { changeOwnerPassword, requireOwnerSession } from "./instance-claim.js";
import {
  requireOwnerOrigin,
  requireSecureOwnerTransport,
} from "./owner-browser.js";
import { withSessionEndAudit } from "./session-end-audit.js";
import {
  CredentialPersistencePhase,
  credentialRequest,
  withCredentialAudit,
  withCredentialRequest,
} from "./credential-adapter.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import type { AuditLogEntry } from "../storage/interface.js";
import { betterAuth } from "better-auth";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { oauthDeviceAuthorization } from "@better-auth/oauth-provider";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { isAPIError } from "better-auth/api";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import * as sqliteSchema from "../storage/sqlite/schema.js";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
import {
  buildOauthProviderPlugin,
  buildOauthProjectionPlugin,
  makeTokenHasher,
  refuseOfflineWithoutRefresh,
} from "./oauth-provider.js";
import { withIdempotentConsent } from "./consent-idempotent-adapter.js";
import { withHashedDeviceCodes } from "./hashed-device-code-adapter.js";
import { CLIENT_ADDRESS_HEADER } from "../middleware/client-ip.js";
import { buildSignInThrottlePlugin } from "./sign-in-throttle.js";
import { errorMessage } from "../error-text.js";
import { diskFull } from "../storage/disk-space.js";
import { parseCookies } from "better-auth/cookies";
import { generateCookie } from "hono/cookie";

/**
 * The first parameter type of better-auth's `drizzleAdapter`, so the `db`
 * handle threaded through `MarfaAuthOptions` is checked against it without
 * a cast: when better-auth tightens the adapter signature, the mismatch
 * surfaces at compile time at the consumer.
 */
type DrizzleAdapterDb = Parameters<typeof drizzleAdapter>[0];

/**
 * Constructs the better-auth instance. Plug into the storage factory's
 * `betterAuthDb` handle. Consumed by `app.ts` to mount the catch-all
 * handler under `/auth/*`.
 */

export interface MarfaAuthOptions {
  /** Drizzle handle from the storage factory. Typed against better-auth's
   *  `drizzleAdapter` first parameter so the call site is checked without a
   *  cast. The Storage interface widens it to `unknown`
   *  (`BetterAuthStorageAdapter`); narrowing happens here at the only
   *  consumer. */
  db: DrizzleAdapterDb;
  /** Hosting issuer URL — protocol + host (and port) the server is reached
   *  at. Used by better-auth to set cookie domains and base paths.
   *  In dev this is typically `http://localhost:8600`. */
  baseURL: string;
  /** Signs cookies and the OAuth authorize query: `MARFA_AUTH_SECRET`,
   *  or the per-process one the settings mint outside production. */
  secret: string;
  /** Origins permitted to make credentialed (cookie) requests against
   *  the auth surface. Defaults to the `baseURL` plus any `corsOrigins`
   *  from `AppConfig`. */
  trustedOrigins?: string[];
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
 * fails at runtime. `routes/owner.test.ts` is what catches that, by signing in
 * as an account this path created.
 */
interface BetterAuthCredentialContext {
  password: {
    hash: (password: string) => Promise<string>;
    config: { minPasswordLength: number; maxPasswordLength: number };
    verify: (input: { hash: string; password: string }) => Promise<boolean>;
  };
  internalAdapter: {
    findUserByEmail: (
      email: string,
    ) => Promise<{ user: { id: string } } | null>;
    createUser: (
      user: Record<string, unknown>,
      source: { method: string },
    ) => Promise<{
      id: string;
      email: string;
      name: string;
      createdAt: Date;
    } | null>;
    linkAccount: (account: Record<string, unknown>) => Promise<unknown>;
    findAccounts: (
      userId: string,
    ) => Promise<{ providerId: string; password?: string | null }[]>;
    updatePassword: (userId: string, password: string) => Promise<void>;
    deleteUserSessions: (userId: string) => Promise<void>;
    listSessions: (userId: string) => Promise<ProviderSessionRow[]>;
    deleteSessions: (tokens: string[]) => Promise<void>;
    deleteSession: (token: string) => Promise<void>;
    findSession: (
      token: string,
    ) => Promise<{ session: ProviderSessionRow } | null>;
    updateSession: (
      token: string,
      session: { expiresAt: Date; updatedAt: Date },
    ) => Promise<ProviderSessionRow | null>;
  };
  authCookies: {
    sessionToken: { name: string; attributes: CookieAttributes };
    dontRememberToken: { name: string };
  };
}

/** The provider's cookie attributes, which are the cookie helper's own. */
type CookieAttributes = NonNullable<Parameters<typeof generateCookie>[2]>;

/** A row of the provider's session table, as its internal adapter returns it. */
interface ProviderSessionRow {
  id: string;
  token: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** How long a browser session lasts unused: a week from its last use. */
export const BROWSER_SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60;

/**
 * How often a use is recorded. Recording each request would make every read
 * a browser sends wait for the write lock, so a use within this long of the
 * last recorded one is not written.
 */
export const BROWSER_SESSION_USE_INTERVAL_SECONDS = 60;

/**
 * A session's lifetime from its last recorded use. The interval is added so
 * that a use the interval left unrecorded still has its whole idle week: a
 * session ends between a week and a week and a minute after its last use.
 */
export const BROWSER_SESSION_LIFETIME_SECONDS =
  BROWSER_SESSION_IDLE_SECONDS + BROWSER_SESSION_USE_INTERVAL_SECONDS;

/**
 * The session cookie's lifetime in the browser: 400 days, the most a browser
 * keeps a cookie. The stored session is the only clock, so the cookie only
 * has to outlive it; one that tracked the stored expiry would be dropped
 * early whenever the answer that renewed the session failed to reach the
 * browser, and resending it on every answer stops the browser restoring a
 * page from its back-forward cache.
 */
export const BROWSER_SESSION_COOKIE_SECONDS = 400 * 24 * 60 * 60;

/** A live browser session of the owner, never carrying its token. */
export interface BrowserSession {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

/** The session a request was admitted on, and the cookie that renews it. */
export interface SessionUse {
  session: MarfaAuthSession;
  /** A `Set-Cookie` value carrying the browser's own cookie for
   *  {@link BROWSER_SESSION_COOKIE_SECONDS}, or `null` when this request
   *  recorded no use or the cookie lives only as long as the browser. */
  cookie: string | null;
  /** The session cookie's name, so a response that sets it itself wins. */
  cookieName: string;
}

/**
 * The outcome of `createEmailAccount`. Refusals are values rather than
 * throws because each maps to a different answer for the caller, and a
 * caller that forgets one gets a compile error instead of a 500.
 */
export type CreateEmailAccountResult =
  | {
      ok: true;
      authUserId: string;
      email: string;
      name: string;
      createdAt: Date;
    }
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
  session: {
    id: string;
    token: string;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
    /** The `User-Agent` the browser signed in with. */
    userAgent?: string | null;
  };
}

/** What the device plugin answers about a user code. `clientId` and `scope`
 *  are present only for the person who claimed the code, which is what the
 *  consent screen renders from. */
export type DeviceCodeVerdict =
  | {
      ok: true;
      status: "pending" | "approved" | "denied";
      clientId?: string;
      scope?: string;
    }
  | { ok: false; reason: DeviceCodeRefusal };

/** Why the device plugin refused a step. */
export type DeviceCodeRefusal =
  | "invalid_code"
  | "expired_code"
  | "already_resolved"
  | "not_claimed"
  | "forbidden"
  | "unauthorized";

/** Narrow public type — covers everything `app.ts` and future routes need
 *  without re-exporting the full Better Auth generic surface (which drags
 *  in zod internal types and breaks portable .d.ts emit). */
export interface PreparedPassword {
  hash: string;
  previousHash?: string;
}

export interface MarfaAuth {
  /**
   * Serve a request through Better Auth, as coming from `clientAddress`:
   * the address `clientIpMiddleware` resolved, which Better Auth keys its
   * limiter on and records on a session. Taken here rather than read off
   * the request so that no way of reaching Better Auth can leave it to
   * trust a header the client set.
   */
  handler: (
    request: Request,
    clientAddress: string | null,
  ) => Promise<Response>;
  /**
   * Session lookup over the request's cookies. Returns the active
   * Better Auth session, or `null` if no valid cookie is present. The
   * OAuth consent flow uses this to gate `/auth/authorize` without
   * requiring admin bearer tokens.
   */
  getSession: (
    headers: Headers,
    options?: { readOnly?: boolean },
  ) => Promise<MarfaAuthSession | null>;
  /**
   * Admit a request on the session its cookie names, and count it as a use:
   * unless a use was recorded within {@link BROWSER_SESSION_USE_INTERVAL_SECONDS},
   * the session's expiry moves to {@link BROWSER_SESSION_LIFETIME_SECONDS}
   * after now. `session` is what a read-only `getSession` found for these
   * headers. `null` when the session ended or expired since that lookup.
   */
  useSession: (
    headers: Headers,
    session: MarfaAuthSession,
  ) => Promise<SessionUse | null>;
  /** The live browser sessions of `userId`, oldest first. */
  listBrowserSessions: (userId: string) => Promise<BrowserSession[]>;
  /**
   * End the live browser session `sessionId` of `userId`, finding and deleting
   * it in one write transaction. `false` when no live session of that person
   * has the id, so the second of two ends of one session says nothing ended.
   */
  endBrowserSession: (
    userId: string,
    sessionId: string,
    clientIp: string | null,
  ) => Promise<boolean>;
  /** A `Set-Cookie` value that removes the session cookie from a browser. */
  clearedSessionCookie: () => Promise<string>;
  /**
   * Create an email + password account without going through sign-up.
   *
   * Better Auth's own `POST /auth/sign-up/email` refuses on every instance
   * because `disableSignUp` is set unconditionally, so this runs the same
   * machinery that endpoint would:
   * Better Auth's own hasher and its internal adapter. The address arrives
   * already proven, because whoever calls this asked for the account
   * rather than a stranger claiming it.
   *
   * The instance claim service is the only account-creation entry point.
   * Its transaction consumes setup authority and records the durable owner.
   */
  preparePassword: (password: string) => Promise<PreparedPassword>;
  preparePasswordChange: (
    userId: string,
    currentPassword: string,
    password: string,
  ) => Promise<PreparedPassword>;
  /** Replace the credential and revoke every browser session inside the caller's transaction. */
  resetEmailPassword: (
    userId: string,
    password: PreparedPassword,
    keepSessionId?: string,
  ) => Promise<void>;
  createEmailAccount: (
    params: {
      email: string;
      password: string;
      name?: string;
    },
    audit?: (
      result: Extract<CreateEmailAccountResult, { ok: true }>,
    ) => AuditLogEntry,
    preparedPassword?: PreparedPassword,
  ) => Promise<CreateEmailAccountResult>;
  /**
   * The device plugin's verification step, in-process. With a session's
   * headers it claims a pending code for that person, which the plugin
   * requires before it will approve or deny; with none it only answers the
   * code's status, so the verification form can check a code without moving
   * it.
   */
  deviceVerify: (
    userCode: string,
    headers: Headers,
  ) => Promise<DeviceCodeVerdict>;
  /** Approve a claimed, pending device code as the signed-in person. */
  deviceApprove: (
    userCode: string,
    headers: Headers,
  ) => Promise<{ ok: true } | { ok: false; reason: DeviceCodeRefusal }>;
  /** Deny a claimed, pending device code as the signed-in person. */
  deviceDeny: (
    userCode: string,
    headers: Headers,
  ) => Promise<{ ok: true } | { ok: false; reason: DeviceCodeRefusal }>;
  /** Resolves once Better Auth has finished building its context. Never
   *  rejects: a failure is logged and left for the per-request path to
   *  surface. Callers that need a settled instance await this. */
  ready: Promise<void>;
  /** Public-facing issuer URL the instance advertises (drives
   *  `verification_uri` in the Device Authorization Grant response,
   *  the OAuth issuer field on the discovery doc, and the cookie
   *  domain). Mirrors `MARFA_AUTH_BASE_URL`. */
  baseURL: string;
  /** The secret Better Auth signs with. Exposed so the consent route can verify the OAuth
   *  Provider plugin's signed authorize query against the same value the
   *  plugin signed it with. Never log or serialize it. */
  signingSecret: string;
  api: unknown;
}

/**
 * Whether the storage layer's write-lock refusal is somewhere in this
 * error's `cause` chain. The adapter's statements reach the database through
 * Drizzle, which wraps what the driver threw, so the refusal does not arrive
 * at the top. Bounded because a chain is data and may cycle.
 */
function carriesWriteContention(err: unknown): boolean {
  for (let step: unknown = err, depth = 0; depth < 8; depth++) {
    if (step instanceof MarfaError) {
      return step.code === ErrorCode.WRITE_CONTENTION;
    }
    if (step === null || typeof step !== "object") return false;
    step = (step as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Whether the storage turned a write away for want of room, the write lock or
 * permission to write, wherever in the `cause` chain: the faults that leave a
 * read answerable. Bounded because a chain is data and may cycle.
 */
function storageRefusedWrite(err: unknown): boolean {
  if (diskFull(err) !== undefined) return true;
  for (let step: unknown = err, depth = 0; depth < 8; depth++) {
    if (step instanceof MarfaError)
      return (
        step.code === ErrorCode.WRITE_CONTENTION ||
        step.code === ErrorCode.INSUFFICIENT_STORAGE
      );
    if (step === null || typeof step !== "object") return false;
    const code = (step as { code?: unknown }).code;
    if (typeof code === "string" && /^SQLITE_(BUSY|READONLY)/.test(code))
      return true;
    step = (step as { cause?: unknown }).cause;
  }
  return false;
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
    deviceCode: sqliteSchema.auth_oauth_device_code,
    jwks: sqliteSchema.auth_jwks,
  };

  // Passed explicitly: Better Auth would otherwise fall back to its own
  // environment variables and then to a constant that ships inside the
  // published package, and the consent route verifies the plugin's signed
  // authorize query with this same value, so a verifier reading a
  // different one than the signer used would fail open.
  const signingSecret = options.secret;

  const drizzle = drizzleAdapter(options.db, { provider: "sqlite", schema });
  const credentialAdapter = withIdempotentConsent(
    options.apiKeySalt
      ? withHashedDeviceCodes(drizzle, makeTokenHasher(options.apiKeySalt))
      : drizzle,
  );
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
    database: options.storage
      ? withCredentialAudit(credentialAdapter, options.storage)
      : credentialAdapter,
    onAPIError: {
      // Write contention, wherever it is wrapped, and anything else Better
      // Auth's handler throws that is not one of its own errors are rethrown
      // out of the handler to the server's error handler, which answers them
      // as `503 write_contention` and `500 internal_error` and is the one
      // place a fault is reported. Throwing is the only way out, since this
      // hook's return is ignored, and left alone the library prints the error
      // whole to stderr. Its own errors are logged as it logs them when no
      // hook is set: only when they are a `500`.
      onError: (error, ctx) => {
        if (carriesWriteContention(error) || !isAPIError(error)) throw error;
        if (error.status !== "INTERNAL_SERVER_ERROR") return;
        ctx.logger.error(error.name, error);
      },
    },
    // The provider renews a session only once its last renewal is a day old,
    // so a session used within that day still ends a week after the renewal.
    // Its own refresh is off and `useSession` renews on use instead. Its
    // `expiresIn` is the cookie's lifetime; the stored expiry a new session
    // gets is set by the hook below.
    session: {
      expiresIn: BROWSER_SESSION_COOKIE_SECONDS,
      deferSessionRefresh: true,
      disableSessionRefresh: true,
    },
    databaseHooks: {
      session: {
        create: {
          // Every password sign-in, remembered or not, gets the idle week.
          before: (session) =>
            Promise.resolve({
              data: {
                ...session,
                expiresAt: new Date(
                  session.createdAt.getTime() +
                    BROWSER_SESSION_LIFETIME_SECONDS * 1000,
                ),
              },
            }),
        },
      },
    },
    // The durable account/address limiter is cleared atomically by recovery.
    // A second, process-local password limiter would keep a recovered owner locked out.
    ...(options.storage
      ? { rateLimit: { customRules: { "/sign-in/email": false as const } } }
      : {}),
    emailAndPassword: {
      enabled: true,
      password: {
        hash: hashPassword,
        verify: async (input) => {
          const verified = await verifyPassword(input);
          const request = credentialRequest.getStore();
          if (request?.path === "/sign-in/email")
            request.verifiedPasswordHash = verified ? input.hash : undefined;
          return verified;
        },
      },
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
      // stored in `auth_jwks`. Those keys sign ID tokens only: no browser
      // session answer carries a token signed with them.
      jwt({ disableSettingJwtHeader: true }),
      // The per-account limit on password sign-in; see `sign-in-throttle.ts`.
      ...(options.storage ? [buildSignInThrottlePlugin(options.storage)] : []),
      ...(options.storage && options.apiKeySalt
        ? [
            withSessionEndAudit(
              buildOauthProviderPlugin({
                storage: options.storage,
                apiKeySalt: options.apiKeySalt,
                baseURL: options.baseURL,
              }),
              options.storage,
            ),
            // Scope validation and security observations precede the provider;
            // credential writes and grant projection use the audited adapter.
            buildOauthProjectionPlugin({
              storage: options.storage,
              apiKeySalt: options.apiKeySalt,
              baseURL: options.baseURL,
            }),
            // The RFC 8628 device grant, as the provider's own extension: it
            // mints and claims the codes, approves or denies them, and hands
            // the exchange to the provider's shared issuance at
            // `/oauth2/token`. Marfa keeps the human half in front of it —
            // the verification page, the consent screen with its toggles,
            // the grant projection and the audit row — in `routes/auth-pages`.
            oauthDeviceAuthorization({
              expiresIn: "10m",
              interval: "5s",
              // Resolved against the auth base URL, which carries the `/auth`
              // base path; the plugin's default `/device` would land beside
              // it rather than under it.
              verificationUri: "/auth/device",
              onDeviceAuthRequest: refuseOfflineWithoutRefresh(options.storage),
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
      // Better Auth resolves a client address for its limiter and its
      // session rows, and by default trusts the `X-Forwarded-For` a client
      // sends. It reads the address Marfa resolved instead, which the
      // `handler` below writes on every request; see `CLIENT_ADDRESS_HEADER`.
      ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
      // Cookies set on /auth/*; the data plane (/items, /edges, etc.)
      // remains bearer-only and does not consume this cookie.
      cookiePrefix: "marfa.auth",
      defaultCookieAttributes: {
        httpOnly: true,
        // `Secure` is conditional on the auth baseURL using HTTPS.
        // Chrome silently drops `Secure` cookies on plain-HTTP origins
        // except localhost, including an intranet hostname and a deploy
        // behind a reverse proxy that terminates TLS upstream, so an
        // unconditional `secure: true` would make the session cookie
        // unstoreable there and sign-in impossible. HttpOnly and
        // SameSite=Lax are unconditional.
        secure: options.baseURL.startsWith("https://"),
        sameSite: "lax",
      },
    },
  });

  // Better Auth builds its context asynchronously and starts that work
  // at construction, but nothing awaits the promise until the first
  // request touches the handler. Anything that rejects inside plugin
  // init would therefore surface as an unhandled rejection, which the
  // process reports as a fault and a test run fails on. Attaching here
  // makes it a logged failure of the auth surface instead: that surface
  // then fails per request, the way every other unreachable dependency
  // does.
  const ready = (
    instance as unknown as { $context: Promise<unknown> }
  ).$context.then(
    () => undefined,
    (err: unknown) => {
      log("error", "auth initialization failed; auth requests will error", {
        error: errorMessage(err),
      });
      return undefined;
    },
  );

  const credentialOperation = <T>(
    path: string,
    work: () => Promise<T>,
  ): Promise<T> =>
    credentialRequest.getStore()
      ? work()
      : withCredentialRequest({ path, clientIp: null }, work);

  // Wrap better-auth's session-lookup API behind a narrow promise.
  // `getSession` resolves to `null` when no valid cookie is present —
  // either no cookie at all, or a cookie whose session has expired or
  // been signed out. Errors propagate (e.g. a malformed JWT throws).
  const api = instance.api as {
    getSession: (params: {
      query?: { disableRefresh: boolean; disableCookieCache: boolean };
      headers: Headers;
    }) => Promise<MarfaAuthSession | null>;
    deviceVerify: (params: {
      query: { user_code: string };
      headers: Headers;
    }) => Promise<{
      user_code: string;
      status: "pending" | "approved" | "denied";
      client_id?: string;
      scope?: string;
    }>;
    deviceApprove: (params: {
      body: { userCode: string };
      headers: Headers;
    }) => Promise<{ success: boolean }>;
    deviceDeny: (params: {
      body: { userCode: string };
      headers: Headers;
    }) => Promise<{ success: boolean }>;
  };

  // The plugin refuses with an `APIError` whose body carries an OAuth error
  // code and one of its own messages. Read by shape rather than by class,
  // because the plugin constructs its errors from its own copy of the core
  // package and an `instanceof` across the two can quietly stop matching.
  const deviceRefusal = (err: unknown): DeviceCodeRefusal | null => {
    if (!err || typeof err !== "object" || !("body" in err)) return null;
    const body = (err as { body?: unknown }).body;
    if (!body || typeof body !== "object") return null;
    const code = (body as { error?: unknown }).error;
    const description = (body as { error_description?: unknown })
      .error_description;
    const text = typeof description === "string" ? description : "";
    switch (code) {
      case "expired_token":
        return "expired_code";
      case "unauthorized":
        return "unauthorized";
      case "access_denied":
        return "forbidden";
      case "invalid_request":
        if (/already processed/i.test(text)) return "already_resolved";
        if (/not been claimed/i.test(text)) return "not_claimed";
        return "invalid_code";
      default:
        return null;
    }
  };
  const deviceVerify = async (
    userCode: string,
    headers: Headers,
  ): Promise<DeviceCodeVerdict> => {
    try {
      const answer = await api.deviceVerify({
        query: { user_code: userCode },
        headers,
      });
      return {
        ok: true,
        status: answer.status,
        ...(answer.client_id !== undefined && { clientId: answer.client_id }),
        ...(answer.scope !== undefined && { scope: answer.scope }),
      };
    } catch (err) {
      const reason = deviceRefusal(err);
      if (reason === null) throw err;
      return { ok: false, reason };
    }
  };
  const deviceDecision =
    (
      decide: (params: {
        body: { userCode: string };
        headers: Headers;
      }) => Promise<{ success: boolean }>,
    ) =>
    async (
      userCode: string,
      headers: Headers,
    ): Promise<{ ok: true } | { ok: false; reason: DeviceCodeRefusal }> => {
      try {
        const answer = await decide({ body: { userCode }, headers });
        return answer.success
          ? { ok: true }
          : { ok: false, reason: "already_resolved" };
      } catch (err) {
        const reason = deviceRefusal(err);
        if (reason === null) throw err;
        return { ok: false, reason };
      }
    };

  // Account creation. Deliberately reads the built context rather than
  // calling `api.signUpEmail`: that endpoint answers
  // `EMAIL_PASSWORD_SIGN_UP_DISABLED` on every instance.
  //
  // The order below is sign-up's own, and the reasons are its reasons.
  // Hash before anything is written, so a hasher that throws throws
  // before a user row exists. Create the user through the internal
  // adapter, then link the credential account using the provider and user
  // IDs that Better Auth matches at sign-in.
  const createEmailAccount = async (
    params: {
      email: string;
      password: string;
      name?: string;
    },
    audit?: (
      result: Extract<CreateEmailAccountResult, { ok: true }>,
    ) => AuditLogEntry,
    preparedPassword?: PreparedPassword,
  ): Promise<CreateEmailAccountResult> => {
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
    const password =
      preparedPassword?.hash ??
      (await authContext.password.hash(params.password));
    // The column is NOT NULL, so a name that is absent or blank falls back
    // to the address's local part.
    const submittedName = params.name?.trim() ?? "";
    const name =
      submittedName === "" ? (email.split("@")[0] ?? email) : submittedName;
    const create = async (): Promise<CreateEmailAccountResult> => {
      let user: Awaited<
        ReturnType<BetterAuthCredentialContext["internalAdapter"]["createUser"]>
      >;
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
      await authContext.internalAdapter.linkAccount({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password,
      });
      return {
        ok: true,
        authUserId: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      };
    };
    if (!options.storage) return create();
    return runAuditedTransaction(options.storage, create, (result) =>
      result.ok
        ? (audit?.(result) ?? {
            action: "auth.account.created",
            resource_type: "auth_user",
            resource_id: result.authUserId,
          })
        : null,
    );
  };

  const credentialContext = () =>
    (instance as unknown as { $context: Promise<BetterAuthCredentialContext> })
      .$context;
  const preparePassword = async (
    password: string,
  ): Promise<PreparedPassword> => {
    const ctx = await credentialContext();
    const { minPasswordLength, maxPasswordLength } = ctx.password.config;
    if (
      typeof password !== "string" ||
      password.length < minPasswordLength ||
      password.length > maxPasswordLength
    )
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Password must contain ${String(minPasswordLength)} to ${String(maxPasswordLength)} characters.`,
      );
    return { hash: await ctx.password.hash(password) };
  };
  const preparePasswordChange = async (
    userId: string,
    currentPassword: string,
    password: string,
  ): Promise<PreparedPassword> => {
    const ctx = await credentialContext();
    const account = (await ctx.internalAdapter.findAccounts(userId)).find(
      (a) => a.providerId === "credential",
    );
    if (
      !account?.password ||
      !(await ctx.password.verify({
        hash: account.password,
        password: currentPassword,
      }))
    )
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "The current password is incorrect.",
      );
    return {
      ...(await preparePassword(password)),
      previousHash: account.password,
    };
  };
  const resetEmailPassword = async (
    userId: string,
    password: PreparedPassword,
    keepSessionId?: string,
  ) => {
    if (!options.storage)
      throw new Error("Password replacement requires transactional storage");
    options.storage.assertInWriteTransaction();
    const ctx = await credentialContext();
    const account = (await ctx.internalAdapter.findAccounts(userId)).find(
      (a) => a.providerId === "credential",
    );
    if (!account)
      throw new MarfaError(
        ErrorCode.OWNER_NOT_FOUND,
        "The owner's password account is unavailable.",
      );
    if (
      password.previousHash !== undefined &&
      account.password !== password.previousHash
    )
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "The password changed during this request. Sign in again.",
      );
    await ctx.internalAdapter.updatePassword(userId, password.hash);
    if (keepSessionId) {
      const others = (await ctx.internalAdapter.listSessions(userId))
        .filter((s) => s.id !== keepSessionId)
        .map((s) => s.token);
      if (others.length) await ctx.internalAdapter.deleteSessions(others);
    } else await ctx.internalAdapter.deleteUserSessions(userId);
  };

  const requireStorage = (): Storage => {
    if (!options.storage)
      throw new Error("Browser sessions require transactional storage");
    return options.storage;
  };
  // The provider counts a session as expired once its expiry is in the past,
  // so one expiring this instant is still live.
  const live = (row: ProviderSessionRow, now: Date) => !(row.expiresAt < now);
  const sessionCookie = (
    ctx: BetterAuthCredentialContext,
    value: string,
    maxAge: number,
  ) => {
    const { name, attributes } = ctx.authCookies.sessionToken;
    return generateCookie(name, value, { ...attributes, maxAge });
  };

  const useSession = async (
    headers: Headers,
    found: MarfaAuthSession,
  ): Promise<SessionUse | null> => {
    const ctx = await credentialContext();
    const userId = found.user.id;
    const { name } = ctx.authCookies.sessionToken;
    const token = found.session.token;
    const now = new Date();
    const due = (row: { updatedAt: Date }) =>
      now.getTime() - row.updatedAt.getTime() >=
      BROWSER_SESSION_USE_INTERVAL_SECONDS * 1000;
    const cookies = parseCookies(headers.get("cookie") ?? "");
    const sent = cookies.get(name);
    // A session signed in not to be remembered keeps the cookie the provider
    // set it, which ends with the browser.
    const remembered = !cookies.has(ctx.authCookies.dontRememberToken.name);
    // Sent again only with a recorded use: often enough that a session in
    // use for longer than the cookie lives keeps it, and rarely enough to
    // leave the browser's back-forward cache alone.
    const use = (recorded: boolean): SessionUse => ({
      session: found,
      cookie:
        recorded && remembered && sent?.startsWith(`${token}.`)
          ? sessionCookie(ctx, sent, BROWSER_SESSION_COOKIE_SECONDS)
          : null,
      cookieName: name,
    });
    if (!due(found.session)) return use(false);
    const storage = requireStorage();
    let recorded: { wrote: boolean } | null;
    try {
      recorded = await withCredentialRequest(
        { path: "/use-session", clientIp: null, recordsSessionUse: true },
        () =>
          runAuditedTransaction(
            storage,
            async (): Promise<{ wrote: boolean } | null> => {
              // Read again under the write lock: a session that ended or
              // expired since the lookup stays ended, rather than renewed
              // back.
              const current = await ctx.internalAdapter.findSession(token);
              if (
                current?.session.userId !== userId ||
                !live(current.session, now)
              )
                return null;
              if (!due(current.session)) return { wrote: false };
              const updated = await ctx.internalAdapter.updateSession(token, {
                expiresAt: new Date(
                  now.getTime() + BROWSER_SESSION_LIFETIME_SECONDS * 1000,
                ),
                updatedAt: now,
              });
              return updated ? { wrote: true } : null;
            },
            () => null,
          ),
      );
    } catch (err) {
      // The lookup found the session live, so a use the storage cannot take,
      // on a full disk for one, still admits the request. Each write the
      // request makes meets the storage itself, and checks the session again
      // under the write lock.
      if (!storageRefusedWrite(err)) throw err;
      log("warn", "A browser session's use could not be recorded", {
        error: errorMessage(err),
      });
      return use(false);
    }
    return recorded ? use(recorded.wrote) : null;
  };

  const listBrowserSessions = async (
    userId: string,
  ): Promise<BrowserSession[]> => {
    const ctx = await credentialContext();
    const now = new Date();
    return (await ctx.internalAdapter.listSessions(userId))
      .filter((row) => row.userId === userId && live(row, now))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        lastUsedAt: row.updatedAt,
        expiresAt: row.expiresAt,
        ipAddress: row.ipAddress ?? null,
        userAgent: row.userAgent ?? null,
      }));
  };

  const endBrowserSession = async (
    userId: string,
    sessionId: string,
    clientIp: string | null,
  ): Promise<boolean> => {
    const storage = requireStorage();
    const ctx = await credentialContext();
    // The deletion's own audit row is the record of the end, and carries the
    // address the request came from.
    return withCredentialRequest({ path: "/owner/sign-ins", clientIp }, () =>
      runAuditedTransaction(
        storage,
        async () => {
          const now = new Date();
          const target = (await ctx.internalAdapter.listSessions(userId)).find(
            (row) =>
              row.id === sessionId && row.userId === userId && live(row, now),
          );
          if (!target) return false;
          await ctx.internalAdapter.deleteSession(target.token);
          return true;
        },
        () => null,
      ),
    );
  };

  const clearedSessionCookie = async (): Promise<string> =>
    sessionCookie(await credentialContext(), "", 0);

  const facade: MarfaAuth = {
    handler: async (request: Request, clientAddress: string | null) => {
      // Set on the request's own headers rather than on a copy: copying a
      // request the server received starts reading its body, which is
      // otherwise read only if Better Auth gets as far as reading it.
      request.headers.delete(CLIENT_ADDRESS_HEADER);
      if (clientAddress !== null) {
        request.headers.set(CLIENT_ADDRESS_HEADER, clientAddress);
      }
      const path = new URL(request.url).pathname.replace(/^\/auth/, "");
      if (path.startsWith("/sign-in/") || path.startsWith("/sign-up/"))
        requireSecureOwnerTransport(facade);
      if (
        path === "/change-password" &&
        request.method === "POST" &&
        options.storage
      ) {
        requireOwnerOrigin(facade, request.headers);
        const body = (await request.json().catch(() => null)) as {
          currentPassword?: unknown;
          newPassword?: unknown;
        } | null;
        if (
          typeof body?.currentPassword !== "string" ||
          typeof body.newPassword !== "string"
        )
          throw new MarfaError(
            ErrorCode.VALIDATION_ERROR,
            "Current and new passwords are required.",
          );
        await changeOwnerPassword(options.storage, facade, request.headers, {
          currentPassword: body.currentPassword,
          password: body.newPassword,
          clientAddress,
        });
        const current = await facade.getSession(request.headers, {
          readOnly: true,
        });
        return Response.json(
          { token: null, user: current?.user ?? null },
          { headers: { "cache-control": "no-store" } },
        );
      }
      const browserSessionPaths = new Set([
        "/get-session",
        "/sign-out",
        "/revoke-sessions",
        "/revoke-other-sessions",
        "/oauth2/authorize",
        "/oauth2/consent",
        "/oauth2/end-session",
        "/device/approve",
        "/device/deny",
      ]);
      if (browserSessionPaths.has(path) && request.headers.has("authorization"))
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          "This operation requires an owner browser session.",
        );
      if (
        options.storage &&
        ["/revoke-sessions", "/revoke-other-sessions"].includes(path)
      ) {
        await requireOwnerSession(options.storage, facade, request.headers, {
          recent: true,
        });
        rememberRecentAuthentication();
      }
      const phase =
        ["/oauth2/token", "/oauth2/revoke"].includes(path) && options.storage
          ? new CredentialPersistencePhase(
              options.storage,
              path === "/oauth2/revoke"
                ? "auth.credentials.revoked"
                : "auth.token.issued",
            )
          : undefined;
      let body: Record<string, unknown> | undefined;
      if (request.method === "POST" && path === "/sign-in/email") {
        try {
          const copy = request.clone();
          body = request.headers
            .get("content-type")
            ?.includes("application/json")
            ? ((await copy.json()) as Record<string, unknown>)
            : Object.fromEntries(new URLSearchParams(await copy.text()));
        } catch {
          /* The provider owns malformed-body responses. */
        }
      }
      return withCredentialRequest(
        {
          path,
          clientIp: clientAddress,
          phase,
          email: typeof body?.email === "string" ? body.email : undefined,
        },
        async () => {
          const response = await instance.handler(request);
          if (
            path === "/sign-in/email" &&
            !credentialRequest.getStore()?.failure &&
            !response.ok &&
            response.status < 500 &&
            options.storage
          ) {
            await runAuditedTransaction(options.storage, () => undefined, {
              action: "auth.sign_in.failed",
              resource_type: "auth_user",
              client_ip: clientAddress,
              resource_id:
                typeof body?.email === "string" ? body.email : undefined,
              details: {
                email: typeof body?.email === "string" ? body.email : undefined,
                method: "password",
                reason:
                  response.status === 429
                    ? "too_many_attempts"
                    : "invalid_credentials",
              },
            });
          }
          return response;
        },
      );
    },
    api: instance.api,
    getSession: (headers: Headers, lookup = {}) =>
      (lookup.readOnly
        ? (work: () => Promise<MarfaAuthSession | null>) =>
            // Revalidation runs while a provider persistence phase is opening.
            // Its read must not wait for that same phase to finish opening.
            withCredentialRequest(
              { path: "/get-session", clientIp: null },
              work,
            )
        : (work: () => Promise<MarfaAuthSession | null>) =>
            credentialOperation("/get-session", work))(() =>
        api.getSession({
          headers,
          ...(lookup.readOnly
            ? { query: { disableRefresh: true, disableCookieCache: true } }
            : {}),
        }),
      ),
    deviceVerify: (code, headers) =>
      credentialOperation("/device", () => deviceVerify(code, headers)),
    deviceApprove: (code, headers) =>
      credentialOperation("/device/approve", () =>
        deviceDecision((params) => api.deviceApprove(params))(code, headers),
      ),
    deviceDeny: (code, headers) =>
      credentialOperation("/device/deny", () =>
        deviceDecision((params) => api.deviceDeny(params))(code, headers),
      ),
    useSession,
    listBrowserSessions,
    endBrowserSession,
    clearedSessionCookie,
    createEmailAccount,
    preparePassword,
    preparePasswordChange,
    resetEmailPassword,
    ready,
    baseURL: options.baseURL,
    signingSecret,
  };
  return facade;
}
