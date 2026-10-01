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
 * revoked grant row but the strand itself, tokens live and invisible to both read
 * surfaces, and it is refused like any other live grant: purging it would
 * make the strand permanent, since nothing could ever run the cascade for
 * it again. Anything that is not literally `"revoked"` counts as live, so an
 * unknown or missing status fails closed.
 *
 * **Two call sites, and they are the two doors that reach a connection at
 * all.** The delete cascade asks it of every row the walk reaches, the root
 * included, which is the only way a credential addresses a connection: the
 * type gate on `DELETE /items/{id}` refuses a `system.connection` write to
 * everything the product mints, and it ran against the named row alone. The
 * purge door asks it directly, because it reads the row before it asks the
 * write question.
 *
 * The transition door and the two bulk doors do not ask it, because none of
 * them can reach a connection: the transition route sits behind the same type
 * gate and behind a lifecycle table that admits only `revoked` for a
 * `system.*` type, which its schema cannot name, and the bulk door's
 * reserved-namespace narrowing keeps a connection out of the match set
 * entirely. `PATCH /items/{id}` sits behind the same type gate, so no
 * credential writes `status` to make a live grant read as revoked either.
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
  // A row of any other kind cannot be written through a validating door; if
  // one is here anyway, nothing knows what hangs off it, so it stays.
  if (props?.status === "revoked") return undefined;
  return (
    `Connection ${item.id} has no recognized kind and is not revoked; ` +
    `nothing knows what credentials hang off it, so it stays. A row in ` +
    `this shape was not written through a validating door and is an ` +
    `administrative repair, not a delete.`
  );
}

/** Throw the refusal, for the doors that answer a single row. */
export function refuseUnlessUninstalled(
  item: Pick<Item, "id" | "type" | "properties"> | null | undefined,
  readable = true,
): void {
  const reason = liveConnectionRefusal(item);
  if (!reason) return;
  // The reason names the row and its kind, which a caller that cannot read it
  // learns nothing of: only that something the delete would take is kept.
  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    readable
      ? reason
      : "A row this delete would take with it cannot be removed here, so nothing was removed.",
  );
}
