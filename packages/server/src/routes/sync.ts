import { Hono } from "hono";
import {
  TYPE_REGISTRY,
  EDGE_TYPE_REGISTRY,
  matchesTypePattern,
} from "@mymehq/shared";
import type { ApiKey } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * Logical shape families exposed to sync clients. Each maps to one
 * underlying Postgres table replicated by Electric. No dynamic mapping —
 * the proxy exists to enforce auth, not to be configurable.
 */
const SHAPE_FAMILIES = {
  items: "items",
  edges: "edges",
  metadata: "metadata",
} as const;

type ShapeFamily = keyof typeof SHAPE_FAMILIES;

/** Query params that pass through unchanged to Electric. Anything else is dropped. */
const PASSTHROUGH_PARAMS = new Set([
  "offset",
  "handle",
  "live",
  "columns",
  "cursor",
]);

/**
 * Headers Electric returns that the proxy forwards to the client. The
 * full list of `electric-*` headers can grow; we forward by prefix
 * rather than maintaining an allowlist.
 */
const ELECTRIC_HEADER_PREFIX = "electric-";

export interface SyncRouteOptions {
  /**
   * Base URL of the Electric service (e.g. `http://localhost:8603`). Per
   * the deployment plan this is set per-server-instance: the active
   * server points at `:8603`, the mock at `:8604`.
   */
  electricUrl: string;
  /**
   * Override for the global `fetch`. Tests inject a stub here so they
   * don't need a real Electric service.
   */
  fetch?: typeof fetch;
}

export function syncRoutes(options: SyncRouteOptions): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const fetchImpl = options.fetch ?? fetch;
  const electricUrl = options.electricUrl.replace(/\/+$/, "");

  router.get("/shapes/:family", async (c) => {
    const apiKey = requireAuth(c);
    const familyParam = c.req.param("family");

    if (!isShapeFamily(familyParam)) {
      return c.json(
        {
          error: {
            code: "shape_unknown",
            message: `Unknown shape family: ${familyParam}. Expected one of: items, edges, metadata.`,
          },
        },
        400,
      );
    }
    const family: ShapeFamily = familyParam;
    const table = SHAPE_FAMILIES[family];

    // Build the permission-derived WHERE clause + positional params.
    // Returns null when the caller has no readable rows in this family;
    // we short-circuit with an empty 200 instead of round-tripping to
    // Electric (and avoid Electric's "1 = 0" parser quirks).
    const filter = buildShapeFilter(apiKey, family);
    if (filter === EMPTY_FILTER) {
      return new Response("[]", {
        status: 200,
        headers: emptyShapeHeaders(),
      });
    }

    // Compose upstream URL.
    const upstreamUrl = new URL(`${electricUrl}/v1/shape`);
    upstreamUrl.searchParams.set("table", table);
    if (filter.where) {
      upstreamUrl.searchParams.set("where", filter.where);
      filter.params.forEach((value, idx) => {
        upstreamUrl.searchParams.set(`params[${String(idx + 1)}]`, value);
      });
    }
    const clientQuery = c.req.query();
    for (const [key, value] of Object.entries(clientQuery)) {
      if (PASSTHROUGH_PARAMS.has(key)) {
        upstreamUrl.searchParams.set(key, value);
      }
    }

    // Forward to Electric. Don't pass the caller's Authorization header —
    // Electric is reached only over a private network and has its own
    // (or no) auth.
    let upstream: Response;
    try {
      upstream = await fetchImpl(upstreamUrl.toString(), {
        method: "GET",
        headers: passthroughRequestHeaders(c.req.raw.headers),
        signal: c.req.raw.signal,
      });
    } catch (error) {
      // Network error (Electric down, DNS, etc.). 502 is the right
      // signal — the proxy is alive but the upstream isn't.
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        {
          error: {
            code: "shape_upstream_unavailable",
            message: `Electric upstream did not respond: ${message}`,
          },
        },
        502,
      );
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: passthroughResponseHeaders(upstream.headers),
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers — exported for unit testing
// ---------------------------------------------------------------------------

interface ShapeFilter {
  where: string | null;
  params: string[];
}

const EMPTY_FILTER: ShapeFilter = { where: "__empty__", params: [] };

function isShapeFamily(value: string): value is ShapeFamily {
  return value === "items" || value === "edges" || value === "metadata";
}

/**
 * Compute the permission-derived `WHERE` clause and positional parameters
 * for the requested shape family. Returns `EMPTY_FILTER` when the caller
 * has no readable rows; the caller short-circuits with an empty response
 * rather than asking Electric to return zero rows.
 *
 * Exported so it's directly unit-testable without spinning up Hono.
 */
export function buildShapeFilter(
  apiKey: ApiKey,
  family: ShapeFamily,
): ShapeFilter {
  const params: string[] = [];
  const conditions: string[] = [];

  // Tenant scoping. Always applied — admin or not. Electric replicates
  // the underlying table, which carries `tenant_id`; the proxy must keep
  // the boundary so a multi-tenant deployment doesn't leak across keys.
  if (apiKey.tenant_id) {
    params.push(apiKey.tenant_id);
    conditions.push(`tenant_id = $${String(params.length)}`);
  }

  // Type / edge-type scoping. Admin keys bypass.
  if (apiKey.role !== "admin") {
    if (family === "items") {
      const allowed = expandReadableTypes(apiKey);
      if (allowed.length === 0) return EMPTY_FILTER;
      const typeParams = allowed.map((t) => {
        params.push(t);
        return `$${String(params.length)}`;
      });
      conditions.push(`type IN (${typeParams.join(", ")})`);
      // Trashed items are excluded by default per the build plan; an
      // opt-in toggle could be added later via a query param.
      conditions.push(`state != 'trashed'`);
    } else if (family === "edges") {
      const allowed = expandReadableEdgeTypes(apiKey);
      // `null` == wildcard (no filter needed).
      if (allowed === null) {
        // no-op
      } else if (allowed.length === 0) {
        return EMPTY_FILTER;
      } else {
        const edgeParams = allowed.map((t) => {
          params.push(t);
          return `$${String(params.length)}`;
        });
        conditions.push(`edge_type IN (${edgeParams.join(", ")})`);
      }
    } else if (family === "metadata") {
      // metadata has no `type` or `state` columns. Filter via subquery
      // on items.id. Electric's WHERE supports subqueries (experimental
      // as of Electric 1.5.x — see Sources in the build plan). If that
      // proves unstable, revert to admin-only metadata replication.
      const allowed = expandReadableTypes(apiKey);
      if (allowed.length === 0) return EMPTY_FILTER;
      const typeParams = allowed.map((t) => {
        params.push(t);
        return `$${String(params.length)}`;
      });
      conditions.push(
        `item_id IN (SELECT id FROM items WHERE type IN (${typeParams.join(", ")}) AND state != 'trashed')`,
      );
    }
  } else {
    // Admin on items: still exclude trashed by default (clients that
    // need trash do so via the regular HTTP API, which doesn't replicate
    // here). Mirrors the non-admin shape so the demo app's behaviour is
    // stable across role.
    if (family === "items") {
      conditions.push(`state != 'trashed'`);
    }
  }

  return {
    where: conditions.length > 0 ? conditions.join(" AND ") : null,
    params,
  };
}

/**
 * Expand the API key's `type_permissions` patterns into a concrete list
 * of type identifiers, drawn from the runtime type registry. `*` and
 * `prefix.*` wildcards are expanded against `TYPE_REGISTRY`. Returns an
 * empty array if no readable types — the caller short-circuits to an
 * empty response.
 */
export function expandReadableTypes(apiKey: ApiKey): string[] {
  const out = new Set<string>();
  const knownTypes = Array.from(TYPE_REGISTRY.keys());

  for (const [pattern, level] of Object.entries(apiKey.type_permissions)) {
    if (level === "none") continue;
    // `level` is "read" or "write"; both grant read.
    if (pattern === "*") {
      knownTypes.forEach((t) => out.add(t));
      continue;
    }
    if (pattern.endsWith(".*")) {
      knownTypes.forEach((t) => {
        if (matchesTypePattern(t, [pattern])) out.add(t);
      });
      continue;
    }
    out.add(pattern);
  }

  return Array.from(out);
}

/**
 * Expand the API key's `edge_permissions` into a concrete list of edge
 * type identifiers. Returns `null` for the wildcard case (no filter
 * needed), or an array of types. Empty array means "no readable edges"
 * and the caller short-circuits.
 */
export function expandReadableEdgeTypes(apiKey: ApiKey): string[] | null {
  const perms = apiKey.edge_permissions;
  if (!perms) return [];

  // Wildcard short-circuit.
  if (perms["*"] === "read" || perms["*"] === "write") {
    return null;
  }

  const out: string[] = [];
  for (const [edgeType, level] of Object.entries(perms)) {
    if (edgeType === "*") continue;
    if (level === "read" || level === "write") {
      // Defensive: only include types that exist in the registry.
      if (EDGE_TYPE_REGISTRY.has(edgeType)) {
        out.push(edgeType);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Header pass-through
// ---------------------------------------------------------------------------

function passthroughRequestHeaders(input: Headers): Headers {
  // Forward only safe headers to the upstream. Notably stripped:
  // Authorization (Electric reaches over a private network and has its
  // own auth posture), Cookie (no business going to Electric), Host.
  const out = new Headers();
  const forward = ["accept", "accept-encoding", "if-none-match"];
  for (const name of forward) {
    const value = input.get(name);
    if (value) out.set(name, value);
  }
  return out;
}

function passthroughResponseHeaders(input: Headers): Headers {
  const out = new Headers();
  const contentType = input.get("content-type");
  if (contentType) out.set("Content-Type", contentType);
  const cacheControl = input.get("cache-control");
  if (cacheControl) out.set("Cache-Control", cacheControl);

  // Forward all electric-* headers (handle, offset, schema, up-to-date,
  // cursor, etc.). The list grows; an explicit allowlist is brittle.
  for (const [name, value] of input.entries()) {
    if (name.toLowerCase().startsWith(ELECTRIC_HEADER_PREFIX)) {
      out.set(name, value);
    }
  }

  // CRITICAL: the response varies by Authorization. Without `Vary` a
  // CDN or browser cache could serve one credential's shape to another.
  out.set("Vary", "Authorization");

  return out;
}

function emptyShapeHeaders(): Headers {
  const out = new Headers();
  out.set("Content-Type", "application/json");
  out.set("Cache-Control", "no-cache");
  out.set("Vary", "Authorization");
  // Surface the synthetic-empty marker so client-side debugging can
  // distinguish "no data" from "zero rows after filtering".
  out.set("electric-up-to-date", "true");
  return out;
}
