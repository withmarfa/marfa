/**
 * The label a key may claim an extension namespace with — or nothing.
 *
 * `resolveExtensionPermission` grants write when a namespace equals the key's
 * label, on the reading that a key writes its own namespace. That reading
 * holds while labels are assigned by whoever mints the key. It stops holding
 * for a key minted through a signed-in app, which chooses its own label: an
 * app minting one called `com.othervendor.sync` would hold that vendor's
 * extension data on every item in the space, from a grant that named no
 * extension anything, durably and after the app was revoked.
 *
 * **`label` is read as identity, exactly like `source`.** `source` already has
 * that recorded — `oauth:<connection-id>` is proof a caller *is* a connection,
 * and the mint doors carry a forged-source axis because of it. This is the
 * same shape one field over, and it is the reason this lives in one place
 * rather than at each call site: the previous attempt patched three of six.
 *
 * The empty string is the "matches nothing" value. Safe rather than merely
 * convenient: a namespace arrives either as a path segment, which a route
 * pattern will not match empty, or as a key of a stored extensions object,
 * which the write doors will not create empty.
 */
export function extensionLabelOf(
  key: { label?: string; scope_enforced?: boolean } | undefined,
): string {
  if (!key || key.scope_enforced === true) return "";
  return key.label ?? "";
}
