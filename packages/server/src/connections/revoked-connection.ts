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
 * **The rule is about an integration connection, and the boundary is
 * whether the relationship can come back.** An uninstall is terminal: the
 * runtime is gone, and `SYSTEM_TYPE_TRANSITIONS` gives `revoked` an empty
 * successor list, so moving `state` is a one-way door taken deliberately.
 * An app grant is the opposite kind of thing — a person disconnects an app
 * and later approves it again — so its revoke deliberately leaves
 * `state: "active"` and moves `properties.status` alone, precisely so a
 * re-consent has a row to reactivate. Read literally, that pairing is the
 * disagreement this module forbids, which is why the scope matters: the
 * axes must agree about whether the record is REACHABLE, and a revoked app
 * grant is still listed for the user on the axis that decides that. What
 * cannot happen is the inverse, `state: "revoked"` beside
 * `status: "active"`, which is reachable by no surface and was the actual
 * defect. Do not reach for this writer on the app-grant path: it would
 * take the one-way door and leave every future re-approval to insert a
 * fresh row beside a tombstone the user can neither see nor remove.
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
