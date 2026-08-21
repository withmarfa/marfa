/**
 * The upstream credential a connection was installed with — the API token
 * or OAuth token a person handed Marfa so an integration could reach the
 * outside service. It hangs off `system.connection.properties.credential_ref`
 * as a plain id; there is no edge and no back-index.
 *
 * It is deliberately not the same thing as a runtime credential, and
 * conflating the two is what made an uninstall look complete when it was
 * not. A runtime credential is Marfa's own, minted per connection with a
 * short TTL and revoked on every subsequent mint. The upstream credential
 * is the user's secret: nothing in the platform will ever recreate it, and
 * removing it here does not invalidate it at the far end.
 *
 * **One credential can serve several connections by design** — the four
 * Google integrations share a single row — so removing one is only safe
 * once nothing live still points at it. That check is the whole reason
 * this module exists rather than each caller filtering connections itself:
 * `DELETE /credentials/{id}` and the uninstall pipeline were making the
 * same judgment separately, and only one of them was making it at all.
 */
import type { Item } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";

/** Page size for the dependent scan. The scan is a full walk, so this is
 *  a round-trip/memory trade-off rather than a ceiling on the answer. */
const DEPENDENT_SCAN_PAGE = 200;

/**
 * Every non-revoked connection still pointing at `credentialId`.
 *
 * `excludeConnectionId` drops the connection the caller is currently
 * uninstalling, so the answer does not depend on whether the caller has
 * already flipped that row to `revoked`. Without it this is only correct
 * when called after the revoke, which is the kind of ordering coupling
 * that survives exactly until somebody moves a step.
 *
 * Walks the cursor rather than taking one page. The previous inline
 * version of this check stopped at 200 connections, which does not fail
 * loudly — it silently reports no dependents and lets a live credential
 * be purged out from under connection 201.
 */
export async function findLiveCredentialDependents(
  storage: Storage,
  credentialId: string,
  options: { excludeConnectionId?: string; spaceId?: string } = {},
): Promise<string[]> {
  const dependents: string[] = [];
  let cursor: string | null = null;

  do {
    const page: { data: Item[]; cursor: string | null } =
      await storage.items.list({
        spaceId: options.spaceId,
        type: "system.connection",
        limit: DEPENDENT_SCAN_PAGE,
        ...(cursor ? { cursor } : {}),
      });

    for (const connection of page.data) {
      if (connection.id === options.excludeConnectionId) continue;
      if (connection.state === "revoked") continue;
      const ref = (
        connection.properties as { credential_ref?: unknown } | undefined
      )?.credential_ref;
      if (ref === credentialId) dependents.push(connection.id);
    }

    cursor = page.cursor;
  } while (cursor);

  return dependents;
}

/**
 * Remove a stored credential and its edges.
 *
 * `system.*` types soft-delete to `revoked` and purge gates on the
 * soft-deleted state, so removal is those two steps in that order.
 */
export async function purgeCredential(
  storage: Storage,
  credential: Item,
  spaceId?: string,
): Promise<void> {
  if (credential.state !== "revoked") {
    await storage.items.transition(credential.id, "revoked", spaceId);
  }
  await storage.edges.deleteBySource(credential.id, undefined, spaceId);
  await storage.edges.deleteByTarget(credential.id, undefined, spaceId);
  await storage.items.purge(credential.id, spaceId);
}

/** What an uninstall did about the connection's upstream credential.
 *
 *  Every outcome is named, including the ones where nothing happened, so
 *  the audit row can say which it was. A field that is absent when the
 *  work was skipped reads identically to one that is absent because there
 *  was no work — and that ambiguity is the defect this reporting exists
 *  to close. */
export type UpstreamCredentialOutcome =
  /** The connection carried no `credential_ref`. Nothing to remove. */
  | { status: "none" }
  /** `credential_ref` pointed at something that is no longer there. */
  | { status: "already_gone"; credential_id: string }
  /** Removed. The secret is out of the database. */
  | { status: "purged"; credential_id: string }
  /** Deliberately kept, because other live connections still use it. */
  | {
      status: "retained";
      credential_id: string;
      reason: "in_use_by_other_connections";
      connection_ids: string[];
    };

/**
 * Purge the connection's upstream credential, or say why it was kept.
 *
 * Never throws on the retained path: an uninstall that fails because a
 * *sibling* connection shares a token would leave the caller unable to
 * remove the thing they asked to remove, which is worse than keeping a
 * secret whose other user is still live and still entitled to it.
 */
export async function releaseUpstreamCredential(
  storage: Storage,
  connection: Item,
  spaceId?: string,
): Promise<UpstreamCredentialOutcome> {
  const credentialId = (
    connection.properties as { credential_ref?: unknown } | undefined
  )?.credential_ref;
  if (typeof credentialId !== "string" || credentialId.length === 0) {
    return { status: "none" };
  }

  const credential = await storage.items.get(credentialId, spaceId);
  if (credential?.type !== "system.credential") {
    return { status: "already_gone", credential_id: credentialId };
  }

  const dependents = await findLiveCredentialDependents(storage, credentialId, {
    excludeConnectionId: connection.id,
    spaceId,
  });
  if (dependents.length > 0) {
    return {
      status: "retained",
      credential_id: credentialId,
      reason: "in_use_by_other_connections",
      connection_ids: dependents,
    };
  }

  await purgeCredential(storage, credential, spaceId);
  return { status: "purged", credential_id: credentialId };
}
