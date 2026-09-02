/**
 * Reserved extension namespaces, and the one predicate that decides
 * whether a write to a namespace is visible to a client at all.
 *
 * This lives outside both the routes and the storage layer because both
 * consult it. The route layer asks it whether to publish; the metadata
 * store asks it whether to move the item's modification time. Those are
 * two halves of one question, and answering them from two enumerations
 * is how the second one drifts.
 */

/** The `connection.runtime` namespace is reserved for the
 *  per-Connection runtime credential's hot state. Only runtime
 *  credentials (is_runtime_credential + connection_id
 *  stamped at mint) can write it; admin keys can read but not write so
 *  operators can inspect runtime state in the UI without corrupting
 *  it. */
export const RUNTIME_NAMESPACE = "connection.runtime";

/**
 * The reserved root `connection.runtime` sits under. Derived rather than
 * spelled again so the root cannot drift from the namespace it governs,
 * and so a sibling added under it (the inbound-delivery idempotency
 * window is one) is covered without a second list to remember.
 */
export const RUNTIME_NAMESPACE_ROOT = `${RUNTIME_NAMESPACE.split(".")[0] ?? ""}.`;

/**
 * Whether a write to this namespace is something a client can learn
 * about.
 *
 * Everything under the `connection.` root is per-Connection runtime
 * state — sync cursors, the recent error tail, the inbound idempotency
 * window — written by a runtime credential on the machine's behalf
 * rather than by a person. Two reasons it stays silent. The local
 * integrations runtime writes the identical blob straight through
 * storage, so emitting here would make the event depend on which
 * substrate happened to write it. And `metadata.changed` has no
 * namespace filter, so every subscription without a type filter would
 * receive cursors and error tails at dispatch frequency.
 *
 * Deliberately broader than the runtime write gate, which matches
 * `RUNTIME_NAMESPACE` exactly. Silence is the safe direction to be
 * broad in: the cost of not emitting for a sibling under this root is a
 * consumer polling, and the cost of emitting is the noise above.
 *
 * **Two callers, deliberately.** A subscriber hears about a write to
 * this namespace, and a client resuming an incremental catch-up finds
 * it, exactly when this returns true. Answering yes to one and no to
 * the other would make a namespace silent on the stream and loud on
 * catch-up, or the reverse — either way a client's two views of the
 * same item disagree.
 */
export function announcesMetadataChange(namespace: string): boolean {
  return !namespace.startsWith(RUNTIME_NAMESPACE_ROOT);
}
