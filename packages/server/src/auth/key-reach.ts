/**
 * The keys a credential reaches, and the one way a door acts on an existing
 * key row for a caller.
 *
 * **Holding `keys.mint` opens the key doors and says nothing about which keys
 * behind them.** The mint is clamped to the minter's own reach; without the
 * same ceiling here, a narrow key could revoke the owner's main key, narrow it
 * to nothing, or read every key's reach off the listing. So a credential
 * reaches a key exactly when it could have given that key what it holds: the
 * comparisons are the mint clamp's own, in `mint-clamp.ts`, with the existing
 * key in the place of the request.
 *
 * The `/keys` doors that read or change an existing key row go through
 * `keysInReach`; `routes/key-row-door-census.test.ts` says what else in this
 * package touches a key row, and why.
 */
import {
  ErrorCode,
  isPermission,
  MarfaError,
  type ApiKey,
  type UpdateKeyInput,
} from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  isDirectAuthority,
  holdsPermission,
  requirePermission,
} from "../middleware/auth.js";
import type { Storage, StoredApiKey } from "../storage/interface.js";
import {
  firstReachBeyondCredential,
  firstUncoveredExtension,
  firstUncoveredScope,
  firstUngrantableSource,
  type RequestedReach,
} from "./mint-clamp.js";

/**
 * The credential acting on keys: its principal, and for a signed-in app the
 * scopes its grant carries.
 */
export interface KeyActor {
  key: ApiKey;
  grantScopes: readonly string[] | null;
}

declare const inReach: unique symbol;

/** A key row the caller was shown to reach. */
export type KeyInReach = StoredApiKey & { readonly [inReach]: true };

const MAP_FAMILIES = [
  "type_permissions",
  "edge_permissions",
  "metadata_permissions",
  "profile_permissions",
] as const;

/**
 * Whether a signed-in app could have given `target` its maps.
 *
 * **Per family, either way the app can write one.** A family the app names
 * on a mint or an update is measured against the grant's literals; a family
 * it names nowhere on a mint is copied from the maps its grant projects,
 * which is what an ordinary `content:read` grant's key holds, with its
 * `none` denials. Asking only the first would put the app's own default key
 * beyond it.
 */
function sessionCouldGiveMaps(
  actor: KeyActor & { grantScopes: readonly string[] },
  target: ApiKey,
): boolean {
  return MAP_FAMILIES.every((family) => {
    const one: RequestedReach = { [family]: target[family] };
    return (
      firstUncoveredScope(actor.grantScopes, one) === null ||
      firstReachBeyondCredential(actor.key, one) === null
    );
  });
}

export function keyWithinReach(actor: KeyActor, target: ApiKey): boolean {
  if (target.id === actor.key.id) return true;

  const heldPermissions =
    actor.grantScopes === null
      ? (actor.key.permissions ?? [])
      : actor.grantScopes.filter(isPermission);
  if ((target.permissions ?? []).some((p) => !heldPermissions.includes(p))) {
    return false;
  }
  if (
    firstUncoveredExtension(
      actor.key.extension_permissions,
      target.extension_permissions,
    ) !== null
  ) {
    return false;
  }
  const mapsWithin =
    actor.grantScopes === null
      ? firstReachBeyondCredential(actor.key, target) === null
      : sessionCouldGiveMaps(
          { ...actor, grantScopes: actor.grantScopes },
          target,
        );
  if (!mapsWithin) return false;

  return firstUngrantableSource(actor.key, target.sources) === null;
}

/** The credential this request acts as, for measuring key reach. */
export function keyActor(c: Context<AppEnv>): KeyActor {
  const key = requireAuth(c);
  return {
    key,
    grantScopes:
      c.get("authType") === "oauth"
        ? (c.get("oauthGrant")?.scopes ?? [])
        : null,
  };
}

/**
 * The answer for a key the caller does not reach, which is the answer for an
 * id no key holds, as an item outside a credential's type reach answers
 * `item_not_found`.
 */
function keyNotFound(id: string): MarfaError {
  return new MarfaError(ErrorCode.API_KEY_NOT_FOUND, `Key ${id} not found`);
}

/**
 * The key store as one caller may use it: only the rows it reaches are
 * listed, changed or revoked, and every other id answers as unknown.
 *
 * **A change and a revoke measure and write inside one transaction**, so a
 * key widened between the measuring and the writing is measured as it is
 * written rather than as it was read.
 */
export function keysInReach(storage: Storage, c: Context<AppEnv>) {
  function managesAll(): boolean {
    if (isDirectAuthority(c)) return true;
    if (holdsPermission(c, "keys.manage")) {
      requirePermission(c, "keys.manage");
      return true;
    }
    requirePermission(c, "keys.mint");
    return false;
  }

  async function reached(id: string): Promise<KeyInReach> {
    const target = await storage.keys.get(id);
    if (
      target === null ||
      (!managesAll() && !keyWithinReach(keyActor(c), target))
    ) {
      throw keyNotFound(id);
    }
    return target as KeyInReach;
  }

  return {
    async list(): Promise<StoredApiKey[]> {
      return (await storage.keys.list()).filter(
        (key) => managesAll() || keyWithinReach(keyActor(c), key),
      );
    },

    /**
     * Change `id` with what `decide` makes of the row as it stands. `decide`
     * refuses by throwing, and runs under the same lock as the write.
     */
    change(
      id: string,
      decide: (existing: KeyInReach) => UpdateKeyInput,
    ): Promise<StoredApiKey> {
      return storage.runInTransaction(async () => {
        const existing = await reached(id);
        return await storage.keys.update(id, decide(existing));
      });
    },

    async revoke(id: string): Promise<void> {
      const outcome = await storage.runInTransaction(async () => {
        if (!managesAll()) await reached(id);
        return await storage.keys.revoke(id);
      });
      if (outcome === "revoked") return;
      if (outcome === "already_revoked" && managesAll()) {
        throw new MarfaError(
          ErrorCode.API_KEY_NOT_FOUND,
          `Key ${id} was already revoked`,
        );
      }
      throw keyNotFound(id);
    },
  };
}

/** The key store as one caller may use it. */
export type KeysInReach = ReturnType<typeof keysInReach>;
