import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth, jwt, magicLink } from "better-auth/plugins";
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
   *  In dev this is typically `http://localhost:8602`. */
  baseURL: string;
  /** When false, the email + password sign-up endpoint is disabled.
   *  Default `false` per the orchestrator-confirmed sign-up policy
   *  (`MARFA_AUTH_ALLOW_SIGNUP=false`). Existing users can still sign in. */
  allowSignup: boolean;
  /** When `true`, a fresh tenant is seeded with a few starter items on
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
          // Provision the Marfa tenant + users row for every new Better
          // Auth account, regardless of how the account was created: the
          // programmatic `POST /auth/sign-up/email`, the server-rendered
          // `POST /auth/sign-up` form (which forwards to the same
          // endpoint), and federated OIDC first sign-in all converge
          // here. A tenant is the anchor for every credential and OAuth
          // grant — it must exist before the user can authenticate, so a
          // single hook on the create lifecycle is the one correct place
          // for it. Keys-mode self-hosts have no per-user tenant model
          // (no users/tenants store) and skip this entirely.
          after: async (user, ctx) => {
            const storage = options.storage;
            const users = storage?.users;
            const tenants = storage?.tenants;
            if (!storage || !users || !tenants) return;

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
              // Provision the handle claim + tenant + user as the database
              // owner. These touch RLS-bearing auth/tenant tables and depend
              // on owner-bypass; forcing the owner role for the transaction
              // (transaction-scoped via SET LOCAL ROLE NONE, pooler-safe)
              // guarantees they never run as a stranded `marfa_app` and hit
              // RLS — the failure mode that took hosted sign-up down. On PG
              // the writes are also atomic (tenant + user commit together).
              const provision = async () => {
                const handle = await claimFreeHandle(users, desired);
                const tenant = await tenants.create(user.name);
                await users.create({
                  name: user.name,
                  provider: "better-auth",
                  provider_id: user.id,
                  tenant_id: tenant.id,
                  handle,
                  auth_user_id: user.id,
                  // Every sign-up provisions a fresh tenant the user solely
                  // owns (line above), so the user IS that space's admin —
                  // stamp tenant_admin rather than the `member` default. This
                  // lets the owner administer their own space (register types /
                  // edge types, manage keys + connections). Data access for
                  // apps they sign into is still gated by the granted OAuth
                  // scopes (OAuth tokens are `scope_enforced`), so the role is
                  // the ceiling, not a full-access pass. If a shared-tenant
                  // membership model lands later, gate this on "first/owning
                  // user of the tenant".
                  role: "tenant_admin",
                });
                // The account holder's graph handle rides with the tenant
                // and the users row rather than following as a separate
                // step, so a space can never exist without an addressable
                // owner for an edge to point at. Not best-effort like the
                // starter content below: a missing handle is a hole in the
                // data model, not a missing decoration.
                await ensureAccountHolderItem(storage, tenant.id);
                return tenant;
              };
              const tenant =
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
                  await seedStarterContent(options.storage, tenant.id);
                } catch (seedErr) {
                  void options.storage.audit.log({
                    action: "auth.sign_up.seed_failed",
                    resource_type: "tenant",
                    resource_id: tenant.id,
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
              // tenant is the exact stranded state this hook exists to
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
            // Sibling shell plugin hosting the refresh-replay before-hook.
            // Consent projection and grant revocation remain in the Marfa
            // route handlers that hold the verified client/user context.
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
    signingSecret,
  };
}
