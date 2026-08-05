import type { IntegrationManifest } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";

/**
 * Provenance keys on the integration and the space rather than the
 * Connection, so uninstall-then-reinstall lands on the items already
 * there: the natural-key pair (source, source_id) survives the
 * Connection id changing. Space scoping needs no encoding here — every
 * item row carries space_id and the natural-key lookup is space-bounded.
 *
 * A credential minted without a resolvable manifest gets no provenance
 * identity at all: it holds no type grants and can write no integration
 * items, and inventing a connection-keyed source for it would quietly
 * resurrect the corpus-forking shape this keying exists to end.
 */
export function runtimeCredentialItemSource(
  manifest: Pick<IntegrationManifest, "name"> | null | undefined,
): string | null {
  return manifest ? `integration:${manifest.name}` : null;
}

/**
 * Serialize every credential mint and terminal lifecycle change for one
 * Connection. Postgres uses a blocking advisory lock across instances;
 * SQLite queues callers in process. The callback must re-read Connection
 * state after acquiring the lock rather than relying on an earlier check.
 */
export function withConnectionLifecycleLock<T>(
  storage: Storage,
  connectionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.coordination.withExclusiveLock(
    `connection-lifecycle:${connectionId}`,
    fn,
  );
}
