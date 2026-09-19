/**
 * Catching a client's stored scope ceiling up to what it is asking for.
 *
 * `auth_oauth_client.scopes` is written once, at registration, and never
 * again, so it is a snapshot of an allowlist that moves whenever the type
 * registry does. A client ages out of the platform silently: a type
 * registered after the client was is uncoverable by it forever, the consent
 * screen still offers the scope, the request still asks for it, and the
 * grant comes back without it and without a word. Six scopes went missing
 * from one client that way, and no grant on either environment held any of
 * them.
 *
 * Two surfaces ask a client for scopes and both read that row, so both need
 * the repair. Neither may answer the question its own way: the authorize
 * hook rewrites a request and hands it back to the vendored provider, which
 * re-validates it against the very same row with exact membership
 * (`new Set(client.scopes ?? opts.scopes)`, `.has(scope)`, no pattern
 * matching anywhere in it), and device initiation compares the row exactly
 * for the same reason one file over. So the repair cannot be a wider
 * comparison at either site. It has to be a write: put the requested
 * literal INTO the stored row, and the exact tests on both surfaces then
 * pass on their own terms.
 */
import { isValidScope } from "@withmarfa/shared";
import { publishableBundleScopes } from "./allowlist-withholding.js";
import type { PermissionBundle } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { log } from "../middleware/logger.js";

/**
 * Which surface performed a catch-up. It reaches the log line and the audit
 * row because the two surfaces fail differently and an operator reading the
 * trail afterwards has to be able to tell which one moved the row: an
 * authorize catch-up rides a browser redirect with a person in front of it,
 * a device catch-up answers a machine that polled for it.
 */
export type CeilingCatchUpSurface = "authorize" | "device";

/**
 * What the metadata document advertises to every client, as opposed to
 * everything a client may request. The requestable allowlist is the wider
 * set (wildcards, every registered type); this is the curated bundle union.
 * The distinction is what lets a stored ceiling stop freezing without
 * becoming no ceiling at all.
 *
 * Filtered by the grammar, deliberately not by `default_on`, and the two
 * halves are easy to mistake for each other.
 *
 * The grammar filter is here because this is the same raw configuration a
 * second reader already checks, and this set is what a stale client ceiling
 * is widened by. An unchecked literal would be written into a registration
 * row and audit-logged as a scope, which is a false record rather than a
 * live grant, and the cheaper of the two to prevent.
 *
 * Off-by-default bundles are included on purpose. The widening runs before
 * either surface knows who is asking, so one unauthenticated request can
 * add an off-by-default bundle's scopes to a stored registration — and that
 * is the point, because letting an already-registered client reach a scope
 * it was never registered for, without re-registering, is the case an
 * off-by-default bundle exists to serve. Narrowing here would defeat it.
 *
 * What keeps that safe is not this function. A ceiling is permission to ask,
 * and both surfaces that answer withhold on their own: each renders the
 * scope unticked, so leaving it alone grants nothing. Do not delete either
 * on the grounds that the ceiling looks narrow, because it is not.
 *
 * Device initiation used to refuse such a scope outright instead, because
 * its approval screen had no tick to withhold with. That screen has toggles
 * now and the refusal is retired, which changes where the withholding
 * happens and not whether it does.
 */
export function bundlePublishedScopes(
  bundles: readonly PermissionBundle[],
): Set<string> {
  // The withheld drop belongs here as much as in `buildAllowedScopes`, and
  // more subtly: this set is what a stale client ceiling is WIDENED BY. A
  // permission literal admitted here is written into a registration
  // row, where it outlives the configuration that introduced it — so the drop
  // applied at one door and not the other would leave the narrower door
  // repairing the damage the wider one had already stored.
  return new Set(
    publishableBundleScopes(bundles, (scope) => isValidScope(scope)),
  );
}

/**
 * Widen a stale stored ceiling so it covers the scopes this request names,
 * and answer with the ceiling as it now stands.
 *
 * Three bounds, all load-bearing.
 *
 * **Only what this request actually asks for**, rather than the whole bundle
 * union. The ceiling is also what a client gets when it omits `scope`, so
 * widening it wholesale would silently turn every no-scope authorize into a
 * request for everything. Growing it one requested literal at a time means
 * the row ends up recording what this client has genuinely asked for, which
 * is the honest version of the same repair.
 *
 * **Only scopes the bundles publish.** The bundles are what the metadata
 * document advertises to every client, re-derived from the live registry at
 * every boot precisely so custom types stay coverable, so a client asking
 * for one is asking for something this server tells every client it may ask
 * for. Everything outside them still needs the client registered for it:
 * the wildcards, and the per-type scopes the curated set leaves out.
 *
 * **Widen only, never shrink.** The snapshot is stale in both directions,
 * and a scope for a type that no longer exists is dropped at request time
 * against the live allowlist instead, where it costs nothing and needs no
 * write. A null ceiling already tracks the live set, and an empty one is a
 * deliberate, real ceiling this must not quietly fill in, so both are
 * returned untouched.
 *
 * A failed catch-up is not a failed request. It logs and answers with the
 * ceiling as it was, which is the ordinary path when there is nothing to
 * catch up: the caller's own comparison still runs against the row as it
 * stands.
 */
export async function catchUpClientScopeCeiling(opts: {
  storage: Storage;
  clientId: string;
  requested: readonly string[];
  ceiling: readonly string[] | null;
  bundleScopes: ReadonlySet<string>;
  surface: CeilingCatchUpSurface;
}): Promise<readonly string[] | null> {
  const { storage, clientId, requested, ceiling, bundleScopes, surface } = opts;
  const oauth = storage.oauthProvider;
  if (!oauth) return ceiling;
  if (ceiling === null || ceiling.length === 0) return ceiling;

  const held = ceiling;
  const missing = requested.filter(
    (scope) => bundleScopes.has(scope) && !held.includes(scope),
  );
  if (missing.length === 0) return ceiling;

  const widened = [...held, ...missing];
  try {
    if (!(await oauth.widenClientScopes(clientId, held, widened))) {
      return ceiling;
    }
  } catch (err) {
    // A failed catch-up is not a failed request. The comparison the caller
    // makes next still runs against the ceiling as it stands, which is the
    // ordinary path when there is nothing to catch up.
    log("warn", `oauth ${surface}: could not widen a stale ceiling`, {
      client_id: clientId,
      error: err,
    });
    return ceiling;
  }

  log("info", `oauth ${surface}: caught a stale client ceiling up`, {
    client_id: clientId,
    added_scopes: missing,
  });
  // Audited rather than only logged, and audited separately from whatever
  // the caller does next, because this one is the registration row changing.
  // It also happens before either surface has resolved a session, so it is
  // the one event on these paths that no signed-in identity is attached to —
  // which makes it the one most worth a record rather than the one least
  // worth it. The surface is part of the row for the same reason it is part
  // of the log line: two callers write this action and the trail has to say
  // which.
  void storage.audit.log({
    action: "auth.client.scopes_widened",
    resource_type: "oauth_client",
    resource_id: clientId,
    client_ip: null,
    details: {
      client_id: clientId,
      surface,
      added_scopes: missing,
      ceiling_size: widened.length,
    },
  });
  return widened;
}
