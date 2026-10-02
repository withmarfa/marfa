import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { oauthDeviceAuthorization } from "@better-auth/oauth-provider";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { isAPIError } from "better-auth/api";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { createLocalAccountIssuer } from "better-auth/db";
import * as sqliteSchema from "../storage/sqlite/schema.js";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
import {
  buildOauthProviderPlugin,
  buildOauthProjectionPlugin,
} from "./oauth-provider.js";
import { withIdempotentConsent } from "./consent-idempotent-adapter.js";
import { CLIENT_ADDRESS_HEADER } from "../middleware/client-ip.js";
import { buildSignInThrottlePlugin } from "./sign-in-throttle.js";

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
  };
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
  session: { id: string };
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
  getSession: (headers: Headers) => Promise<MarfaAuthSession | null>;
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
   * `POST /owner` is the door over this, and it is how an instance gets
   * its owner; the test harness calls it directly to put a person behind
   * the sign-in page without going through that door.
   */
  createEmailAccount: (params: {
    email: string;
    password: string;
    name?: string;
  }) => Promise<CreateEmailAccountResult>;
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
  /** The secret Better Auth signs with, after resolution — the
   *  configured value, an environment fallback, or a per-process
   *  ephemeral one. Exposed so the consent route can verify the OAuth
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
    onAPIError: {
      // Better Auth answers anything its handler throws that is not one of
      // its own errors with a bare `500`. Write contention is a failure this
      // server answers on every door as `503 write_contention`, so it is
      // rethrown out of the handler to the server's error handler; throwing
      // is the only way out, since this hook's return is ignored. Anything
      // else is logged as Better Auth logs it when no hook is set: its own
      // errors only when they are a `500`.
      onError: (error, ctx) => {
        if (carriesWriteContention(error)) throw error;
        if (isAPIError(error) && error.status !== "INTERNAL_SERVER_ERROR") {
          return;
        }
        ctx.logger.error(error instanceof Error ? error.name : "", error);
      },
    },
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
      // The per-account limit on password sign-in; see `sign-in-throttle.ts`.
      ...(options.storage ? [buildSignInThrottlePlugin(options.storage)] : []),
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
    return {
      ok: true,
      authUserId: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    };
  };

  return {
    handler: (request: Request, clientAddress: string | null) => {
      // Set on the request's own headers rather than on a copy: copying a
      // request the server received starts reading its body, which is
      // otherwise read only if Better Auth gets as far as reading it.
      request.headers.delete(CLIENT_ADDRESS_HEADER);
      if (clientAddress !== null) {
        request.headers.set(CLIENT_ADDRESS_HEADER, clientAddress);
      }
      return instance.handler(request);
    },
    api: instance.api,
    getSession: (headers: Headers) => api.getSession({ headers }),
    deviceVerify,
    deviceApprove: deviceDecision((params) => api.deviceApprove(params)),
    deviceDeny: deviceDecision((params) => api.deviceDeny(params)),
    createEmailAccount,
    ready,
    baseURL: options.baseURL,
    signingSecret,
  };
}
