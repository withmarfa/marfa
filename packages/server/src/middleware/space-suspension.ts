/**
 * Space-suspension write-guard middleware.
 *
 * Sits AFTER `authMiddleware` in the middleware chain. After credential
 * resolution, for every non-GET request, if the credential's space is
 * `status: 'suspended'` and the credential is not `is_operator`, the
 * middleware rejects with HTTP 403 `space_suspended`. Reads pass
 * through regardless; the operator key is let through so operators can
 * inspect a suspended space.
 *
 * The gate sits at middleware (not per-route) so every present AND
 * future mutation route is covered without each route remembering to
 * opt in. The corollary is that admin-side writes that target the
 * suspended space (e.g. unsuspending it) are issued by the operator key,
 * which the gate lets through anyway.
 *
 * **Bypass paths:**
 *
 *   - GET / HEAD / OPTIONS — reads + preflight always pass through.
 *   - Anonymous requests (`c.var.apiKey === undefined`) — covers
 *     bootstrap (`POST /keys` when not yet bootstrapped) and the
 *     unauthenticated auth surfaces (`/auth/sign-in`, etc.). These don't
 *     carry a space in the credential — there's nothing to gate.
 *   - Space-less credentials (`apiKey.space_id === undefined`) — the
 *     operator key, and nothing else can be. No space means no per-space
 *     status.
 *   - `is_operator: true` credentials — operators MUST be able to write
 *     to a suspended space to suspend it further, change quotas, or
 *     unsuspend it.
 *
 * **Runtime-credential keys are NOT exempt.** Integration runtime keys
 * (`is_runtime_credential: true`) carry a `space_id` and are not the
 * operator key, so they hit the gate like any other space credential.
 * Suspending a space therefore stops their integrations from writing
 * upstream, which is the desired blast-radius.
 *
 * **Caching.** Space status is read on the hot path of every write;
 * we cache `(space_id) -> status` in-memory with a 5s TTL keyed by
 * space_id. Multi-instance deployments tolerate up to 5s of stale
 * status — the worst case is one extra write being allowed through
 * just after a suspend lands, which the next request catches.
 */
import { createMiddleware } from "hono/factory";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { SpaceStatus } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import type { AppEnv } from "./auth.js";

const TTL_MS = 5_000;

interface CacheEntry {
  status: SpaceStatus;
  expires_at: number;
}

/**
 * Module-scoped cache so the suspend → write-rejected test (which can
 * pre-populate the entry by issuing a write BEFORE the suspend lands)
 * can drop the stale entry via `_clearSpaceStatusCacheForTesting`. In
 * production the cache simply ages out after 5s. Module scope is safe
 * because space_id is globally unique and the cache value (current
 * status) is the same across every middleware instance.
 */
const spaceStatusCache = new Map<string, CacheEntry>();

/** Test-only: drop every cached status row. */
export function _clearSpaceStatusCacheForTesting(): void {
  spaceStatusCache.clear();
}

/**
 * Drop the cached status for a single space. Called by the admin
 * suspend/unsuspend routes immediately after the write, so the next
 * gated request reads the fresh status from storage instead of waiting
 * out the 5s TTL. Multi-instance deployments still tolerate up to 5s
 * of staleness on peer instances (no shared cache), which is the
 * intentional cross-instance fallback.
 */
export function evictSpaceStatus(spaceId: string): void {
  spaceStatusCache.delete(spaceId);
}

/**
 * Build the middleware bound to a storage instance. The cache lives at
 * module scope (see above) — the closure here only captures `storage`.
 */
export function spaceSuspensionMiddleware(storage: Storage) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }

    const apiKey = c.get("apiKey");
    if (!apiKey?.space_id) {
      return next();
    }

    if (apiKey.is_operator) {
      return next();
    }

    // Fail open when the space store is absent, which is a deployment with
    // no space plane at all rather than a caller without a space.
    const spaces = storage.spaces;
    if (!spaces) {
      return next();
    }

    const spaceId = apiKey.space_id;
    const now = Date.now();

    let entry = spaceStatusCache.get(spaceId);
    if (!entry || entry.expires_at <= now) {
      const status = await spaces.getStatus(spaceId);
      // Unknown space: treat as `active` — auth has already validated the
      // credential against a real `space_id`, so the absence of a row
      // here would be a bug elsewhere. Fail open and let downstream
      // surface the real error.
      entry = {
        status: status ?? "active",
        expires_at: now + TTL_MS,
      };
      spaceStatusCache.set(spaceId, entry);
    }

    if (entry.status === "suspended") {
      throw new MarfaError(
        ErrorCode.SPACE_SUSPENDED,
        "This space is suspended; writes are not accepted. Contact your operator.",
      );
    }

    return next();
  });
}
