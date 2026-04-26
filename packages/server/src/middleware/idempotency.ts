import { createHash } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./auth.js";
import type { Storage } from "../storage/interface.js";

/**
 * Validation pattern for the `Idempotency-Key` header. Permissive enough
 * to accept any UUID variant, ULID, or sync-client-generated UUIDv7,
 * tight enough that abuse stays bounded — no path traversal, no SQL
 * fragments, no whitespace.
 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Verbs that go through the cache. GET / HEAD / OPTIONS are naturally
 * idempotent — sending an Idempotency-Key on those is harmless but
 * pointless, and we don't need the latency hit of a lookup.
 */
const STATE_CHANGING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Only JSON responses are cached. SSE (`text/event-stream`), NDJSON
 * export (`application/x-ndjson`), HTML consent pages, and binary blob
 * downloads either can't be safely cached (streaming) or don't need it
 * (blob downloads are GET).
 */
function isJsonResponse(headers: Headers): boolean {
  const ct = headers.get("Content-Type")?.toLowerCase() ?? "";
  return ct.startsWith("application/json");
}

export interface IdempotencyOptions {
  /** Hours an entry survives before the cleanup job purges it. */
  retentionHours: number;
}

/**
 * Idempotency-Key middleware.
 *
 * Sits after `authMiddleware`. On a state-changing request that carries
 * the `Idempotency-Key` header:
 *
 *   - **Cache hit, matching request hash** → return cached response.
 *     The handler does not run, audit and webhook side-effects do not
 *     fire.
 *   - **Cache hit, mismatched request hash** → 422 `idempotency_key_reused`
 *     (caller misuse: same key, different request).
 *   - **Cache miss** → run handler, cache the response if it's a JSON
 *     2xx/4xx, return as-is. 5xx and streaming responses are not cached
 *     (5xx so retries are allowed; streaming because the body can't be
 *     captured without breaking the response).
 *
 * Opt-in only: if the header is absent, the middleware is a no-op.
 * Existing API consumers (CLI, MCP, raycast) are unaffected.
 */
export function idempotencyMiddleware(
  storage: Storage,
  options: IdempotencyOptions,
) {
  const retentionMs = options.retentionHours * 60 * 60 * 1000;

  return createMiddleware<AppEnv>(async (c, next) => {
    if (!STATE_CHANGING_METHODS.has(c.req.method)) return next();

    const key =
      c.req.header("Idempotency-Key") ?? c.req.header("idempotency-key");
    if (!key) return next();

    if (!KEY_PATTERN.test(key)) {
      return c.json(
        {
          error: {
            code: "idempotency_key_invalid",
            message:
              "Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-].",
          },
        },
        400,
      );
    }

    const apiKey = c.get("apiKey");
    if (!apiKey) {
      // No credentials yet (auth middleware will reject downstream).
      // Skip the cache lookup — we don't have an api_key_id to scope to.
      return next();
    }
    const apiKeyId = apiKey.id;

    // Hash the request body alongside method + path so a replay with a
    // different body is detectable. We clone first so the original
    // request body is still readable by the handler.
    const reqClone = c.req.raw.clone();
    const bodyText = await reqClone.text();
    const requestHash = createHash("sha256")
      .update(`${c.req.method} ${c.req.path}\n${bodyText}`)
      .digest("hex");

    const cached = await storage.idempotency.get(apiKeyId, key);
    if (cached) {
      if (cached.request_hash !== requestHash) {
        return c.json(
          {
            error: {
              code: "idempotency_key_reused",
              message:
                "Idempotency-Key already used for a different request body or path.",
            },
          },
          422,
        );
      }
      return new Response(cached.response_body, {
        status: cached.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Cache miss. Let the route handler run.
    await next();

    const response = c.res;
    if (!response) return;
    const status = response.status;

    // Only cache 2xx and 4xx. 5xx is intentionally not cached so retries
    // (transient db errors, upstream timeouts) succeed on a later try.
    // 1xx and 3xx aren't reachable from JSON API handlers in practice.
    if (status < 200 || status >= 500) return;
    if (!isJsonResponse(response.headers)) return;

    // Capture the body via a clone so the original response remains
    // readable for the client.
    let responseBody: string;
    try {
      const cloned = response.clone();
      responseBody = await cloned.text();
    } catch {
      // If reading fails (rare — only if the body has already been
      // consumed by a buggy upstream), skip caching. The original
      // response goes back to the client untouched.
      return;
    }

    const now = Date.now();
    try {
      await storage.idempotency.put({
        api_key_id: apiKeyId,
        key,
        request_hash: requestHash,
        status,
        response_body: responseBody,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + retentionMs).toISOString(),
      });
    } catch {
      // Persistence failure shouldn't break the response. The cache miss
      // becomes a (silent) cache miss next time too — annoying but not
      // wrong. If a load-balanced replica is down, the next attempt
      // hits a healthy one.
    }
  });
}

/**
 * Compute the cleanup cutoff `expires_at <= cutoff` for the cleanup job.
 * Exposed so the job can call `storage.idempotency.cleanup(cutoff)`
 * without re-deriving the timestamp logic.
 */
export function idempotencyCleanupCutoff(): string {
  return new Date().toISOString();
}
