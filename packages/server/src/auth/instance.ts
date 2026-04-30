import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as sqliteSchema from "../storage/sqlite/schema.js";
import * as pgSchema from "../storage/pg/schema.js";

/**
 * Constructs the better-auth instance. Plug into the storage factories'
 * `__betterAuthDb` / `__betterAuthDialect` handles. Consumed by `app.ts`
 * to mount the catch-all handler under `/auth/*`.
 *
 * Sign-in methods land in PR-sized chunks per the workstream-1 plan:
 *   PR 1 — email + password (this file)
 *   PR 2 — passkey + magic link
 *   PR 3 — generic OIDC client (federated)
 *   PR 5 — OIDC provider (Myme as IdP)
 */

export interface MymeAuthOptions {
  /** Drizzle handle from the storage factory. Typed as unknown because
   *  the two dialect handles diverge; the adapter narrows internally. */
  db: unknown;
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
}

export function createMymeAuth(options: MymeAuthOptions) {
  const schema =
    options.dialect === "pg"
      ? {
          user: pgSchema.auth_user,
          session: pgSchema.auth_session,
          account: pgSchema.auth_account,
          verification: pgSchema.auth_verification,
        }
      : {
          user: sqliteSchema.auth_user,
          session: sqliteSchema.auth_session,
          account: sqliteSchema.auth_account,
          verification: sqliteSchema.auth_verification,
        };

  return betterAuth({
    baseURL: options.baseURL,
    basePath: "/auth",
    secret: options.secret,
    trustedOrigins: options.trustedOrigins,
    database: drizzleAdapter(options.db as never, {
      provider: options.dialect === "pg" ? "pg" : "sqlite",
      // Use our explicit schema mapping rather than usePlural.
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
    advanced: {
      // Cookies set on /auth/*; the data plane (/items, /edges, etc.)
      // remains bearer-only and does not consume this cookie.
      cookiePrefix: "myme.auth",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      },
    },
  });
}
