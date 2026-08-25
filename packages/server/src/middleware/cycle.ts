import { CYCLE_HEADERS } from "@withmarfa/shared";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";

import { cycleRequestContext } from "../cycle-context.js";
import type { AppEnv } from "./auth.js";

/**
 * Header pair carrying the parent event's cycle metadata into a
 * integration-driven request.
 *
 * The SDK's `ConnectionClient.request()` stamps these on every mutating
 * call (POST/PUT/PATCH/DELETE; not GET) using the integration's parent
 * `cycle` (from `ItemEventMessage.cycle`) and the integration's own
 * `connection_id`. The middleware below reads them off the request and
 * resolves `c.var.cycle` for the rest of the handler.
 *
 * Header values are strings on the wire. `X-Marfa-Cycle-Hop` is parsed
 * via `Number(...)` (decimal); a malformed value falls back to the chain-
 * head shape rather than rejecting the request — the cycle metadata is
 * advisory (the hop budget is enforced at publish time regardless).
 */
// Derived from the shared constant rather than written out again. These
// were a third copy: the exported `CYCLE_HEADERS` below existed for the
// kit's benefit and this middleware read its own lowercase pair, so a
// rename needed three edits and the two the server held were in different
// cases. Hono lowercases header lookups, hence the transform rather than a
// second literal.
const CYCLE_ORIGIN_HEADER = CYCLE_HEADERS.ORIGIN.toLowerCase();
const CYCLE_HOP_HEADER = CYCLE_HEADERS.HOP.toLowerCase();

/**
 * Maximum hop count we accept off the wire. The hop budget is enforced
 * downstream in `passesHopBudget` (defaults to 5; spaces can configure
 * up to a small number), so a header carrying a larger value just
 * signals "this chain has exceeded the budget" — `passesHopBudget` will
 * drop the resulting publish. We still parse the value rather than
 * clamping so the budget check sees the real number; an obviously
 * malicious extreme (e.g. `2^31`) gets rejected as a malformed header
 * via the `Number.isFinite` guard.
 */
const MAX_PARSED_HOP_COUNT = Number.MAX_SAFE_INTEGER;

/**
 * Try to derive the chain-head `originatingConnectionId` from the
 * caller's api key when no `X-Marfa-Cycle-Origin` header is present.
 * Two shapes carry connection identity today:
 *
 *   1. **Runtime credentials** — `apiKey.connection_id` is a typed
 *      direct field set when the credential is minted by the runtime-
 *      credential broker. This is the canonical source.
 *   2. **OAuth tokens** — the auth middleware synthesizes the api key
 *      with `source: "oauth:<connection_item_id>"`. The connection_id
 *      is encoded in the source prefix; we parse it back out here.
 *
 * Anything else — bootstrap admin, ordinary space api keys with no
 * connection binding — has no implicit origin. Returns `null` so the
 * resulting cycle is the human sentinel.
 */
function originFromApiKey(
  apiKey: import("@withmarfa/shared").ApiKey | undefined,
): string | null {
  if (!apiKey) return null;
  if (typeof apiKey.connection_id === "string" && apiKey.connection_id !== "") {
    return apiKey.connection_id;
  }
  // OAuth synthetic api keys live at `source: "oauth:<id>"` per
  // `auth.ts:153-168`. Don't conflate other `<prefix>:<id>` shapes —
  // only `oauth:` is currently meaningful for cycle attribution.
  const source = apiKey.source;
  if (source.startsWith("oauth:")) {
    const id = source.slice("oauth:".length);
    if (id.length > 0) return id;
  }
  return null;
}

/**
 * Resolve cycle metadata for the current request.
 *
 * Mount AFTER `clientIpMiddleware` AND `authMiddleware`: the resolution
 * needs access to `c.var.apiKey` to compute the chain-head fallback.
 *
 * Resolution order:
 *
 *   1. **Headers present** — both `X-Marfa-Cycle-Origin` and
 *      `X-Marfa-Cycle-Hop` carry the parent's cycle. Stamp the resolved
 *      pair on `c.var.cycle`. The next-hop computation is the SDK's
 *      job (it called `nextHopMetadata(parent, currentConnectionId)`
 *      to produce these values); the server treats them as the
 *      already-incremented metadata for THIS request's events.
 *   2. **Headers absent, api key has connection binding** — chain head
 *      from an integration. `originatingConnectionId: <connection_id>`,
 *      `hopCount: 0`. The downstream publish will be the first event
 *      attributed to this connection.
 *   3. **Otherwise** — human chain head. Sentinel:
 *      `{ originatingConnectionId: null, hopCount: 0 }`. Bypasses the
 *      budget at `passesHopBudget`.
 *
 * After resolving the cycle the middleware writes it to BOTH
 * `c.var.cycle` (kept exposed for diagnostic reads) AND the
 * `cycleRequestContext` `AsyncLocalStorage` store. `publish()` and
 * `publishEdge()` in `pubsub.ts` read the ALS automatically, so route
 * handlers don't thread `...c.var.cycle` into every publish call.
 * The two writes stay in lockstep — single resolved value, written
 * twice in the same step.
 */
export function cycleMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const resolved = resolveCycle(c);
    c.set("cycle", resolved);
    await cycleRequestContext.run(resolved, async () => {
      await next();
    });
  });
}

/**
 * Compute the resolved cycle metadata for the current request without
 * applying it. Internal helper for `cycleMiddleware`. Extracted so the
 * conditional resolution paths read top-to-bottom rather than nested
 * inside the wrapper.
 */
function resolveCycle(c: Context<AppEnv>): {
  originatingConnectionId: string | null;
  hopCount: number;
} {
  const headerOrigin = c.req.header(CYCLE_ORIGIN_HEADER);
  const headerHop = c.req.header(CYCLE_HOP_HEADER);

  if (headerOrigin !== undefined && headerHop !== undefined) {
    const parsedHop = Number(headerHop);
    if (
      Number.isFinite(parsedHop) &&
      parsedHop >= 0 &&
      parsedHop <= MAX_PARSED_HOP_COUNT
    ) {
      const trimmedOrigin = headerOrigin.trim();
      return {
        // Empty string in the origin header — treat as null. Integrations
        // sending the chain through always populate origin with a non-
        // empty connection_id; an empty value means "chain head, but the
        // SDK still wanted to send the headers."
        originatingConnectionId:
          trimmedOrigin.length > 0 ? trimmedOrigin : null,
        hopCount: parsedHop,
      };
    }
    // Malformed pair — fall through to api-key chain-head; budget gate still applies.
  }

  const apiKey = c.get("apiKey");
  return {
    originatingConnectionId: originFromApiKey(apiKey),
    hopCount: 0,
  };
}

/**
 * Re-exported rather than declared. `@withmarfa/shared` owns these names.
 * Both this middleware and the runtime kit's `ConnectionClient` used to
 * hold their own copy, and both said they were the one place it was kept.
 */
export { CYCLE_HEADERS };
