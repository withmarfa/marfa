/**
 * The keys a credential reaches, and the one way a door acts on an existing
 * key row for a caller.
 *
 * **Holding `keys.mint` opens the key doors and says nothing about which keys
 * behind them.** The mint is clamped to the minter's own reach, so a key
 * cannot make one wider than itself; without the same ceiling here, the same
 * narrow key could revoke the owner's main key, narrow it to nothing, or read
 * every key's reach off the listing. So a credential reaches a key exactly
 * when it could have minted that key: the comparisons are the mint clamp's
 * own, in `mint-clamp.ts`, with the existing key in the place of the request.
 *
 * Every door that reads or changes an existing key row on a caller's behalf
 * goes through `keysInReach`, and `routes/key-row-door-census.test.ts` fails
 * on a call into the key store from anywhere else that it has not been told
 * about.
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
import { requireAuth } from "../middleware/auth.js";
import type { Storage, StoredApiKey } from "../storage/interface.js";
import {
  firstReachBeyondCredential,
  firstUncoveredExtension,
  firstUncoveredScope,
  firstUngrantableSource,
  refuseUnclampableExtensions,
} from "./mint-clamp.js";

/**
 * The credential acting on keys: its principal, and for a signed-in app the
 * scopes its grant carries, which are what its reach is measured against.
 */
export interface KeyActor {
  key: ApiKey;
  grantScopes: readonly string[] | null;
}

declare const inReach: unique symbol;

/** A key row the caller was shown to reach, and the only kind `update` takes. */
export type KeyInReach = StoredApiKey & { readonly [inReach]: true };

/**
 * Whether `actor` reaches `target`: it is the operator key, the target is the
 * actor itself, or the target is no operator key and holds nothing the actor
 * could not have given it at a mint.
 *
 * **A signed-in app is measured against its grant**, as its mint is: the
 * maps against the scopes it was granted, its permissions against the
 * permission literals among them. No scope names an extension namespace, so
 * a key granting any extension reach is beyond every app.
 *
 * **An operator key is beyond every other credential although it holds
 * nothing.** Measured by its maps it would sit inside everyone's reach, and
 * revoking it takes the instance tier away, which no permission confers.
 *
 * A key's own `source` is not measured, because the mint does not clamp it to
 * the caller; its claimed `sources` are.
 */
export function keyWithinReach(actor: KeyActor, target: ApiKey): boolean {
  if (actor.key.is_operator) return true;
  if (target.id === actor.key.id) return true;
  if (target.is_operator) return false;

  const heldPermissions =
    actor.grantScopes === null
      ? (actor.key.permissions ?? [])
      : actor.grantScopes.filter(isPermission);
  if ((target.permissions ?? []).some((p) => !heldPermissions.includes(p))) {
    return false;
  }

  if (actor.grantScopes === null) {
    if (
      firstUncoveredExtension(
        actor.key.extension_permissions,
        target.extension_permissions,
      ) !== null
    ) {
      return false;
    }
    if (firstReachBeyondCredential(actor.key, target) !== null) return false;
  } else {
    if (refuseUnclampableExtensions(target) !== null) return false;
    if (firstUncoveredScope(actor.grantScopes, target) !== null) return false;
  }

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
 * id no key holds: a key out of reach is not one the caller learns exists, as
 * an item outside a credential's type reach answers `item_not_found`.
 */
function keyNotFound(id: string): MarfaError {
  return new MarfaError(ErrorCode.API_KEY_NOT_FOUND, `Key ${id} not found`);
}

/**
 * The key store as one caller may use it: only the rows it reaches are
 * listed, read, changed or revoked, and every other id answers as unknown.
 */
export function keysInReach(storage: Storage, c: Context<AppEnv>) {
  const actor = keyActor(c);

  async function get(id: string): Promise<KeyInReach> {
    const target = await storage.keys.get(id);
    if (target === null || !keyWithinReach(actor, target)) {
      throw keyNotFound(id);
    }
    return target as KeyInReach;
  }

  return {
    get,

    async list(): Promise<StoredApiKey[]> {
      return (await storage.keys.list()).filter((key) =>
        keyWithinReach(actor, key),
      );
    },

    update(target: KeyInReach, input: UpdateKeyInput): Promise<StoredApiKey> {
      return storage.keys.update(target.id, input);
    },

    /**
     * Revoke `id`, or refuse it as `api_key_not_found`.
     *
     * The store reads no revoked row back, so a revoked key's reach cannot be
     * measured: to every caller but the operator key it answers as an id
     * nobody holds. The operator key reaches every key, so it alone is told
     * that the key was already revoked.
     */
    async revoke(id: string): Promise<void> {
      if (!actor.key.is_operator) await get(id);
      const outcome = await storage.keys.revoke(id);
      if (outcome === "revoked") return;
      if (outcome === "already_revoked" && actor.key.is_operator) {
        throw new MarfaError(
          ErrorCode.API_KEY_NOT_FOUND,
          `Key ${id} was already revoked`,
        );
      }
      throw keyNotFound(id);
    },
  };
}
