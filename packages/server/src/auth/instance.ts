import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, magicLink } from "better-auth/plugins";
import { createLocalAccountIssuer } from "better-auth/db";
import { passkey } from "@better-auth/passkey";
import {
  deriveHandleFromEmail,
  isReservedHandle,
  isValidHandle,
} from "@withmarfa/shared";
import type { UserStore } from "../storage/interface.js";
import * as sqliteSchema from "../storage/sqlite/schema.js";
import * as pgSchema from "../storage/pg/schema.js";
import type { PgDb } from "../storage/pg/connection.js";
import { withOwnerRole } from "../storage/pg/owner-role.js";
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
import { withIdempotentConsent } from "./consent-idempotent-adapter.js";
import { seedStarterContent } from "./starter-content.js";
import { resilientGenericOAuth } from "./oidc-availability.js";
import type { OidcProviderHealth } from "./oidc-availability.js";
import { ensureAccountHolderItem } from "./account-holder.js";

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
   *  In dev this is typically `http://localhost:8600`. */
  baseURL: string;
  /** When false, the email + password sign-up endpoint is disabled.
   *  Default `false` per the orchestrator-confirmed sign-up policy
   *  (`MARFA_AUTH_ALLOW_SIGNUP=false`). Existing users can still sign in. */
  allowSignup: boolean;
  /** When `true`, a fresh space is seeded with a few starter items on
   *  sign-up so the space isn't empty on first open. Default off; hosted
   *  deployments enable it. Best-effort — a seed failure never blocks
   *  sign-up. */
  seedStarterContent?: boolean;
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
   *  on the sign-in page, signs in through `/auth/sign-in/social` and
   *  returns via `/auth/oauth2/callback/<providerId>`. A provider whose
   *  discovery cannot be reached degrades rather than taking the server
   *  down — see `oidc-availability.ts`. */
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
   *  plugin's grant lifecycle and the space_id binding on issued tokens. */
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

/** Append `suffix` to `base`, truncating `base` so the result stays within
 *  the 32-char handle limit and never ends on a stray hyphen before the
 *  suffix. */
function handleWithSuffix(base: string, suffix: string): string {
  const room = Math.max(0, 32 - suffix.length);
  const head = base.slice(0, room).replace(/-+$/g, "");
  return `${head}${suffix}`;
}

/**
 * Resolve a free, valid handle starting from `base`. Returns `base` if it's
 * free; otherwise appends `-2`, `-3`, … until `getByHandle` reports the
 * candidate is unclaimed. The loop is bounded; a pathological collision run
 * falls back to a random nonce suffix so provisioning always resolves
 * rather than looping or throwing.
 */
async function claimFreeHandle(
  users: UserStore,
  base: string,
): Promise<string> {
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? base : handleWithSuffix(base, `-${String(n)}`);
    if (!isValidHandle(candidate)) continue;
    const taken = await users.getByHandle(candidate);
    if (!taken) return candidate;
  }
  return handleWithSuffix(base, `-${randomBytes(4).toString("hex")}`);
}

/**
 * Minimal structural view of the Better Auth runtime context the operator
 * account-creation path reaches for. The full `AuthContext` lives in
 * `@better-auth/core`, which is not a dependency here and drags in generic
 * machinery this needs none of — the same trade
 * `consent-idempotent-adapter.ts` makes for the adapter surface.
 *
 * The trade has a cost worth stating: nothing checks this shape against
 * Better Auth's real one, so a rename in a minor bump compiles clean and
 * fails at runtime. `admin-account-create.test.ts` is what catches that,
 * by signing in as an account this path created.
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
 * throws because each maps to a different status on the route that calls
 * this, and a caller that forgets one gets a compile error instead of a
 * 500.
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
  /**
   * Create an email + password account without going through sign-up.
   *
   * `POST /auth/sign-up/email` is the only endpoint that mints a password
   * account, and it refuses whenever `disableSignUp` is set — which is
   * every hosted instance, deliberately. This runs the same machinery the
   * endpoint does: Better Auth's own hasher, its internal adapter, and so
   * the `user.create` database hook that provisions the space. The one
   * difference is that the address arrives already proven, because an
   * operator asked for the account rather than a stranger claiming it, and
   * nobody is going to open the inbox to click a link.
   *
   * `POST /admin/accounts` is the only caller, and the operator gate
   * lives there. This function does not decide who may create an account.
   */
  createEmailAccount: (params: {
    email: string;
    password: string;
    name?: string;
  }) => Promise<CreateEmailAccountResult>;
  /** Whether new account creation is allowed on this instance. Mirrors
   *  the constructor option; the sign-in page reads it to decide
   *  whether to render a "Create one" link below the form. */
  allowSignup: boolean;
  /** Configured federated OIDC provider IDs, in registration order.
   *  The sign-in page renders one button per ID. Empty when no
   *  providers are configured. */
  oidcProviderIds: readonly string[];
  /** Resolves once Better Auth has finished building its context —
   *  including federated provider initialization. Never rejects: a
   *  failure is logged and left for the per-request path to surface.
   *  Callers that need a settled availability picture await this. */
  ready: Promise<void>;
  /** Availability of every configured federated provider, in
   *  registration order. A provider whose discovery could not be reached
   *  is reported `unavailable` here rather than taking the server down —
   *  the health surface renders this so the degradation is visible
   *  without reading container output. */
  oidcHealth: () => OidcProviderHealth[];
  /** One provider's availability, or `undefined` when it is not
   *  configured. The sign-in route uses this to answer with a reason
   *  instead of claiming the provider does not exist. */
  oidcStatusOf: (providerId: string) => OidcProviderHealth | undefined;
  /** Cancel any pending provider retry. Servers call this on shutdown
   *  and tests on teardown; a retry left pending outlives its server. */
  stopOidcRetries: () => void;
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

  // Federated providers initialize one at a time behind this handle so a
  // provider that cannot be reached degrades itself instead of the
  // server. See `oidc-availability.ts` for why that is the trade.
  const oidc = resilientGenericOAuth({
    providers: options.oidcProviders ?? [],
  });

  const instance = betterAuth({
    baseURL: options.baseURL,
    basePath: "/auth",
    secret: signingSecret,
    trustedOrigins: options.trustedOrigins,
    // Suppress the ERROR-level log Better Auth emits when a
    // `request-password-reset` hits a non-existent email. The
    // forgot-password wrapper deliberately swallows that case to honor
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
    // Wrap the drizzle adapter so a `create` on the `oauthConsent` model
    // upserts on `(clientId, userId)` instead of blindly inserting — see
    // `consent-idempotent-adapter.ts`. Paired with the unique constraint
    // on `auth_oauth_consent (client_id, user_id)`; neither half is safe
    // to ship without the other.
    database: withIdempotentConsent(
      drizzleAdapter(options.db, {
        provider: options.dialect === "pg" ? "pg" : "sqlite",
        schema,
      }),
    ),
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
            // not honored by the Cloudflare backend for send-time
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
      // Clicking the verification link establishes a session, so a
      // just-verified user lands straight in the app (or resumes the OAuth
      // flow they signed up from) instead of being bounced back to sign-in
      // to re-enter the password they set seconds earlier. Better Auth mints
      // the session + Set-Cookie on its verify-email endpoint only when this
      // is set; the GET /auth/verify-email wrapper already forwards that
      // cookie onto the success page. Same trust model as the magic-link
      // sign-in this instance already exposes — a single-use, short-TTL link
      // sent to the address being proven.
      autoSignInAfterVerification: true,
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
          // audit + log correlation; not honored by the Cloudflare
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
    databaseHooks: {
      user: {
        create: {
          // Provision the Marfa space + users row for every new Better
          // Auth account, regardless of how the account was created: the
          // programmatic `POST /auth/sign-up/email`, the server-rendered
          // `POST /auth/sign-up` form (which forwards to the same
          // endpoint), federated OIDC first sign-in, and a magic link
          // resolving to an unknown address all converge here. That
          // last one is worth naming rather than leaving implied: it is
          // the path that provisioned spaces on instances with sign-up
          // closed, because it reaches `createUser` without passing the
          // sign-up gate the others answer to.
          //
          // A space is the anchor for every credential and OAuth
          // grant — it must exist before the user can authenticate, so a
          // single hook on the create lifecycle is the one correct place
          // for it. Keys-mode self-hosts have no per-user space model
          // (no users/spaces store) and skip this entirely.
          after: async (user, ctx) => {
            const storage = options.storage;
            const users = storage?.users;
            const spaces = storage?.spaces;
            if (!storage || !users || !spaces) return;

            try {
              // Idempotent: Better Auth's no-enumeration sign-up returns
              // the existing user's id for a duplicate email, so a row may
              // already exist — never double-provision.
              const existing = await users.getByAuthUserId(user.id);
              if (existing) return;

              // Prefer an explicitly-submitted handle (the HTML form
              // posts `username`); fall back to a deterministic handle
              // derived from the email for the programmatic path, which
              // carries none. Collisions are resolved before the claim.
              const submittedRaw = (
                ctx?.body as { username?: unknown } | undefined
              )?.username;
              const submitted =
                typeof submittedRaw === "string"
                  ? submittedRaw.trim().toLowerCase()
                  : undefined;
              const desired =
                submitted &&
                isValidHandle(submitted) &&
                !isReservedHandle(submitted)
                  ? submitted
                  : deriveHandleFromEmail(user.email);
              // Provision the handle claim + space + user as the database
              // owner. These touch RLS-bearing auth/space tables and depend
              // on owner-bypass; forcing the owner role for the transaction
              // (transaction-scoped via SET LOCAL ROLE NONE, pooler-safe)
              // guarantees they never run as a stranded `marfa_app` and hit
              // RLS — the failure mode that took hosted sign-up down. On PG
              // the writes are also atomic (space + user commit together).
              const provision = async () => {
                const handle = await claimFreeHandle(users, desired);
                const space = await spaces.create(user.name);
                await users.create({
                  name: user.name,
                  provider: "better-auth",
                  provider_id: user.id,
                  space_id: space.id,
                  handle,
                  auth_user_id: user.id,
                  // Every sign-up provisions a fresh space the user solely
                  // owns (the line above), and the first person in a space is
                  // one of the three creations with no ceiling above it: there
                  // is no creator set to be bounded by, so they hold the whole
                  // of their own space. What an app they sign into may reach
                  // is a separate question, answered by the scopes granted on
                  // the consent screen.
                });
                // The account holder's graph handle rides with the space
                // and the users row rather than following as a separate
                // step, so a space can never exist without an addressable
                // owner for an edge to point at. Not best-effort like the
                // starter content below: a missing handle is a hole in the
                // data model, not a missing decoration.
                await ensureAccountHolderItem(storage, space.id);
                return space;
              };
              const space =
                storage.betterAuthDialect === "pg" && storage.pgDb
                  ? await withOwnerRole(storage.pgDb as PgDb, provision)
                  : await provision();

              // Best-effort starter content so a brand-new space isn't empty
              // on first open. Gated by config and isolated in its own try:
              // the outer catch rethrows to fail the sign-up loudly, but a
              // seed hiccup is decorative, so it is audited and swallowed
              // rather than stranding account creation.
              if (options.seedStarterContent && options.storage) {
                try {
                  await seedStarterContent(options.storage, space.id);
                } catch (seedErr) {
                  void options.storage.audit.log({
                    action: "auth.sign_up.seed_failed",
                    resource_type: "space",
                    resource_id: space.id,
                    details: {
                      error:
                        seedErr instanceof Error
                          ? seedErr.message
                          : String(seedErr),
                    },
                  });
                }
              }
            } catch (err) {
              // Surface the failure loudly — a signed-up user with no
              // space is the exact stranded state this hook exists to
              // prevent. Audit the orphan for operator cleanup, then
              // rethrow so the sign-up request fails visibly rather than
              // appearing to succeed.
              void options.storage?.audit.log({
                action: "auth.sign_up.provision_failed",
                resource_type: "auth_user",
                resource_id: user.id,
                details: {
                  email: user.email,
                  error: err instanceof Error ? err.message : String(err),
                },
              });
              throw err;
            }
          },
        },
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
      magicLink({
        // Same switch the password path reads at `emailAndPassword`
        // above. Better Auth's default is to create the user when the
        // link resolves to an unknown address, which walked straight
        // past a gate this deployment had deliberately closed: an
        // instance answering 404 on `/auth/sign-up` still grew an
        // account, and a space with it, for anyone who asked for a
        // link. One switch, both paths.
        //
        // The refusal lands at verify rather than at send — an unknown
        // address still receives a link and only the click fails. That
        // is the plugin's non-enumeration behavior and is left alone:
        // refusing the send would report which addresses hold accounts.
        disableSignUp: !options.allowSignup,
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
      oidc.plugin,
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

  // Operator account creation. Deliberately reads the built context
  // rather than calling `api.signUpEmail`: that endpoint answers
  // `EMAIL_PASSWORD_SIGN_UP_DISABLED` on every instance with sign-up
  // closed, which is the only kind of instance this exists for.
  //
  // The order below is sign-up's own, and the reasons are its reasons.
  // Hash before anything is written, so a hasher that throws throws
  // before a user row exists. Create the user through the internal
  // adapter, which is what runs the `user.create` hook that provisions
  // the space and the handle. Then link the
  // credential account with the issuer Better Auth's own credential
  // lookup keys on — imported rather than spelled here, because a
  // literal would keep working until the day the format moved and then
  // fail as "wrong password" with nothing naming the cause.
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
    // The handle and the space both derive from `name`, and the column is
    // NOT NULL, so a name that is absent or blank falls back to the address's
    // local part rather than reaching the hook as undefined.
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
      // Two different failures arrive here and they need opposite
      // answers. The lookup above is a fast path, not a lock, so two
      // operators creating one address both pass it and the second meets
      // the unique index on `auth_user.email` — nothing of this call's
      // was written, and "it already exists" is the truth. But the
      // provisioning hook runs inline on the create and rethrows when it
      // fails, and that arrives here with this call's own row already
      // committed. Answering that with a conflict tells the operator the
      // opposite of what happened, and leaves an address that every
      // retry then refuses.
      //
      // Which one it is is read rather than matched on driver-specific
      // constraint text, which differs between Postgres and SQLite and
      // would silently stop matching on an upgrade. A row that exists
      // and carries a `users` row belongs to somebody else and this is a
      // genuine duplicate; a row with none is the half-made one this
      // call just left behind, so the failure is reported as a failure.
      const existing = await authContext.internalAdapter.findUserByEmail(email);
      const provisioned = existing
        ? await options.storage?.users?.getByAuthUserId(existing.user.id)
        : null;
      if (provisioned) return { ok: false, reason: "email_exists" };
      throw err;
    }
    if (!user) {
      throw new Error("better-auth created no user");
    }
    // Sign-up's handler wraps its user and account writes in one
    // transaction and this does not, because the helper that opens one
    // is not reachable from here. A `linkAccount` that throws therefore
    // leaves a provisioned account with no password, which a retry then
    // refuses as a duplicate. It takes a database failure to reach, the
    // request answers 500 rather than pretending otherwise, and
    // `POST /admin/accounts/{id}/delete` clears it — the id is on the
    // space as `owner_auth_user_id`.
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
    allowSignup: options.allowSignup,
    oidcProviderIds: (options.oidcProviders ?? []).map((p) => p.providerId),
    ready,
    oidcHealth: () => oidc.snapshot(),
    oidcStatusOf: (providerId: string) => oidc.statusOf(providerId),
    stopOidcRetries: () => {
      oidc.stop();
    },
    baseURL: options.baseURL,
    signingSecret,
  };
}
