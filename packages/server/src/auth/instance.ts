import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth, jwt, magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import * as sqliteSchema from "../storage/sqlite/schema.js";
import * as pgSchema from "../storage/pg/schema.js";
import { log } from "../middleware/logger.js";
import type { EmailTransport as MarfaEmailTransport } from "../email/transport.js";
import type { Storage } from "../storage/interface.js";
import { renderMagicLinkEmail } from "./email-templates/magic-link.js";
import { renderResetPasswordEmail } from "./email-templates/reset-password.js";
import { renderVerifyEmailEmail } from "./email-templates/verify-email.js";
import {
  buildOauthProviderPlugin,
  buildOauthProjectionPlugin,
} from "./oauth-provider.js";

/**
 * The first parameter type of better-auth's drizzleAdapter — used to type
 * the `db` handle threaded through `MarfaAuthOptions` so the call site no
 * longer needs an `as never` escape hatch (§3.13). When better-auth bumps
 * and tightens the adapter signature, this alias surfaces the mismatch
 * at compile time at the consumer rather than masking it with a cast.
 */
type DrizzleAdapterDb = Parameters<typeof drizzleAdapter>[0];

/**
 * Constructs the better-auth instance. Plug into the storage factories'
 * `__betterAuthDb` / `__betterAuthDialect` handles. Consumed by `app.ts`
 * to mount the catch-all handler under `/auth/*`.
 */

export type EmailTransport = (params: {
  email: string;
  url: string;
  token: string;
}) => void | Promise<void>;

export interface MarfaAuthOptions {
  /** Drizzle handle from the storage factory. Typed against better-auth's
   *  `drizzleAdapter` first-parameter so the call site is statically
   *  checked without an `as never` cast. The Storage interface widens it
   *  to `unknown` (BetterAuthStorageAdapter trait); narrowing happens
   *  here at the only consumer. */
  db: DrizzleAdapterDb;
  dialect: "sqlite" | "pg";
  /** Hosting issuer URL — protocol + host (and port) the server is reached
   *  at. Used by better-auth to set cookie domains and base paths.
   *  In dev this is typically `http://localhost:8602`. */
  baseURL: string;
  /** When false, the email + password sign-up endpoint is disabled.
   *  Default `false` per the orchestrator-confirmed sign-up policy
   *  (`MARFA_AUTH_ALLOW_SIGNUP=false`). Existing users can still sign in. */
  allowSignup: boolean;
  /** Optional shared secret used for cookie signing. When unset,
   *  better-auth generates an ephemeral secret per process — fine for
   *  dev, not safe for production. Production deployments must set
   *  `MARFA_AUTH_SECRET`. */
  secret?: string;
  /** Origins permitted to make credentialed (cookie) requests against
   *  the auth surface. Defaults to the `baseURL` plus any `corsOrigins`
   *  from `AppConfig`. */
  trustedOrigins?: string[];
  /** Relying-party name shown to the user during passkey registration.
   *  Defaults to "Marfa". */
  passkeyRpName?: string;
  /** Relying-party ID for passkey registration — typically the bare host
   *  of `baseURL`. When unset, derived from `baseURL`. */
  passkeyRpId?: string;
  /** Sink for magic-link emails. Defaults to a `log` transport that
   *  writes the link to stdout — fine for dev. Tests pass an inline
   *  callable. Production wires `marfaEmailTransport` instead, which
   *  goes through the rich email module (HTML template, idempotency
   *  key for log correlation). */
  emailTransport?: EmailTransport;
  /** Rich email transport. When present, magic-link sends go through
   *  this (HTML template, idempotency key for log correlation). When
   *  absent, falls back to `emailTransport` (or the log default).
   *  Production paths set this; tests typically don't. See
   *  `src/email/index.ts` for construction. */
  marfaEmailTransport?: MarfaEmailTransport;
  /** Federated OIDC providers (Google / GitHub / Authentik / etc.) wired
   *  into the generic-oauth plugin. Each entry surfaces a sign-in button
   *  on the sign-in page and exposes `/auth/sign-in/oauth2` + `/auth/oauth2/callback/<providerId>`. */
  oidcProviders?: readonly {
    providerId: string;
    clientId: string;
    clientSecret: string;
    discoveryUrl?: string;
    scopes?: string[];
  }[];
  /** Whether to require email verification on sign-up. Default:
   *  auto-detect from `marfaEmailTransport` — on when a real backend
   *  (`cloudflare` / `smtp`) is wired, off when the transport is `none`
   *  or missing. Tests pass `true` explicitly; production deployments
   *  rely on the auto-detect. */
  requireEmailVerification?: boolean;
  /** Storage handle threaded into the OAuth Provider plugin's
   *  `clientReference`, `customAccessTokenClaims`, and `hooks.after`
   *  matchers. Needed for the `system.connection` projection of the
   *  plugin's grant lifecycle and the tenant_id binding on issued tokens. */
  storage?: Storage;
  /** Per-process API key salt — shared with the bearer middleware so the
   *  plugin's `storeTokens.hash` and the middleware's hash output match,
   *  letting the middleware look up `auth_oauth_access_token.token`
   *  directly by computing the same hash. */
  apiKeySalt?: string;
}

const defaultLogTransport: EmailTransport = ({ email, url }) => {
  log("info", "magic-link email (log transport)", {
    to: email,
    url,
    note: "configure MARFA_EMAIL_TRANSPORT for live delivery",
  });
};

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
 *  in @simplewebauthn / zod internal types and breaks portable .d.ts emit). */
export interface MarfaAuth {
  handler: (request: Request) => Promise<Response>;
  /**
   * Session lookup over the request's cookies. Returns the active
   * Better Auth session, or `null` if no valid cookie is present. The
   * OAuth consent flow uses this to gate `/auth/authorize` without
   * requiring admin bearer tokens.
   */
  getSession: (headers: Headers) => Promise<MarfaAuthSession | null>;
  /** Whether new account creation is allowed on this instance. Mirrors
   *  the constructor option; the sign-in page reads it to decide
   *  whether to render a "Create one" link below the form. */
  allowSignup: boolean;
  /** Configured federated OIDC provider IDs, in registration order.
   *  The sign-in page renders one button per ID. Empty when no
   *  providers are configured. */
  oidcProviderIds: readonly string[];
  /** Public-facing issuer URL the instance advertises (drives
   *  `verification_uri` in the Device Authorization Grant response,
   *  the OAuth issuer field on the discovery doc, and the cookie
   *  domain). Mirrors `MARFA_AUTH_BASE_URL`. */
  baseURL: string;
  api: unknown;
}

export function createMarfaAuth(options: MarfaAuthOptions): MarfaAuth {
  const schema =
    options.dialect === "pg"
      ? {
          user: pgSchema.auth_user,
          session: pgSchema.auth_session,
          account: pgSchema.auth_account,
          verification: pgSchema.auth_verification,
          passkey: pgSchema.auth_passkey,
          // OAuth Provider plugin tables (mapped via Better Auth model
          // names → our auth_oauth_* Drizzle tables). The plugin queries
          // through these names; the snake_case DB columns are resolved
          // by the adapter automatically.
          oauthClient: pgSchema.auth_oauth_client,
          oauthAccessToken: pgSchema.auth_oauth_access_token,
          oauthRefreshToken: pgSchema.auth_oauth_refresh_token,
          oauthConsent: pgSchema.auth_oauth_consent,
          // JWT signing keys for the jwt plugin (id_token issuance).
          jwks: pgSchema.auth_jwks,
        }
      : {
          user: sqliteSchema.auth_user,
          session: sqliteSchema.auth_session,
          account: sqliteSchema.auth_account,
          verification: sqliteSchema.auth_verification,
          passkey: sqliteSchema.auth_passkey,
          oauthClient: sqliteSchema.auth_oauth_client,
          oauthAccessToken: sqliteSchema.auth_oauth_access_token,
          oauthRefreshToken: sqliteSchema.auth_oauth_refresh_token,
          oauthConsent: sqliteSchema.auth_oauth_consent,
          jwks: sqliteSchema.auth_jwks,
        };

  const transport = options.emailTransport ?? defaultLogTransport;
  const richTransport = options.marfaEmailTransport;

  // Only flip `requireEmailVerification` when a real email backend is
  // wired. With the `none` backend (or no rich transport at all) the
  // verification email can't deliver — turning the flag on would 500
  // every sign-up. As soon as the operator wires
  // `MARFA_EMAIL_BACKEND=cloudflare` (or `smtp`) and restarts,
  // verification turns on automatically. Callers (e.g. tests) can
  // override the auto-detect via `options.requireEmailVerification`.
  const emailVerificationEnabled =
    options.requireEmailVerification ??
    (richTransport !== undefined && richTransport.backend !== "none");

  let derivedRpId = options.passkeyRpId;
  if (!derivedRpId) {
    try {
      derivedRpId = new URL(options.baseURL).hostname;
    } catch {
      derivedRpId = "localhost";
    }
  }

  const instance = betterAuth({
    baseURL: options.baseURL,
    basePath: "/auth",
    secret: options.secret,
    trustedOrigins: options.trustedOrigins,
    // Suppress the ERROR-level log Better Auth emits when a
    // `request-password-reset` hits a non-existent email. The
    // forgot-password wrapper deliberately swallows that case to honour
    // the no-enumeration invariant (always 302 with `?sent=1`); BA's
    // own logger fires synchronously, so the only seam to keep operator
    // logs clean is BA's logger config. Pass every other line through.
    logger: {
      disabled: false,
      level: "info",
      log: (level, message, ...args) => {
        if (
          level === "error" &&
          message.includes("Reset Password") &&
          message.includes("User not found")
        ) {
          return;
        }
        const mapped = level === "debug" ? "info" : level;
        log(
          mapped,
          `Better Auth: ${message}`,
          args.length > 0 ? { args } : undefined,
        );
      },
    },
    database: drizzleAdapter(options.db, {
      provider: options.dialect === "pg" ? "pg" : "sqlite",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      // Auto-sign-in after sign-up keeps the consent flow seamless when
      // a brand-new account approves an OAuth client on first visit.
      // With `requireEmailVerification: true` better-auth sets
      // `shouldSkipAutoSignIn` so sign-up succeeds with
      // `{ token: null, user }` and NO Set-Cookie — the user must
      // verify before any session lands.
      autoSignIn: true,
      // Default off; flips on when the `MARFA_AUTH_ALLOW_SIGNUP` env var
      // is set.
      disableSignUp: !options.allowSignup,
      // Every new sign-up must verify their email before signing in —
      // but only when a real email backend is configured. The `none`
      // backend (or no transport at all) would 500 every sign-up.
      // Migration 0042 (PG) / 0035 (SQLite) marks accounts predating
      // the requirement as verified so existing users aren't locked out.
      requireEmailVerification: emailVerificationEnabled,
      // 1h reset-token TTL. Long enough for a user to switch tabs /
      // inboxes, short enough to bound the single-use replay window.
      resetPasswordTokenExpiresIn: 3600,
      // Revoke every other session on password reset. The user is
      // reauthenticated on the reset surface itself; any pre-existing
      // devices need to re-sign-in.
      revokeSessionsOnPasswordReset: true,
      // Send the password-reset email through the rich Marfa transport.
      // The hook overrides better-auth's default URL to point at our
      // themed `/auth/reset-password` page directly (skipping
      // better-auth's intermediate GET that redirects to a callbackURL).
      // Token validation happens on the POST handler — invalid / expired
      // tokens render the failure state.
      sendResetPassword: async ({ user, token }) => {
        const ourUrl = `${options.baseURL.replace(/\/$/, "")}/auth/reset-password?token=${encodeURIComponent(token)}`;
        if (richTransport && richTransport.backend !== "none") {
          const { html, text, subject } = renderResetPasswordEmail({
            url: ourUrl,
            name: user.name,
            expiresInMinutes: 60,
          });
          const result = await richTransport.send({
            to: user.email,
            subject,
            html,
            text,
            // Idempotency on the token (single-use, rotates on each
            // request). Threaded through to audit + log correlation;
            // not honoured by the Cloudflare backend for send-time
            // dedup. Token is single-use server-side, so a duplicate
            // send is harmless (first click wins).
            idempotencyKey: `reset-password/${user.id}/${token}`,
            tags: { template: "reset-password" },
          });
          if (!result.ok) {
            log("warn", "reset-password send failed", {
              to: user.email,
              error: result.error,
              retryable: result.retryable,
            });
            // Throw — better-auth awaits this in
            // `runInBackgroundOrAwait`, so the error becomes a
            // 500-shape from `request-password-reset`. The route
            // wrapper still 302s with a soft-fail success to keep
            // the no-enumeration invariant; this throw surfaces in
            // the audit trail.
            throw new Error(`reset_password_send_failed:${result.error}`);
          }
          return;
        }
        // No real backend — log for dev visibility and let the
        // wrapper render the soft-fail success regardless. The
        // user can't actually reset, but neither can an attacker
        // discover that the address has an account.
        log("info", "reset-password (no transport configured)", {
          to: user.email,
          url: ourUrl,
          note: "configure MARFA_EMAIL_BACKEND for live delivery",
        });
      },
    },
    // Fire the verification email on every sign-up — but only when a
    // real backend is configured.
    emailVerification: {
      sendOnSignUp: emailVerificationEnabled,
      // 1 hour TTL on verification tokens. Long enough for the user
      // to switch to their inbox, short enough to bound the
      // single-use-token replay window.
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) => {
        if (!emailVerificationEnabled || !richTransport) {
          // Defensive: the gate above means this path only fires when
          // an operator (or test) explicitly calls
          // `auth.api.sendVerificationEmail` despite no real backend.
          // Log so it's visible.
          log("info", "verify-email (no transport configured)", {
            to: user.email,
            url,
            note: "configure MARFA_EMAIL_BACKEND for live delivery",
          });
          return;
        }
        const { html, text, subject } = renderVerifyEmailEmail({
          url,
          name: user.name,
          expiresInMinutes: 60,
        });
        const result = await richTransport.send({
          to: user.email,
          subject,
          html,
          text,
          // Idempotency key per (user, token). Threaded through to
          // audit + log correlation; not honoured by the Cloudflare
          // backend for send-time dedup. Token is single-use
          // server-side, so a duplicate send is harmless.
          idempotencyKey: `verify-email/${user.id}/${url.split("token=")[1]?.split("&")[0] ?? "no-token"}`,
          tags: { template: "verify-email" },
        });
        if (!result.ok) {
          log("warn", "verify-email send failed", {
            to: user.email,
            error: result.error,
            retryable: result.retryable,
          });
          // Surface to better-auth — the sign-up handler awaits this
          // in `runInBackgroundOrAwait`, so a thrown error becomes a
          // 500-shape from sign-up. Loud failure when email is
          // configured but the upstream returns an error.
          throw new Error(`verify_email_send_failed:${result.error}`);
        }
      },
    },
    plugins: [
      passkey({
        rpName: options.passkeyRpName ?? "Marfa",
        rpID: derivedRpId,
        // Trust the same origins as cookie-credentialed requests.
        origin: options.baseURL,
      }),
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
            // Sibling shell plugin hosting the four `hooks.after` matchers
            // that project plugin grant lifecycle into `system.connection`
            // items + emit auth.grant.created / auth.grant.revoked audit
            // rows. Best-effort — projection failures must NEVER break
            // the auth flow.
            buildOauthProjectionPlugin({
              storage: options.storage,
              apiKeySalt: options.apiKeySalt,
            }),
          ]
        : []),
      magicLink({
        sendMagicLink: async ({ email, url, token }) => {
          // Rich transport gets the HTML template + idempotency key
          // for log correlation. Falls back to the basic callable
          // transport for tests and the log-default for unconfigured
          // deployments.
          if (richTransport) {
            const { html, text, subject } = renderMagicLinkEmail({ url });
            const result = await richTransport.send({
              to: email,
              subject,
              html,
              text,
              idempotencyKey: `magic-link/${token}`,
              tags: { template: "magic-link" },
            });
            if (!result.ok) {
              log("warn", "magic-link send failed", {
                to: email,
                error: result.error,
                retryable: result.retryable,
              });
              // Surface the failure to better-auth — the plugin
              // throws on caller side, which is what we want for
              // a permanent CF rejection or unconfigured backend.
              throw new Error(`magic_link_send_failed:${result.error}`);
            }
            return;
          }
          await transport({ email, url, token });
        },
      }),
      genericOAuth({
        config: (options.oidcProviders ?? []).map((p) => ({
          providerId: p.providerId,
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          discoveryUrl: p.discoveryUrl,
          scopes: p.scopes ?? ["openid", "email", "profile"],
        })),
      }),
    ],
    advanced: {
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

  // Wrap better-auth's session-lookup API behind a narrow promise.
  // `getSession` resolves to `null` when no valid cookie is present —
  // either no cookie at all, or a cookie whose session has expired or
  // been signed out. Errors propagate (e.g. a malformed JWT throws).
  const api = instance.api as {
    getSession: (params: {
      headers: Headers;
    }) => Promise<MarfaAuthSession | null>;
  };

  return {
    handler: instance.handler,
    api: instance.api,
    getSession: (headers: Headers) => api.getSession({ headers }),
    allowSignup: options.allowSignup,
    oidcProviderIds: (options.oidcProviders ?? []).map((p) => p.providerId),
    baseURL: options.baseURL,
  };
}
