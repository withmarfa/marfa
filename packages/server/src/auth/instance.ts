import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth, magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import * as sqliteSchema from "../storage/sqlite/schema.js";
import * as pgSchema from "../storage/pg/schema.js";
import { log } from "../middleware/logger.js";

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
  /** Relying-party name shown to the user during passkey registration.
   *  Defaults to "Myme". */
  passkeyRpName?: string;
  /** Relying-party ID for passkey registration — typically the bare host
   *  of `baseURL`. When unset, derived from `baseURL`. */
  passkeyRpId?: string;
  /** Sink for magic-link emails. Defaults to a `log` transport that
   *  writes the link to stdout — fine for dev. Production must wire
   *  an SMTP / Resend / Mailgun transport. */
  emailTransport?: EmailTransport;
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

/** Narrow public type — covers everything `app.ts` and future routes need
 *  without re-exporting the full Better Auth generic surface (which drags
 *  in @simplewebauthn / zod internal types and breaks portable .d.ts emit). */
export interface MymeAuth {
  handler: (request: Request) => Promise<Response>;
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

  let derivedRpId = options.passkeyRpId;
  if (!derivedRpId) {
    try {
      derivedRpId = new URL(options.baseURL).hostname;
    } catch {
      derivedRpId = "localhost";
    }
  }

  return betterAuth({
    baseURL: options.baseURL,
    basePath: "/auth",
    secret: options.secret,
    trustedOrigins: options.trustedOrigins,
    database: drizzleAdapter(options.db as never, {
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
        secure: true,
        sameSite: "lax",
      },
    },
  });
}
