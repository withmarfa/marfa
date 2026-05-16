/**
 * T-131: `/auth/authorize` consent page (Hono route).
 *
 * Replaces the homegrown GET/POST `/auth/authorize` handlers that lived
 * in `routes/oauth.ts`. The @better-auth/oauth-provider plugin's
 * `consentPage: "/auth/authorize"` config redirects unauthenticated /
 * unaccepted authorization requests here with the **full signed
 * authorize-request query string** as the URL's search part:
 *
 *   `/auth/authorize?response_type=code&client_id=...&redirect_uri=...
 *   &scope=...&state=...&code_challenge=...&code_challenge_method=S256
 *   &exp=<ts>&sig=<hmac>`
 *
 * (No pre-minted code — the plugin signs the params and forwards.
 * Verified in @better-auth/oauth-provider@1.6.9 `index.mjs:3909-3925`
 * `redirectWithPromptCode` + `signParams`.)
 *
 * This route:
 *   - extracts `client_id` + `scope` from the query for rendering
 *   - keeps the full URL search string verbatim as `oauthQuery` so the
 *     consent form can POST it back to `/auth/oauth2/consent` unchanged
 *     (the plugin's before-hook re-verifies the sig)
 *   - looks up the user's prior consent for the re-consent diff
 *   - renders via the existing `renderConsentScreen`
 *
 * The decision handler (`POST /auth/authorize/decision`) projects the
 * `system.connection { kind: "app" }` row + emits `auth.grant.created`,
 * then proxies to `/auth/oauth2/consent` with `{ accept, scope?,
 * oauth_query }`. The plugin verifies the sig, upserts its own
 * `oauthConsent` row, mints the code, and returns a JSON redirect
 * body `{ redirect: true, url: "<redirect_uri>?code=..." }` which we
 * forward to the browser as a 302.
 *
 * Auth gating: the plugin only redirects here when the user is already
 * signed in (it redirects to `loginPage: "/auth/sign-in"` first). If
 * a no-session request lands here directly, we bounce to sign-in with
 * a return_to so the round-trip works.
 */

import { Hono } from "hono";
import type { ParsedScope } from "@mymehq/shared";
import { parseScope, isValidScope, TYPE_REGISTRY } from "@mymehq/shared";
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
    // The plugin signs the entire query string and expects it returned
    // verbatim. We preserve the original `search` (minus leading `?`)
    // and round-trip it through the form's `oauth_query` hidden field.
    // `sig` is the canary — without it the plugin won't accept the
    // consent POST, which lets us 400 early rather than render a
    // consent screen that will fail on submit.
    const oauthQuery = url.search.startsWith("?")
      ? url.search.slice(1)
      : url.search;
    const sig = url.searchParams.get("sig");

    if (!clientId || !sig) {
      return c.text(
        "Missing required query params: client_id and sig (the plugin's signed redirect to /auth/authorize must carry both)",
        400,
      );
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
      oauthQuery,
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
  // The plugin's /oauth2/consent body shape (verified in source
  // @better-auth/oauth-provider@1.6.9 `index.mjs:2958-2982`):
  //   { accept: boolean, scope?: string, oauth_query: string }
  // where `oauth_query` is the full signed query string the plugin
  // redirected us here with. Plugin's before-hook verifies the sig
  // against `oauth_query`, re-hydrates the original authorize-request
  // params into `oAuthState`, then `consentEndpoint` mints the code
  // and returns `{ redirect: true, url: "<redirect_uri>?code=..." }`.
  //
  // This explicit handler:
  //   1. reads `accept` + `client_id` + `oauth_query` + selected
  //      `scopes` from the form
  //   2. projects `system.connection { kind: "app" }` (insert OR update
  //      on re-consent) + emits `auth.grant.created` audit row
  //   3. POSTs `{ accept, scope, oauth_query }` to /auth/oauth2/consent
  //      (JSON body — the plugin's `allowedMediaTypes` defaults to JSON
  //      for this endpoint)
  //   4. forwards the resulting redirect (302 OR JSON
  //      `{redirect, url}`) to the browser as a real 302
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
    const clientId = form.get("client_id");
    const oauthQuery = form.get("oauth_query");
    if (typeof clientId !== "string" || typeof oauthQuery !== "string") {
      return c.text(
        "Missing required form fields: client_id, oauth_query",
        400,
      );
    }
    // The form posts each selected scope as a separate `scopes` field; collect.
    const scopes = form
      .getAll("scopes")
      .filter((v): v is string => typeof v === "string");
    const scopeStr = scopes.join(" ");

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

    // Forward to the plugin's /oauth2/consent endpoint. JSON body
    // (plugin's default media type for this endpoint). Cookies pass
    // through via the original headers — the session cookie is what
    // the plugin uses to authenticate the consent decision.
    const proxyUrl = new URL("/auth/oauth2/consent", c.req.url);
    const proxyHeaders = new Headers(c.req.raw.headers);
    proxyHeaders.set("content-type", "application/json");
    proxyHeaders.delete("content-length");

    const proxyBody: Record<string, unknown> = {
      accept,
      oauth_query: oauthQuery,
    };
    if (accept && scopeStr) {
      // Only forward the scope filter when the user actually picked a
      // subset (or the full set). On deny, the plugin doesn't read scope.
      proxyBody.scope = scopeStr;
    }

    const proxyReq = new Request(proxyUrl.toString(), {
      method: "POST",
      headers: proxyHeaders,
      body: JSON.stringify(proxyBody),
      redirect: "manual",
    });

    const proxyResp = await deps.auth.handler(proxyReq);
    // The plugin returns either a 302 (browser-native redirect) OR a 200
    // with JSON body `{ redirect: true, url: "..." }`. The latter is the
    // default when better-auth doesn't see Accept: text/html. Normalise
    // to a 302 either way so the browser navigates correctly.
    if (proxyResp.status === 302) {
      return proxyResp;
    }
    if (proxyResp.status === 200) {
      try {
        const cloned = proxyResp.clone();
        const body = (await cloned.json()) as {
          redirect?: boolean;
          url?: string;
        };
        if (body.redirect && typeof body.url === "string") {
          return c.redirect(body.url, 302);
        }
      } catch {
        // Fall through — return the plugin response verbatim.
      }
    }
    return proxyResp;
  });

  return app;
}

/**
 * Write or refresh the `system.connection { kind: "app" }` projection for
 * an accepted code-flow consent. Mirrors what `createUserAppGrant` in
 * `routes/oauth.ts` does for the device-flow path. Emits
 * `auth.grant.created` audit row in both branches (creation + re-consent).
 *
 * Re-consent behaviour: if a projection already exists for (tenant,
 * client, user), we update its `scopes` + `granted_at` in place rather
 * than creating a second row. The `audit.grant.created` row still emits
 * (a re-consent IS a grant event), with the existing `grant_item_id`
 * in details — operators auditing grant history see one row per consent
 * action, projection stays single-row per (tenant, client, user).
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

  // Look up existing projection. If present, this is a re-consent and we
  // update the scopes in place. If absent, this is a first-time consent
  // and we insert. Either way the audit row emits.
  let grantItemId: string | null = null;
  if (typeof storage.oauthProvider?.findGrantItemId === "function") {
    grantItemId = await storage.oauthProvider.findGrantItemId({
      tenantId: tenantId ?? null,
      clientId: opts.clientId,
      authUserId: opts.authUserId,
    });
  }

  if (grantItemId) {
    // Re-consent: update scopes + granted_at on the existing row.
    if (typeof storage.oauthProvider?.updateGrantScopes === "function") {
      await storage.oauthProvider.updateGrantScopes({
        itemId: grantItemId,
        tenantId: tenantId ?? null,
        scopes: opts.scopes,
      });
    }
  } else {
    // First-time consent: insert a fresh row.
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
    grantItemId = item.id;
  }

  void storage.audit.log({
    tenant_id: tenantId ?? null,
    action: "auth.grant.created",
    resource_type: "oauth_grant",
    resource_id: opts.clientId,
    details: {
      client_id: opts.clientId,
      user_id: opts.authUserId,
      scopes: opts.scopes,
      grant_item_id: grantItemId,
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
function buildScopeDescriptions(scopes: ParsedScope[]): Record<string, string> {
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
