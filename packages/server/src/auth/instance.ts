import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth, magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import * as sqliteSchema from "../storage/sqlite/schema.js";
import * as pgSchema from "../storage/pg/schema.js";
import { log } from "../middleware/logger.js";
import type { EmailTransport as MymeEmailTransport } from "../email/transport.js";
import { renderMagicLinkEmail } from "./email-templates/magic-link.js";

/**
 * The first parameter type of better-auth's drizzleAdapter — used to type
 * the `db` handle threaded through `MymeAuthOptions` so the call site no
 * longer needs an `as never` escape hatch (§3.13). When better-auth bumps
 * and tightens the adapter signature, this alias surfaces the mismatch
 * at compile time at the consumer rather than masking it with a cast.
 */
type DrizzleAdapterDb = Parameters<typeof drizzleAdapter>[0];

/**
 * Constructs the better-auth instance. Plug into the storage factories'
 * `__betterAuthDb` / `__betterAuthDialect` handles. Consumed by `app.ts`
 * to mount the catch-all handler under `/auth/*`.
 *
 * Sign-in methods land in PR-sized chunks per the workstream-1 plan:
 *   PR 1 — email + password
 *   PR 2 — passkey + magic link (this addition)
 *   PR 3 — generic OIDC client (federated)
 *   PR 5 — OIDC provider (Myme as IdP)
 */

export type EmailTransport = (params: {
  email: string;
  url: string;
  token: string;
}) => void | Promise<void>;

export interface MymeAuthOptions {
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
   *  (`MYME_AUTH_ALLOW_SIGNUP=false`). Existing users can still sign in. */
  allowSignup: boolean;
  /** Optional shared secret used for cookie signing. When unset,
   *  better-auth generates an ephemeral secret per process — fine for
   *  dev, not safe for production. Production deployments must set
   *  `MYME_AUTH_SECRET`. */
  secret?: string;
  /** Origins permitted to make credentialed (cookie) requests against
   *  the auth surface. Defaults to the `baseURL` plus any `corsOrigins`
   *  from `AppConfig`. */
  trustedOrigins?: string[];
  /** Relying-party name shown to the user during passkey registration.
   *  Defaults to "Myme". */
  passkeyRpName?: string;
  /** Relying-party ID for passkey registration — typically the bare host
   *  of `baseURL`. When unset, derived from `baseURL`. */
  passkeyRpId?: string;
  /** Sink for magic-link emails. Defaults to a `log` transport that
   *  writes the link to stdout — fine for dev. Tests pass an inline
   *  callable. Production wires `mymeEmailTransport` instead, which
   *  goes through the rich email module (suppression check, idempotency,
   *  audit). */
  emailTransport?: EmailTransport;
  /** Wave C PR1: rich email transport. When present, magic-link sends
   *  go through this (HTML template, idempotency key, suppression
   *  check). When absent, falls back to `emailTransport` (or the
   *  log default). Production paths set this; tests typically don't.
   *  See `src/email/index.ts` for construction. */
  mymeEmailTransport?: MymeEmailTransport;
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
}

const defaultLogTransport: EmailTransport = ({ email, url }) => {
  log("info", "magic-link email (log transport)", {
    to: email,
    url,
    note: "configure MYME_EMAIL_TRANSPORT for live delivery",
  });
};

/** Authenticated user on a Better Auth session. Reduced surface — only the
 *  fields the OAuth consent flow currently consumes. */
export interface MymeAuthSessionUser {
  id: string;
  email: string;
  name?: string | null;
}

/** A live Better Auth session (cookie-backed). */
export interface MymeAuthSession {
  user: MymeAuthSessionUser;
  session: { id: string };
}

/** Narrow public type — covers everything `app.ts` and future routes need
 *  without re-exporting the full Better Auth generic surface (which drags
 *  in @simplewebauthn / zod internal types and breaks portable .d.ts emit). */
export interface MymeAuth {
  handler: (request: Request) => Promise<Response>;
  /**
   * Session lookup over the request's cookies. Returns the active
   * Better Auth session, or `null` if no valid cookie is present. The
   * OAuth consent flow uses this to gate `/auth/authorize` without
   * requiring admin bearer tokens.
   */
  getSession: (headers: Headers) => Promise<MymeAuthSession | null>;
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
   *  domain). Mirrors `MYME_AUTH_BASE_URL`. */
  baseURL: string;
  api: unknown;
}

export function createMymeAuth(options: MymeAuthOptions): MymeAuth {
  const schema =
    options.dialect === "pg"
      ? {
          user: pgSchema.auth_user,
          session: pgSchema.auth_session,
          account: pgSchema.auth_account,
          verification: pgSchema.auth_verification,
          passkey: pgSchema.auth_passkey,
        }
      : {
          user: sqliteSchema.auth_user,
          session: sqliteSchema.auth_session,
          account: sqliteSchema.auth_account,
          verification: sqliteSchema.auth_verification,
          passkey: sqliteSchema.auth_passkey,
        };

  const transport = options.emailTransport ?? defaultLogTransport;
  const richTransport = options.mymeEmailTransport;

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
    database: drizzleAdapter(options.db, {
      provider: options.dialect === "pg" ? "pg" : "sqlite",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      // Auto-sign-in after sign-up keeps the consent flow seamless when
      // a brand-new account approves an OAuth client on first visit.
      autoSignIn: true,
      // Default off per the workstream-1 brief; flips on when the
      // `MYME_AUTH_ALLOW_SIGNUP` env var is set.
      disableSignUp: !options.allowSignup,
    },
    plugins: [
      passkey({
        rpName: options.passkeyRpName ?? "Myme",
        rpID: derivedRpId,
        // Trust the same origins as cookie-credentialed requests.
        origin: options.baseURL,
      }),
      magicLink({
        sendMagicLink: async ({ email, url, token }) => {
          // Wave C PR1: rich transport gets the HTML template + the
          // pre-send suppression check + idempotency key. Falls back
          // to the legacy callable transport for tests and the
          // log-default for unconfigured deployments.
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
              // the suppressed / unconfigured paths.
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
      cookiePrefix: "myme.auth",
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
    }) => Promise<MymeAuthSession | null>;
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
