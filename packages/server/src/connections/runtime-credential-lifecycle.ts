/**
 * Shared lifecycle helpers for runtime credentials.
 *
 * The server owns manifest projection. A mint path can ask for a
 * credential, but it cannot choose that credential's reach. Missing or
 * invalid manifests fail closed to the two substrate grants supplied by the
 * permission builders.
 */
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { IntegrationManifest, Item } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
import { validateManifest } from "../integrations/validate-manifest.js";

interface ConnectionProperties {
  integration_ref?: string;
}

interface IntegrationProperties {
  manifest?: unknown;
  manifest_name?: unknown;
}

export async function resolveRuntimeCredentialManifest(
  storage: Storage,
  connection: Item,
): Promise<IntegrationManifest | undefined> {
  const integrationRef = (connection.properties as ConnectionProperties)
    .integration_ref;
  if (!integrationRef) return undefined;

  const spaceId = connection.space_id ?? undefined;
  const integration = await storage.items.get(integrationRef, spaceId, {
    includePlatformScoped: true,
  });
  if (integration?.type !== "system.integration") return undefined;

  const result = validateManifest(
    (integration.properties as IntegrationProperties).manifest,
  );
  return result.ok ? result.manifest : undefined;
}

/**
 * Refuse to mint a runtime credential whose reach would not be fenced
 * by a space.
 *
 * A credential with no `space_id` is not a narrow credential — it is
 * the platform tier. The per-request RLS wrapper skips a space-less
 * caller entirely, and the storage layer's space predicate widens from
 * an equality to no predicate at all, so the credential reads and
 * writes every space's rows. A Connection installed by a platform
 * admin without naming a space produces exactly that: an integration
 * built for one customer holding a key to all of them.
 *
 * **This used to be a hosted-mode rule and is now everyone's.** Keys mode
 * bound nothing to a space, so a space-less credential there was as scoped as
 * every other credential on the instance and refusing would have broken every
 * self-host. Keys mode now provisions one space at bootstrap and works through
 * a credential bound to it, so a connection with no space is a defect in both
 * modes rather than the norm in one — and the row constraint would refuse the
 * credential anyway, at the database, with nothing useful to say about why.
 *
 * A refused Connection becomes undispatchable rather than dangerous.
 * That is the intended trade: the failure is loud, it names the missing
 * space, and an operator fixes it by installing the Connection into a
 * space.
 */
export function assertMintableSpaceScope(connection: Item): void {
  if (connection.space_id) return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `Connection ${connection.id} has no space; a runtime credential minted for it would reach every space`,
    { connection_id: connection.id },
  );
}

/**
 * Revoke every other runtime credential on this connection.
 *
 * A mint means a dispatch is starting, and dispatches on one connection are
 * serialized: the supervisor takes `connection-dispatch:<id>` around the
 * whole dispatch and mints inside it. So a mint arriving is evidence that no
 * earlier dispatch on this connection is still holding its credential, and
 * every sibling can go.
 *
 * That serialization is why this revokes unconditionally now. It used to
 * revoke only *expired* siblings, on the reasoning that the bearer gate
 * already refuses those so revoking one cannot break a running dispatch.
 * The reasoning was sound and the bound it produced was not: nothing retired
 * a live credential on supersede, so three consecutive mints left three
 * usable credentials and accumulation was bounded only by the TTL. Measured
 * on staging, three mints left five.
 *
 * Failures stay best-effort. The retention reaper is the backstop, and a
 * cleanup failure must never discard the credential the caller is waiting
 * for.
 */
export async function revokeSupersededRuntimeCredentials(
  storage: Storage,
  connectionId: string,
  spaceId: string | undefined,
  mintedId: string,
): Promise<void> {
  try {
    const siblings = await storage.keys.listByConnectionId(
      connectionId,
      spaceId,
    );
    for (const key of siblings) {
      if (key.id === mintedId || !key.is_runtime_credential) continue;
      await storage.keys.revoke(key.id);
    }
  } catch (err) {
    log("error", "Runtime credential supersede revoke failed", {
      connection_id: connectionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
