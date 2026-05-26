/**
 * T-131: `/auth/authorize` consent page (Hono route).
 *
 * Replaces the homegrown GET/POST `/auth/authorize` handlers that lived
 * in `routes/auth-pages.ts`. The @better-auth/oauth-provider plugin's
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
import type { ParsedScope } from "@withmarfa/shared";
import {
  parseScope,
  isValidScope,
  TYPE_REGISTRY,
  EDGE_TYPE_REGISTRY,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";
import { renderConsentScreen } from "./consent.js";
import { setNoStore } from "./no-store.js";
import { publish } from "../pubsub.js";
import { log } from "../middleware/logger.js";

interface ConsentRouteDeps {
  storage: Storage;
  auth: MarfaAuth | undefined;
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

    // F12: resolve the client row (full row, not just the name). 404 only
    // when the row doesn't exist (genuinely unknown client). When the row
    // exists but `name` is null (DCR clients without `client_name` per
    // RFC 7591 §2 — `client_name` is OPTIONAL), fall back to displaying
    // the `clientId` itself rather than 404'ing a legitimate client.
    const client = await resolveClient(deps.storage, clientId);
    if (!client) {
      return c.text(`Unknown client: ${clientId}`, 404);
    }
    const clientName = client.name ?? clientId;

    // Wave C PR5 re-consent diff: look up the user's prior consent for
    // (client_id, user_id) in auth_oauth_consent. If present, the renderer
    // shows the diff (added/kept/removed); if not, renders flat.
    const priorScopes = await resolvePriorScopes(
      deps.storage,
      clientId,
      session.user.id,
    );

    // Build the type-pattern → plain-English description map.
    // F11: covers item types (TYPE_REGISTRY), edge types (EDGE_TYPE_REGISTRY),
    // and the standard OIDC literals (built-in copy). Metadata scopes are
    // skipped — they're operator-tooling scopes that don't need UI copy.
    const descriptions = buildScopeDescriptions(parsed);

    // Optional error banner (e.g. when redirected back from a zero-scopes
    // accept). Renderer ignores undefined.
    const error = url.searchParams.get("error");
    const errorMessage = error ? translateConsentError(error) : undefined;

    const html = renderConsentScreen({
      clientName,
      scopes: parsed,
      clientId,
      oauthQuery,
      descriptions,
      priorScopes,
      errorMessage,
    });

    // F9: every consent-page render carries `Cache-Control: no-store` etc.
    // (Wave C PR8 / §3.18 regression — the homegrown surface had this set
    // explicitly; the T-131 rewrite dropped it.) See `routes/no-store.ts`
    // for the helper used across every auth HTML surface.
    setNoStore(c);
    return c.html(html);
  });

  // ---------------------------------------------------------------------
  // POST /auth/authorize/decision — Marfa-owned decision handler that
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

    // Parse form FIRST (before the session check) so we can preserve
    // `oauth_query` on a session-expired bounce to sign-in (F10). Without
    // it the user signs back in and lands on /auth/sign-in's default
    // post-auth target instead of the consent page they were on.
    const form = await c.req.formData();
    const accept = form.get("accept") === "true";
    const oauthQueryRaw = form.get("oauth_query");
    const oauthQuery =
      typeof oauthQueryRaw === "string" ? oauthQueryRaw : undefined;

    const session = await deps.auth.getSession(c.req.raw.headers);
    if (!session) {
      // F10: preserve oauth_query → user returns to consent after sign-in.
      // If the form was malformed (no oauth_query), fall back to bare /sign-in.
      if (oauthQuery) {
        const returnTo = encodeURIComponent(`/auth/authorize?${oauthQuery}`);
        return c.redirect(`/auth/sign-in?return_to=${returnTo}`, 302);
      }
      return c.redirect("/auth/sign-in", 302);
    }

    if (!oauthQuery) {
      return c.text("Missing required form field: oauth_query", 400);
    }

    // F1: parse `client_id` + `scope` from the verified `oauth_query`,
    // NOT from form fields. The plugin signed the oauth_query — those
    // values are tamper-evident. The form's `client_id` hidden field is
    // for display only; the form's `scopes` checkboxes are the user's
    // per-row selection (a subset of the signed scope set). Trusting the
    // form would let a hostile POST write a projection for a different
    // client than the one the user is actually approving.
    const signedParams = new URLSearchParams(oauthQuery);
    const clientId = signedParams.get("client_id");
    const signedScopeStr = signedParams.get("scope") ?? "";
    const signedScopes = new Set(signedScopeStr.split(/\s+/).filter(Boolean));
    if (!clientId) {
      return c.text("oauth_query missing client_id", 400);
    }

    // Form-supplied scopes are the user's per-row checkbox state.
    // Validate they're a subset of the signed scopes (the consent UI
    // can only narrow, not widen). Anything outside the signed set is
    // a hostile or buggy form — drop and continue with the signed set.
    const formScopes = form
      .getAll("scopes")
      .filter((v): v is string => typeof v === "string")
      .filter((s) => signedScopes.has(s));

    // F2/F14: zero-scopes accept = deny. If the user submits with
    // `accept=true` but no scope checkboxes ticked, the plugin would
    // default to the originally-requested scope set (full grant) AND
    // the Marfa projection would skip (so /security shows no grant
    // while tokens are valid). Both outcomes are wrong. Treat as a
    // deny + redirect back to consent with an error banner.
    if (accept && formScopes.length === 0) {
      return c.redirect(
        `/auth/authorize?${oauthQuery}&error=no_scopes_selected`,
        302,
      );
    }

    const scopeStr = formScopes.join(" ");

    // Project system.connection + emit audit BEFORE proxying to the
    // plugin. Best-effort — a projection failure must NOT block the
    // user-facing consent flow (the OAuth token issuance will still
    // succeed via the plugin; only the user-visible /security grant
    // listing would be missing).
    //
    // F7: thread `client_ip` so the audit row carries it per CLAUDE.md
    // T-027 convention.
    if (accept) {
      try {
        await projectGrantOnConsent(deps.storage, {
          authUserId: session.user.id,
          clientId,
          scopes: formScopes,
          clientIp: c.var.clientIp ?? null,
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
      // Forward the user's narrowed scope set so the plugin issues a
      // token matching what they actually approved (not the full
      // originally-requested set).
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
          // F13: preserve plugin response headers on the 302
          // normalisation. The plugin may set `Set-Cookie` (e.g. to
          // refresh the session cookie) or other security headers; a
          // bare `c.redirect(url)` constructs a fresh response and
          // discards them.
          const headers = new Headers(proxyResp.headers);
          headers.delete("content-type");
          headers.delete("content-length");
          headers.set("location", body.url);
          return new Response(null, { status: 302, headers });
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
 * `routes/auth-pages.ts` does for the device-flow path. Emits
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
  opts: {
    authUserId: string;
    clientId: string;
    scopes: string[];
    clientIp: string | null;
  },
): Promise<void> {
  // T-144: cycle metadata flows through `cycleRequestContext` (set by
  // `cycleMiddleware`) — `publish()` reads it automatically. The
  // explicit `cycle` field on `opts` was dead weight under the new shape.
  let tenantId: string | undefined;
  if (storage.users) {
    const userRow = await storage.users.getByAuthUserId(opts.authUserId);
    tenantId = userRow?.tenant_id ?? undefined;
  }

  // Look up existing projection. If present, this is a re-consent and we
  // update the scopes in place. If absent, this is a first-time consent
  // and we insert. Either way the audit row emits + publish event fires.
  let grantItemId: string | null = null;
  if (typeof storage.oauthProvider?.findGrantItemId === "function") {
    grantItemId = await storage.oauthProvider.findGrantItemId({
      tenantId: tenantId ?? null,
      clientId: opts.clientId,
      authUserId: opts.authUserId,
    });
  }

  const now = new Date().toISOString();
  let projectedItem: import("@withmarfa/shared").Item;
  let eventType: "created" | "updated";
  let priorScopes: string[] = [];

  if (grantItemId) {
    // F6: route the update through `storage.items.update` instead of a
    // raw SQL patch. items.update writes a `versions` snapshot (so
    // re-consent appears in the row's version history), bumps
    // `updated_at` + `version`, and lets the projection row behave like
    // every other item under `/items?sort=updated_at`. Pre-fix, the
    // `updateGrantScopes` storage helper bypassed all of that.
    //
    // Pre-fetch the existing row to (a) compute prior scopes for the
    // F4 narrowing check and (b) make sure we PATCH (merge) rather than
    // OVERWRITE properties — items.update does a properties merge, so
    // unrelated extension data (if any) survives.
    const existing = await storage.items.get(grantItemId, tenantId);
    if (existing) {
      priorScopes = Array.isArray(existing.properties.scopes)
        ? (existing.properties.scopes as string[])
        : [];
    }

    // F3: re-consent resets `status` to "active" + clears `revoked_at`.
    // Pre-fix, a previously-revoked row had its scopes updated but
    // `status="revoked"` stuck → /security hid the grant while the
    // plugin issued tokens against it. Setting `revoked_at: undefined`
    // makes JSON.stringify drop the key from the stored properties.
    const updated = await storage.items.update(
      grantItemId,
      {
        properties: {
          scopes: opts.scopes,
          status: "active",
          granted_at: now,
          revoked_at: undefined,
        },
      },
      tenantId,
    );
    if ("error" in updated) {
      // Unreachable: we don't pass `version`, so the merge path bypasses
      // conflict detection. Defensive.
      throw new Error(
        "projectGrantOnConsent: unexpected version conflict on re-consent",
      );
    }
    projectedItem = updated;
    eventType = "updated";

    // F4: if the new scope set is a strict subset of the prior set
    // (any prior scope is missing from new), the user has narrowed
    // their consent. Existing access tokens were issued under the
    // wider scope and should be revoked so RPs can't continue calling
    // narrowed-away APIs. Refresh tokens are left intact — the next
    // refresh will mint at the narrower scope.
    if (
      typeof storage.oauthProvider?.revokeAccessTokensForGrant === "function"
    ) {
      const newSet = new Set(opts.scopes);
      const narrowed = priorScopes.some((s) => !newSet.has(s));
      if (narrowed) {
        await storage.oauthProvider.revokeAccessTokensForGrant(
          opts.clientId,
          opts.authUserId,
        );
      }
    }
  } else {
    // First-time consent: insert a fresh row.
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
        source: "marfa/oauth2/consent",
      },
      tenantId,
    );
    grantItemId = item.id;
    projectedItem = item;
    eventType = "created";
  }

  // F17: emit a pubsub event so webhook subscribers + SSE clients see
  // the new / updated grant. Mirrors the canonical pattern in
  // `routes/items.ts`. Device-flow's `createUserAppGrant` already does
  // this for its insert path; code-flow consent was the missing site.
  // Fire-and-forget — a publish failure (e.g. cycle-budget overflow)
  // must NOT block the user-facing consent flow.
  void publish({
    type: eventType,
    item: projectedItem,
    tenantId,
  });

  // F7: thread `client_ip` per CLAUDE.md T-027 convention. Every audit
  // row carries the resolved client IP so operators can correlate
  // grants with the source request.
  void storage.audit.log({
    tenant_id: tenantId ?? null,
    action: "auth.grant.created",
    resource_type: "oauth_grant",
    resource_id: opts.clientId,
    client_ip: opts.clientIp,
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
 * F12: look up the full client row from the plugin's `auth_oauth_client`
 * table. Returns null when the row genuinely doesn't exist (unknown
 * `client_id` → callers 404). When the row exists but `name` is null
 * (a DCR client registered without `client_name`, which RFC 7591 §2
 * allows), the caller falls back to displaying the `client_id` itself
 * — we don't 404 a legitimate but unnamed client.
 */
async function resolveClient(
  storage: Storage,
  clientId: string,
): Promise<{ name: string | null } | null> {
  try {
    if (typeof storage.oauthProvider?.getClient === "function") {
      const row = await storage.oauthProvider.getClient(clientId);
      return row ? { name: row.name } : null;
    }
    return null;
  } catch (err) {
    log("warn", "consent: resolveClient failed", {
      client_id: clientId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
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
 * Built-in copy for the standard OIDC literals — the OIDC spec doesn't
 * carry plain-English descriptions, but the user needs to know what
 * they're approving. These strings are user-facing and intentionally
 * plain; mirror the language convention of the type-registry
 * descriptions.
 */
const OIDC_SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Confirm your identity.",
  profile: "See your name and profile picture.",
  email: "See your email address.",
  offline_access: "Stay signed in even when you're not using the app.",
};

/**
 * User-facing copy for the consent screen, keyed by type id (core
 * types, system types) or edge type id. Intentionally separate from
 * the type registry's `description` field — those are written for
 * developers (reference notes, schema rationale, internal references
 * to workstream IDs, etc.) and read fine in API docs but land poorly
 * on a consent screen. Keep these short, plain, second-person, and
 * one line each.
 *
 * Missing entries fall back to the type registry's `description` —
 * which is correct behaviour for custom types registered at runtime
 * via `POST /types`, where the operator controls the copy. For core
 * + system types every entry is curated below so the registry copy
 * never reaches the screen.
 */
const CONSENT_TYPE_DESCRIPTIONS: Record<string, string> = {
  // Core content
  "core.note": "Your notes.",
  "core.task": "Your tasks and to-dos.",
  "core.bookmark": "Bookmarks and saved links.",
  "core.highlight": "Highlights and excerpts.",
  "core.event": "Calendar events.",
  "core.message": "Messages and conversations.",

  // Entities
  "core.entity": "Organisations and other entities.",
  "core.entity.person": "People in your contacts.",
  "core.entity.place": "Places and venues.",

  // Files
  "core.file": "Files.",
  "core.file.audio": "Audio files and recordings.",
  "core.file.image": "Photos and images.",
  "core.file.video": "Videos.",

  // Media
  "core.media": "Media — books, films, music, podcasts.",
  "core.media.album": "Music albums.",
  "core.media.article": "Articles.",
  "core.media.book": "Books.",
  "core.media.film": "Films.",
  "core.media.podcast": "Podcasts.",
  "core.media.series": "TV series.",
  "core.media.song": "Songs.",
  "core.media.tv_episode": "TV episodes.",

  // System
  "system.activity": "Background activity and notifications.",
  "system.app": "Connected apps.",
  "system.connection": "Connections to other apps and services.",
  "system.credential": "API keys and credentials.",
  "system.device": "Devices signed in to your account.",
  "system.integration": "Available integrations.",
  "system.webhook": "Webhook subscriptions.",

  // Edge types — relationships between items.
  about: "Links between items and what they're about.",
  "parent-of": "Parent and child relationships.",
  "in-thread": "Items grouped into threads.",
  "attached-to": "File attachments on items.",
  references: "References between items.",
  "authored-by": "Authorship — who created what.",
  "derived-from": "Items derived from other items.",
  supersedes: "Updates and replacements between items.",
};

/**
 * Build the `{ typePattern: description }` map the renderer uses for
 * the plain-English hint per scope row. Three sources by kind (F11):
 *
 *  - **Type** scopes → `TYPE_REGISTRY.get(typeId)?.description`
 *  - **Edge** scopes → `EDGE_TYPE_REGISTRY.get(edgeType)?.description`
 *  - **OIDC** scopes → `OIDC_SCOPE_DESCRIPTIONS` built-in map
 *  - **Metadata** scopes → skipped (operator-tooling scopes that don't
 *    need a UI description; the literal `metadata:read` etc. is
 *    self-explanatory to the audience that requests them)
 *
 * Missing entries fall through to the renderer rendering just the
 * literal — never an error.
 */
export function buildScopeDescriptions(
  scopes: ParsedScope[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of scopes) {
    if (s.kind === "oidc") {
      const literal = s.oidcScope ?? s.typePattern;
      const copy = OIDC_SCOPE_DESCRIPTIONS[literal];
      if (copy) out[s.typePattern] = copy;
      continue;
    }
    if (s.kind === "edge") {
      // `edgeType` is optional on ParsedScope but always present when
      // kind === "edge"; guard for the type-checker.
      const edgeType = s.edgeType;
      if (edgeType) {
        // Curated user-facing copy wins. Falls back to the registry's
        // engineering description for any edge type without a curated
        // entry (custom edge types registered at runtime).
        const curated = CONSENT_TYPE_DESCRIPTIONS[edgeType];
        if (curated) {
          out[s.typePattern] = curated;
        } else {
          const edgeSchema = EDGE_TYPE_REGISTRY.get(edgeType);
          if (edgeSchema?.description) {
            out[s.typePattern] = edgeSchema.description;
          }
        }
      }
      continue;
    }
    if (s.kind === "metadata") continue;
    // Same pattern for type scopes — curated copy first, registry
    // description as fallback (covers custom types).
    const curated = CONSENT_TYPE_DESCRIPTIONS[s.typePattern];
    if (curated) {
      out[s.typePattern] = curated;
      continue;
    }
    const schema = TYPE_REGISTRY.get(s.typePattern);
    if (schema?.description) {
      out[s.typePattern] = schema.description;
    }
  }
  return out;
}

/**
 * Map the `?error=...` query param (set when GET /authorize is reached
 * via a redirect from a failed decision attempt) to a user-facing
 * sentence. Unknown error codes return undefined → no banner shown.
 */
function translateConsentError(code: string): string | undefined {
  if (code === "no_scopes_selected") {
    return "Approve needs at least one permission ticked. Tick what you'd like to grant, or click Deny to cancel.";
  }
  return undefined;
}
