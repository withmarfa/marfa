import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { Item } from "@withmarfa/shared";

/**
 * Why a `system.connection` row that is still live is refused by every door
 * that would remove it or move it out of the active state, and what the
 * caller is sent to instead.
 *
 * **A grant's tokens must not outlive the row that names their owner**, and
 * none of these doors keeps that true on its own: each removes or retires
 * the row and none revokes anything. Refusing rather than revoking here is
 * the point. Revoking would be a second teardown beside the grant cascade,
 * and two teardowns drift, so this door sends the caller to the door that
 * already does it properly. An already-revoked connection goes freely: the
 * cascade has run and the row is ordinary history.
 *
 * **An `app` connection is an OAuth grant.** A grant is two records, this
 * projection and the plugin's consent row, with the app's tokens hanging
 * off the pair. Removing or retiring the projection leaves the tokens live
 * and the consent row standing, so the app keeps working and the next
 * authorize is answered silently, while the security page has nothing left
 * to show a Disconnect button for. `DELETE /auth/grants/{id}` and its
 * form-friendly twin run the cascade that drops all of it first.
 *
 * **Liveness is the grant's own axis, `properties.status`, and only that.**
 * The revoke cascade writes `status: "revoked"` and leaves the lifecycle
 * `state` alone; nothing on the grants surface ever moves `state`. A row
 * with `state: "revoked"` and `status: "active"` is therefore not a
 * tombstone but the strand itself, tokens live and invisible to both read
 * surfaces, and it is refused like any other live grant: purging it would
 * make the strand permanent, since nothing could ever run the cascade for
 * it again. Anything that is not literally `"revoked"` counts as live, on
 * both kinds, so an unknown or missing status fails closed.
 *
 * **Two call sites, and they are the two doors that reach a connection at
 * all.** The delete cascade asks it of every row the walk reaches, the root
 * included, which is the only way a credential addresses a connection: the
 * type gate on `DELETE /items/{id}` refuses a `system.connection` write to
 * everything the product mints, and it ran against the named row alone. The
 * purge door asks it directly, because it reads the row before it asks the
 * write question.
 *
 * The single transition door and the two bulk doors used to ask it too, and
 * none of them could answer: the transition route sits behind the same type
 * gate and behind a lifecycle table that admits only `revoked` for a
 * `system.*` type, which its schema cannot name, and the bulk door's
 * reserved-namespace narrowing keeps a connection out of the match set
 * entirely. The properties door is not covered:
 * `status` is an ordinary property a working credential can patch, which is the
 * remaining way to make a live grant read as revoked, tracked separately.
 */
export function liveConnectionRefusal(
  item: Pick<Item, "id" | "type" | "properties"> | null | undefined,
): string | undefined {
  if (item?.type !== "system.connection") return undefined;
  const props = item.properties as
    { status?: unknown; kind?: unknown } | undefined;
  if (props?.kind === "app") {
    if (props.status === "revoked") return undefined;
    return (
      `Grant ${item.id} is still live. Revoke it first with ` +
      `DELETE /auth/grants/${item.id} or POST /auth/grants/${item.id}/revoke, ` +
      `which drop the app's tokens and its stored consent. Removing the row ` +
      `here would leave both behind with nothing listing them.`
    );
  }
  // **`kind`, not just the type.** `system.connection` covers both kinds
  // and only `connector` has a credential minted for it. A row
  // with neither kind cannot be written through a validating door; if one
  // is here anyway, nothing knows what hangs off it, so it stays.
  if (props?.status === "revoked") return undefined;
  if (props?.kind !== "connector") {
    return (
      `Connection ${item.id} has no recognized kind and is not revoked; ` +
      `nothing knows what credentials hang off it, so it stays. A row in ` +
      `this shape was not written through a validating door and is an ` +
      `administrative repair, not a delete.`
    );
  }
  return (
    `Connection ${item.id} is still live. Revoke the credentials it holds ` +
    `and the grants it was given before removing the row, or they are left ` +
    `behind with nothing naming their owner.`
  );
}

/** Throw the refusal, for the doors that answer a single row. */
export function refuseUnlessUninstalled(
  item: Pick<Item, "id" | "type" | "properties"> | null | undefined,
): void {
  const reason = liveConnectionRefusal(item);
  if (reason) throw new MarfaError(ErrorCode.VALIDATION_ERROR, reason);
}
