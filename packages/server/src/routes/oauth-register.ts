/**
 * Marfa-owned Dynamic Client Registration endpoint.
 *
 * Fronts the @better-auth/oauth-provider plugin's `/auth/oauth2/register`
 * endpoint with our own handler. The Marfa handler is mounted BEFORE the
 * better-auth catch-all (in `app.ts`), so Hono's registration-order
 * dispatch hands DCR requests to us; the plugin's own DCR endpoint
 * never runs.
 *
 * **Why we override.** Two upstream constraints in
 * `@better-auth/oauth-provider@1.6.13` make the plugin's DCR unfit for
 * Marfa's device-flow surface:
 *
 *   1. The plugin's DCR body schema hardcodes a Zod enum that accepts
 *      only `authorization_code`, `client_credentials`, `refresh_token`.
 *      The device-code URN — `urn:ietf:params:oauth:grant-type:device_code`
 *      per RFC 8628 §3.4 — is rejected at request validation with a
 *      400. There is no config knob to widen the enum.
 *   2. The plugin's write path goes through Better Auth's Drizzle
 *      adapter, which (at `@better-auth/drizzle-adapter@1.6.13`) sets
 *      `supportsArrays: true` when the
 *      provider is `"pg"`. The adapter then passes JS arrays
 *      (`scopes`, `redirect_uris`, `grant_types`, `response_types`,
 *      `contacts`) straight into the `text` columns Marfa's PG schema
 *      declares. Postgres coerces the arrays to comma-joined strings
 *      on write; on read, the plugin's `schemaToOAuth` calls
 *      `scopes?.join(" ")` on a string and surfaces a `TypeError` as
 *      HTTP 500 to the DCR caller. The Marfa schema is intentionally
 *      `text` (JSON-encoded string) — Marfa's own writes (`mintTokenPair`
 *      in the OauthProvider stores) JSON-stringify on the way in and
 *      `safeJsonParse` on the way out. The plugin's DCR was the only
 *      Better-Auth-internal writer to `auth_oauth_client`, so routing
 *      around it is sufficient.
 *
 * The handler mirrors the plugin's DCR response shape (RFC 7591 §3.2.1)
 * and stores the row via `storage.oauthProvider.createClient` — same
 * JSON-encoding convention as the rest of Marfa's auth writes. Down-
 * stream consumers (`/auth/authorize`, the device-flow handlers,
 * `getClient` reads) are unchanged: they only need the JSON-encoded
 * column shape we now write consistently.
 *
 * **Acceptance criteria:**
 *   - 201 with credentials for `grant_types: ["authorization_code"]`.
 *   - 201 with credentials for `grant_types: ["urn:...device_code"]`
 *     (Marfa's Zod accepts the device-code URN).
 *   - 201 with a client secret for `grant_types: ["client_credentials"]`
 *     when a session registers it, and 400 when nobody does: that grant has
 *     no user of its own, so the person registering is the only one it will
 *     ever have.
 *
 * (Gap 1 — `device_code` in `grant_types_supported` and the
 * `device_authorization_endpoint` field — is handled separately by the
 * augmented discovery handlers in `app.ts`.)
 */

import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "@hono/zod-openapi";
import type { AppEnv } from "../middleware/auth.js";
import type { MarfaAuth } from "../auth/instance.js";
import type { OauthProviderStore, Storage } from "../storage/interface.js";
import {
  dcrDefaultScopes,
  machineClientCeiling,
  withSessionScopes,
} from "../auth/mint-ceiling.js";
import {
  buildAllowedScopes,
  resolveSpaceIdForAuthUser,
} from "../auth/oauth-provider.js";
import { log } from "../middleware/logger.js";

import { DEVICE_CODE_GRANT_TYPE as DEVICE_CODE_GRANT } from "./auth-pages.js";

/**
 * Grants the Marfa route accepts at request-validation time.
 *
 * The plugin's own three (`authorization_code`, `client_credentials`,
 * `refresh_token`) plus the device-code URN. Refresh-token grants are
 * still valid alongside any of the others — the OAuth2 spec treats
 * `refresh_token` as a refinement on grants that issue refresh tokens.
 *
 * Note that the @better-auth/oauth-provider plugin's
 * `/auth/oauth2/token` endpoint still only knows how to dispatch the
 * first three (verified at `dist/index.mjs:300-318`). Device-code
 * exchange targets the Marfa-owned `POST /auth/device/token` route in
 * `routes/auth-pages.ts`, not the plugin's `/oauth2/token`. The
 * discovery doc advertises both endpoints accordingly.
 */
const ACCEPTED_GRANT_TYPES = [
  "authorization_code",
  "client_credentials",
  "refresh_token",
  DEVICE_CODE_GRANT,
] as const;

const RegisterBodySchema = z.object({
  // RFC 7591 §2: `redirect_uris` MUST be present for grants that
  // perform a browser redirect (`authorization_code`, etc). Pure
  // device-flow clients have no redirect, so we keep it optional and
  // enforce a presence-check inside the handler (after `grant_types`
  // resolution).
  redirect_uris: z.array(z.string().min(1)).optional(),
  post_logout_redirect_uris: z.array(z.string().min(1)).optional(),
  grant_types: z.array(z.enum(ACCEPTED_GRANT_TYPES)).optional(),
  response_types: z.array(z.enum(["code"])).optional(),
  scope: z.string().optional(),
  client_name: z.string().min(1).max(200).optional(),
  client_uri: z.string().optional(),
  logo_uri: z.string().optional(),
  tos_uri: z.string().optional(),
  policy_uri: z.string().optional(),
  contacts: z.array(z.string().min(1)).optional(),
  software_id: z.string().optional(),
  software_version: z.string().optional(),
  software_statement: z.string().optional(),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_basic", "client_secret_post"])
    .optional(),
  type: z.enum(["web", "native", "user-agent-based"]).optional(),
});

type RegisterBody = z.infer<typeof RegisterBodySchema>;

interface DcrError {
  error: string;
  error_description: string;
}

function dcrError(error: string, description: string): DcrError {
  return { error, error_description: description };
}

/**
 * Validates `redirect_uris` per the plugin's `SafeUrlSchema` semantics
 * (`@better-auth/oauth-provider@1.6.13`), with one
 * deliberate Marfa widening for self-hosting:
 *
 *   - rejects `javascript:`, `data:`, `vbscript:`
 *   - allows http:// for loopback hosts (127.0.0.1, ::1, *.localhost)
 *   - allows http:// for any origin the operator has explicitly added to
 *     the instance trusted-origin allowlist (`CORS_ORIGINS`)
 *   - allows custom schemes (mobile apps, `myapp://...`)
 *   - requires https:// otherwise
 *
 * The trusted-origin widening is what lets a self-hosted browser client
 * served over plain http on a private network — a LAN host, a Tailscale
 * MagicDNS name — complete the OAuth redirect without a public TLS
 * endpoint. The operator opts in by listing the client's origin in
 * `CORS_ORIGINS`; nothing is widened by default. Hosted Marfa lists only
 * its https web-app origin there, so the http branch never fires for it.
 *
 * Otherwise mirrored to the plugin's behavior so a third-party SDK
 * hitting the plugin's DCR directly sees identical 400-error shapes.
 */
function validateRedirectUri(
  uri: string,
  trustedOrigins: ReadonlySet<string>,
): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return "URL must be parseable";
  }
  const DANGEROUS = ["javascript:", "data:", "vbscript:"];
  if (DANGEROUS.includes(u.protocol)) {
    return "URL cannot use javascript:, data:, or vbscript: scheme";
  }
  if (
    u.protocol === "http:" &&
    !isLoopbackHost(u.host) &&
    !trustedOrigins.has(u.origin)
  ) {
    return "Redirect URI must use HTTPS (HTTP allowed only for loopback or trusted origins)";
  }
  return null;
}

function isLoopbackHost(host: string): boolean {
  // host may include ":port"
  const hostname = host.replace(/:\d+$/, "");
  if (hostname === "127.0.0.1") return true;
  if (hostname === "[::1]" || hostname === "::1") return true;
  if (hostname === "localhost") return true;
  if (hostname.endsWith(".localhost")) return true;
  // 127.0.0.0/8
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname);
  if (m?.[1] === "127") return true;
  return false;
}

/**
 * Mounted at `/auth/oauth2/register`. Returns 201 with the registered
 * client record on success; otherwise an RFC 7591 §3.2.2 error JSON
 * with the matching HTTP status.
 */
export function oauthRegisterRoutes(
  storage: Storage,
  oauthProvider: OauthProviderStore,
  auth: MarfaAuth | undefined,
  trustedRedirectOrigins: readonly string[] = [],
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const allowedScopes = new Set(buildAllowedScopes());
  // Operator-trusted origins (from `CORS_ORIGINS`) that may serve a public
  // OAuth client over plain http — see `validateRedirectUri`.
  const trustedOrigins = new Set(trustedRedirectOrigins);

  router.post("/oauth2/register", async (c) => {
    // Content-type must be JSON — matches plugin behavior so SDK error shapes
    // stay identical across both surfaces (RFC 7591 §3.2.1).
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return c.json(
        dcrError("invalid_client_metadata", "Content-Type must be JSON"),
        400,
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        dcrError("invalid_client_metadata", "Invalid JSON body"),
        400,
      );
    }

    const parsed = RegisterBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue ? issue.path.join(".") : "";
      const message = issue?.message ?? "Invalid body";
      return c.json(
        dcrError(
          "invalid_client_metadata",
          path ? `[${path}] ${message}` : message,
        ),
        400,
      );
    }

    const body: RegisterBody = parsed.data;

    // **Who is registering, resolved before anything decides on it.** The
    // `client_credentials` fence below needs the answer, and so does the
    // space binding written onto the row; resolving once at the top is what
    // stops the two disagreeing about whether a session was present.
    //
    // Failure here is non-fatal for an ordinary registration — the client
    // still registers, just unbound — and fatal for a machine one, which the
    // fence enforces by requiring a resolved person rather than by inspecting
    // the error.
    let registeringUserId: string | null = null;
    let registeringSpaceId: string | null = null;
    if (auth) {
      try {
        const session = await auth.getSession(c.req.raw.headers);
        if (session?.user.id) {
          const spaceId = await resolveSpaceIdForAuthUser(
            storage,
            session.user.id,
          );
          if (spaceId) {
            registeringUserId = session.user.id;
            registeringSpaceId = spaceId;
          }
        }
      } catch (err) {
        log("warn", "oauth dcr: space resolution failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // RFC 7591 §2: default to `authorization_code` when omitted — matches plugin behavior.
    const grantTypes = body.grant_types ?? ["authorization_code"];
    const isMachineClient = grantTypes.includes("client_credentials");

    // `refresh_token` is only valid alongside a primary grant that
    // issues refresh tokens. The plugin guards this at config-time;
    // we guard it per-client at registration. Matches the plugin's
    // boot-time check (`dist/index.mjs:2747`).
    if (
      grantTypes.includes("refresh_token") &&
      !grantTypes.includes("authorization_code") &&
      !grantTypes.includes(DEVICE_CODE_GRANT)
    ) {
      return c.json(
        dcrError(
          "invalid_client_metadata",
          "refresh_token grant requires authorization_code or device_code grant",
        ),
        400,
      );
    }

    // `client_credentials` requires an authenticated registration, per
    // RFC 7591 §3.2.1 and the plugin's own DCR. The grant carries no user and
    // no consent, so the person present at registration is the only person it
    // will ever have: their space is the token's space and their permissions
    // are its ceiling. A registration with nobody present therefore has no
    // space to bind to and nothing to be bounded by, and is refused.
    if (isMachineClient && !registeringUserId) {
      return c.json(
        dcrError(
          "invalid_client_metadata",
          "client_credentials grant requires authenticated registration",
        ),
        400,
      );
    }

    // RFC 7591 §2: defaults to `["code"]`. `authorization_code` requires `code` in response_types.
    const responseTypes = body.response_types ?? ["code"];
    if (
      grantTypes.includes("authorization_code") &&
      !responseTypes.includes("code")
    ) {
      return c.json(
        dcrError(
          "invalid_client_metadata",
          "When 'authorization_code' grant type is used, 'code' response type must be included",
        ),
        400,
      );
    }

    // Required for `authorization_code`; device-only clients may omit.
    const needsRedirectUris = grantTypes.includes("authorization_code");
    const redirectUris = body.redirect_uris ?? [];
    if (needsRedirectUris && redirectUris.length === 0) {
      return c.json(
        dcrError(
          "invalid_redirect_uri",
          "Redirect URIs are required for authorization_code grant",
        ),
        400,
      );
    }
    for (const uri of redirectUris) {
      const err = validateRedirectUri(uri, trustedOrigins);
      if (err) {
        return c.json(dcrError("invalid_redirect_uri", err), 400);
      }
    }
    const postLogoutRedirectUris = body.post_logout_redirect_uris ?? [];
    for (const uri of postLogoutRedirectUris) {
      const err = validateRedirectUri(uri, trustedOrigins);
      if (err) {
        return c.json(dcrError("invalid_client_metadata", err), 400);
      }
    }

    // `scope` must be a subset of the server-allowed set. Omitted → the
    // bundle-expansion default from `auth/mint-ceiling.ts`, matching the
    // plugin's `clientRegistrationDefaultScopes`. Defaulting to the FULL
    // allowlist here handed an unauthenticated registration `*:write`;
    // wider scopes stay requestable, explicitly.
    const namedScopes = (body.scope?.trim() ?? "")
      .split(/\s+/)
      .filter((s) => s.length > 0);
    // A named set still gains the session scopes: a ceiling that cannot hold
    // a session mints a client that cannot sign in, and nothing the client
    // can do afterwards repairs it.
    const requestedScopes =
      namedScopes.length === 0
        ? dcrDefaultScopes()
        : withSessionScopes(namedScopes);
    for (const sc of requestedScopes) {
      if (!allowedScopes.has(sc)) {
        return c.json(
          dcrError("invalid_scope", `cannot request scope ${sc}`),
          400,
        );
      }
    }

    // **The machine allowlist is a second column and a second clamp.** The
    // grant is authorized against `client_credentials_scopes` alone — the
    // plugin never consults the `scopes` ceiling on that path — so a machine
    // client's real reach is decided here. It is the named set held to what
    // the registering person's own credential holds, which today is
    // everything in their space; `machineClientCeiling` is where that stops
    // being everything when a person can hold less.
    //
    // A machine registration names its scopes or gets none: the bundle
    // default behind `requestedScopes` is what a consent screen would have
    // offered a person, and there is no person here to be offered it. An
    // empty allowlist is a client the token endpoint answers
    // `unauthorized_client` forever, so the refusal is at the door instead,
    // where whoever registered it can act on it.
    let clientCredentialsScopes: string[] | null = null;
    if (isMachineClient) {
      const ceiling = machineClientCeiling(allowedScopes);
      clientCredentialsScopes = namedScopes.filter((sc) => ceiling.has(sc));
      if (clientCredentialsScopes.length === 0) {
        return c.json(
          dcrError(
            "invalid_scope",
            "client_credentials grant requires an explicit scope the registering account holds",
          ),
          400,
        );
      }
    }

    // DCR registers public clients — mirror the plugin's `auth_method=none`
    // enforcement (`dist/index.mjs:1175-1183`) so SDK response shapes stay
    // identical.
    //
    // A machine client is the exception and has to be: the plugin refuses the
    // `client_credentials` grant to a public client outright, because a
    // credential with no secret and nobody in front of it is a credential
    // anyone who has read the client id holds.
    const tokenEndpointAuthMethod = isMachineClient
      ? "client_secret_basic"
      : "none";
    const clientSecret = isMachineClient
      ? `marfa_cs_${randomBytes(32).toString("hex")}`
      : null;
    const clientType =
      body.type === "web" ? undefined : (body.type ?? undefined);

    // Format-compatible with the plugin's 32-char alphanumeric clientId (`dist/index.mjs:1265`).
    const clientId = generateClientId();
    if (await oauthProvider.clientExists(clientId)) {
      // Collision is astronomically unlikely (32-char a-zA-Z gives
      // ~190 bits) but the check costs nothing.
      return c.json(
        dcrError("server_error", "client id collision; please retry"),
        500,
      );
    }

    let created;
    try {
      created = await oauthProvider.createClient({
        clientId,
        name: body.client_name ?? null,
        isPublic: !isMachineClient,
        grantTypes,
        responseTypes,
        tokenEndpointAuthMethod,
        scopes: requestedScopes,
        clientCredentialsScopes,
        redirectUris,
        postLogoutRedirectUris,
        // Mirrors the plugin's `clientReference` callback. Unauthenticated
        // DCR binds null; space accountability lands later at the consent
        // step. A machine client never takes that path, which is why the
        // fence above requires the binding rather than hoping for it.
        referenceId: registeringSpaceId,
        registeringUserId,
        // The plugin stores secrets as unpadded base64url SHA-256 by default
        // (`storeClientSecret` is unset and the JWT plugin is enabled), so
        // this is the shape `verifyStoredClientSecret` compares against.
        clientSecretHash: clientSecret
          ? createHash("sha256").update(clientSecret).digest("base64url")
          : null,
        clientUri: body.client_uri ?? null,
        logoUri: body.logo_uri ?? null,
        tosUri: body.tos_uri ?? null,
        policyUri: body.policy_uri ?? null,
        contacts: body.contacts ?? null,
        softwareId: body.software_id ?? null,
        softwareVersion: body.software_version ?? null,
        softwareStatement: body.software_statement ?? null,
        type: clientType ?? null,
      });
    } catch (err) {
      log("error", "oauth dcr: createClient failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(dcrError("server_error", "failed to register client"), 500);
    }

    // 201 + no-store cache, matching the plugin's existing endpoint wire shape (RFC 7591 §3.2.1).
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    return c.json(
      {
        client_id: created.clientId,
        client_id_issued_at: created.clientIdIssuedAt,
        client_name: body.client_name ?? undefined,
        redirect_uris: redirectUris,
        ...(postLogoutRedirectUris.length > 0 && {
          post_logout_redirect_uris: postLogoutRedirectUris,
        }),
        token_endpoint_auth_method: tokenEndpointAuthMethod,
        grant_types: grantTypes,
        response_types: responseTypes,
        scope: requestedScopes.join(" "),
        ...(clientSecret !== null && {
          // Handed back once, in this response body, and never readable
          // again — the row keeps only the hash. RFC 7591 §3.2.1 names
          // `client_secret_expires_at`, and `0` is its spelling of "does not
          // expire".
          client_secret: clientSecret,
          client_secret_expires_at: 0,
        }),
        ...(clientCredentialsScopes !== null && {
          client_credentials_scopes: clientCredentialsScopes,
        }),
        public: !isMachineClient,
        disabled: false,
        ...(clientType !== undefined && { type: clientType }),
        ...(body.client_uri !== undefined && { client_uri: body.client_uri }),
        ...(body.logo_uri !== undefined && { logo_uri: body.logo_uri }),
        ...(body.tos_uri !== undefined && { tos_uri: body.tos_uri }),
        ...(body.policy_uri !== undefined && { policy_uri: body.policy_uri }),
        ...(body.contacts !== undefined && { contacts: body.contacts }),
        ...(body.software_id !== undefined && {
          software_id: body.software_id,
        }),
        ...(body.software_version !== undefined && {
          software_version: body.software_version,
        }),
        ...(body.software_statement !== undefined && {
          software_statement: body.software_statement,
        }),
      },
      201,
    );
  });

  return router;
}

/**
 * 32-character a-zA-Z client id. Format-compatible with the plugin's
 * default `generateRandomString(32, "a-z", "A-Z")` so existing tooling
 * that does string-shape matching is unaffected. Sourced from
 * `crypto.randomBytes` rather than `Math.random` — matches the plugin's
 * CSPRNG-backed default and avoids the predictability code-smell on a
 * public identifier.
 */
function generateClientId(): string {
  const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = randomBytes(32);
  let s = "";
  for (let i = 0; i < 32; i += 1) {
    // randomBytes(32) returns exactly 32 bytes; `?? 0` placates
    // noUncheckedIndexedAccess without a non-null assertion.
    const byte = bytes[i] ?? 0;
    s = s + ALPHA.charAt(byte % ALPHA.length);
  }
  return s;
}
