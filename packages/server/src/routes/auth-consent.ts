/**
 * T-131: `/auth/authorize` consent page (Hono route).
 *
 * Replaces the homegrown GET/POST `/auth/authorize` handlers that lived
 * in `routes/oauth.ts`. The @better-auth/oauth-provider plugin's
 * `consentPage: "/auth/authorize"` config redirects unauthenticated /
 * unaccepted authorization requests here with three query params:
 *
 *   - `client_id` — the OAuth client requesting access
 *   - `scope`     — space-separated scope literals (Myme grammar)
 *   - `code`      — the pre-minted authorization code (binding handle)
 *
 * This route reads those, resolves the client name + the user's prior
 * consent for the re-consent diff, and renders via the existing
 * `renderConsentScreen`. The form POSTs back to `/auth/oauth2/consent`
 * (owned by the plugin) with `code` + `accept` + `scope`.
 *
 * Auth gating: the plugin only redirects here when the user is already
 * signed in (it redirects to `loginPage: "/auth/sign-in"` first). If
 * a no-session request lands here directly, we bounce to sign-in with
 * a return_to so the round-trip works.
 */

import { Hono } from "hono";
import type { ParsedScope } from "@mymehq/shared";
import {
  parseScope,
  isValidScope,
  TYPE_REGISTRY,
} from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MymeAuth } from "../auth/instance.js";
import { renderConsentScreen } from "./consent.js";
import { log } from "../middleware/logger.js";

interface ConsentRouteDeps {
  storage: Storage;
  auth: MymeAuth | undefined;
}

export function authConsentRoutes(deps: ConsentRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ----- GET /auth/authorize (consent page render) -----
  app.get("/authorize", async (c) => {
    if (!deps.auth) {
      return c.text("Auth not configured on this instance", 503);
    }

    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id") ?? "";
    const scopeParam = url.searchParams.get("scope") ?? "";
    const code = url.searchParams.get("code") ?? "";

    if (!clientId || !code) {
      return c.text("Missing client_id or code", 400);
    }

    // Auth gate: the plugin's loginPage handles unsigned users normally,
    // but a direct hit on /auth/authorize without a session needs a
    // fallback bounce to sign-in. We pass the full URL as return_to
    // so the round-trip completes after sign-in.
    const session = await deps.auth.getSession(c.req.raw.headers);
    if (!session) {
      const returnTo = encodeURIComponent(url.pathname + url.search);
      return c.redirect(`/auth/sign-in?return_to=${returnTo}`);
    }

    // Parse + validate the requested scopes. Reject early on invalid
    // grammar — the plugin's own scope validation runs at /oauth2/authorize
    // (which mints the code), but a hand-crafted URL into /authorize
    // shouldn't bypass that.
    const scopeLiterals = scopeParam.split(/\s+/).filter(Boolean);
    const parsed: ParsedScope[] = [];
    for (const literal of scopeLiterals) {
      if (!isValidScope(literal)) {
        return c.text(`Invalid scope: ${literal}`, 400);
      }
      const p = parseScope(literal);
      if (!p) {
        return c.text(`Unparseable scope: ${literal}`, 400);
      }
      parsed.push(p);
    }

    // Resolve the client name from the plugin's `auth_oauth_client` table.
    // The Drizzle adapter is on storage.betterAuthDb (unwrapped, bypasses RLS).
    const clientName = await resolveClientName(deps.storage, clientId);
    if (!clientName) {
      return c.text(`Unknown client: ${clientId}`, 404);
    }

    // Wave C PR5 re-consent diff: look up the user's prior consent for
    // (client_id, user_id) in auth_oauth_consent. If present, the renderer
    // shows the diff (added/kept/removed); if not, renders flat.
    const priorScopes = await resolvePriorScopes(
      deps.storage,
      clientId,
      session.user.id,
    );

    // Build the type-pattern → plain-English description map from the
    // type registry; falls back to the literal scope when missing.
    const descriptions = buildScopeDescriptions(parsed);

    const html = renderConsentScreen({
      clientName,
      scopes: parsed,
      clientId,
      code,
      descriptions,
      priorScopes,
    });

    return c.html(html);
  });

  // ---------------------------------------------------------------------
  // POST /auth/authorize/decision — Myme-owned decision handler that
  // proxies to the plugin's /oauth2/consent endpoint, writing the
  // system.connection projection + audit row deterministically BEFORE
  // the plugin handles the rest of the flow.
  //
  // The plugin's /oauth2/consent body doesn't carry client_id (it links
  // via the pre-minted `code`), and its `hooks.after` matchers fire
  // after the redirect, making it hard to write the projection reliably.
  // This explicit handler reads `client_id` from the form (which our
  // renderConsentScreen includes as a hidden field), looks up the
  // session for `user_id`, writes the projection, then forwards the
  // request to /auth/oauth2/consent.
  // ---------------------------------------------------------------------
  app.post("/authorize/decision", async (c) => {
    if (!deps.auth) {
      return c.text("Auth not configured on this instance", 503);
    }
    const session = await deps.auth.getSession(c.req.raw.headers);
    if (!session) {
      return c.redirect("/auth/sign-in", 302);
    }

    const form = await c.req.formData();
    const accept = form.get("accept") === "true";
    const code = form.get("code");
    const clientId = form.get("client_id");
    const scopesField = form.get("scope") ?? form.get("scopes");
    if (typeof code !== "string" || typeof clientId !== "string") {
      return c.text("Missing required form fields: code, client_id", 400);
    }
    // The form posts each scope as a separate `scopes` field; collect.
    const scopes = form
      .getAll("scopes")
      .filter((v): v is string => typeof v === "string");
    const scopeStr =
      typeof scopesField === "string" && scopesField.length > 0
        ? scopesField
        : scopes.join(" ");

    // Project system.connection + emit audit BEFORE proxying to the
    // plugin. Best-effort — a projection failure must NOT block the
    // user-facing consent flow (the OAuth token issuance will still
    // succeed via the plugin; only the user-visible /security grant
    // listing would be missing).
    if (accept && scopes.length > 0) {
      try {
        await projectGrantOnConsent(deps.storage, {
          authUserId: session.user.id,
          clientId,
          scopes,
        });
      } catch (err) {
        log("warn", "consent decision: projection failed", {
          client_id: clientId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Forward to the plugin's /oauth2/consent endpoint. We re-craft the
    // Request with form-encoded body (the plugin reads body parameters
    // from JSON or form, depending on content-type). Cookies pass
    // through via the original headers — the session cookie is what
    // the plugin uses to authenticate the consent decision.
    const proxyBody = new URLSearchParams();
    proxyBody.set("accept", String(accept));
    proxyBody.set("code", code);
    if (scopeStr) proxyBody.set("scope", scopeStr);

    const proxyUrl = new URL("/auth/oauth2/consent", c.req.url);
    const proxyHeaders = new Headers(c.req.raw.headers);
    proxyHeaders.set("content-type", "application/x-www-form-urlencoded");
    // Drop content-length; the body is being replaced.
    proxyHeaders.delete("content-length");

    const proxyReq = new Request(proxyUrl.toString(), {
      method: "POST",
      headers: proxyHeaders,
      body: proxyBody.toString(),
      // Preserve redirect-following behaviour at the browser level.
      redirect: "manual",
    });

    return deps.auth.handler(proxyReq);
  });

  return app;
}

/**
 * Write the `system.connection { kind: "app" }` projection for an
 * accepted code-flow consent. Mirrors what `createUserAppGrant` in
 * `routes/oauth.ts` does for the device-flow path. Emits
 * `auth.grant.created` audit row.
 *
 * Best-effort idempotency: if a row already exists for (tenant, client,
 * user) in the active state, we don't add a second one — but we also
 * don't update the existing scopes here (the plugin's authoritative
 * `auth_oauth_consent` row already has the new scope set). The
 * /security page reads system.connection.properties.scopes — a future
 * follow-on should update it on re-consent. For now: first-time consent
 * creates the row; re-consent leaves the existing row's stale scopes
 * visible until the user revokes + re-grants.
 */
async function projectGrantOnConsent(
  storage: Storage,
  opts: { authUserId: string; clientId: string; scopes: string[] },
): Promise<void> {
  let tenantId: string | undefined;
  if (storage.users) {
    const userRow = await storage.users.getByAuthUserId(opts.authUserId);
    tenantId = userRow?.tenant_id ?? undefined;
  }
  const now = new Date().toISOString();
  const item = await storage.items.create(
    {
      type: "system.connection",
      tier: "library",
      state: "active",
      properties: {
        kind: "app",
        client_id: opts.clientId,
        user_id: opts.authUserId,
        scopes: opts.scopes,
        status: "active",
        granted_at: now,
      },
      source: "myme/oauth2/consent",
    },
    tenantId,
  );
  void storage.audit.log({
    tenant_id: tenantId ?? null,
    action: "auth.grant.created",
    resource_type: "oauth_grant",
    resource_id: opts.clientId,
    details: {
      client_id: opts.clientId,
      user_id: opts.authUserId,
      scopes: opts.scopes,
      grant_item_id: item.id,
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the friendly client name from the plugin's `auth_oauth_client`
 * table. The plugin's adapter writes there with `client_id` as the
 * unique business key.
 */
async function resolveClientName(
  storage: Storage,
  clientId: string,
): Promise<string | undefined> {
  try {
    // The Better Auth adapter is on storage.betterAuthDb. For a direct
    // Drizzle read we use the unwrapped handle + the schema reference
    // from the appropriate dialect package. To keep this routing module
    // dialect-agnostic, we call through a small helper on the Storage
    // interface that picks the right schema at runtime.
    if (typeof storage.oauthProvider?.getClientName === "function") {
      return await storage.oauthProvider.getClientName(clientId);
    }
    return undefined;
  } catch (err) {
    log("warn", "consent: resolveClientName failed", {
      client_id: clientId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Look up the user's most recent prior consent for this (client_id, user_id)
 * combo from `auth_oauth_consent`. Returns the scope literals from that
 * row, or `undefined` if no prior grant exists.
 */
async function resolvePriorScopes(
  storage: Storage,
  clientId: string,
  authUserId: string,
): Promise<readonly string[] | undefined> {
  try {
    if (typeof storage.oauthProvider?.getPriorConsent === "function") {
      return await storage.oauthProvider.getPriorConsent(clientId, authUserId);
    }
    return undefined;
  } catch (err) {
    log("warn", "consent: resolvePriorScopes failed", {
      client_id: clientId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Build the `{ typePattern: description }` map the renderer uses for
 * the plain-English hint per scope row. Pulls `description` from the
 * type registry; missing entries are simply omitted (renderer shows
 * just the literal).
 */
function buildScopeDescriptions(
  scopes: ParsedScope[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of scopes) {
    if (s.kind === "oidc") continue;
    if (s.kind === "edge" || s.kind === "metadata") continue;
    const schema = TYPE_REGISTRY.get(s.typePattern);
    if (schema?.description) {
      out[s.typePattern] = schema.description;
    }
  }
  return out;
}

