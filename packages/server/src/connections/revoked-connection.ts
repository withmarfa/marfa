/**
 * The one write that puts a `system.connection` into its terminal state.
 *
 * Two paths produce a revoked connection: an uninstall, and the
 * compensation walker of an install that failed after step 1. They are the
 * same fact and they drifted, because they were written months apart and
 * nothing connected them. Uninstall learned to write all three fields
 * together; the compensation kept transitioning `state` alone, so every
 * install that failed after the connection row committed left a row reading
 * `state: revoked` beside `status: active` and `runtime_status: healthy` —
 * and every operator surface reads the properties rather than the state, so
 * a connection nobody had successfully installed rendered as live and
 * healthy. Correcting one and not the other is how it happened the first
 * time, so there is one writer now.
 *
 * **Three fields, not one.** `state` is the item's lifecycle axis.
 * `properties.status` is the type's own lifecycle status and its enum is
 * exactly `active | revoked`, so the two cannot legitimately disagree.
 * `runtime_status` describes a runtime that is gone; the enum gained a
 * `revoked` member for this, because a health field with no way to say
 * "there is nothing left to be healthy" will always be reporting the health
 * of something that no longer runs.
 *
 * **Stamped, never cleared.** A property cannot be removed through the
 * update path: the merge is shallow and an explicit null on an optional
 * field means "leave unset", so deleting `runtime_status` here would
 * silently leave `healthy` in place. That is exactly how the stale value
 * survived an uninstall.
 *
 * **A delta, not the whole object.** `items.update` merges against what is
 * stored, so resubmitting the connection's full property bag would be
 * redundant on the ordinary path and a revert on any path where something
 * touched the row in between.
 *
 * **One transaction, so a partial failure cannot recreate the
 * disagreement.** The caller owns the connection lifecycle lock: uninstall
 * holds it across its whole pipeline and the install compensation takes it
 * for this write alone, and neither can be expressed here without one of
 * them taking it twice.
 */
import type { Storage } from "../storage/interface.js";

/** The property half of the terminal state. Exported so a test can assert
 *  against the thing the code writes rather than against a copy of it. */
export const REVOKED_CONNECTION_PROPERTIES: Record<string, unknown> = {
  status: "revoked",
  runtime_status: "revoked",
};

/**
 * Move a `system.connection` to revoked, lifecycle state and the
 * denormalized properties that describe it, in one transaction.
 *
 * Call it holding the connection's lifecycle lock.
 */
export async function writeRevokedConnectionState(
  storage: Storage,
  connectionId: string,
  spaceId?: string,
): Promise<void> {
  await storage.runInTransaction(async () => {
    await storage.items.transition(connectionId, "revoked", spaceId);
    await storage.items.update(
      connectionId,
      { properties: REVOKED_CONNECTION_PROPERTIES },
      spaceId,
    );
  });
}
