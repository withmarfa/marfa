/**
 * The label a key may claim an extension namespace with — or nothing.
 *
 * `resolveExtensionPermission` grants write when a namespace equals the key's
 * label, on the reading that a key writes its own namespace. **The condition
 * that reading actually needs is that whoever chose the label was trusted with
 * that namespace, which is not the same as their having chosen it.** A signed-in
 * app chooses its own: one minting a key called `com.othervendor.sync` would
 * hold that vendor's extension data on every item in the space, from a grant
 * that named no extension anything, durably and after the app was revoked.
 *
 * The same gap exists one step away and is inert today rather than closed: the
 * self-serve key page lets a signed-in person name a label freely, and that key
 * is not scope-enforced. It bites the day a space can hold more than one
 * person at different ranks.
 *
 * **`label` is read as identity, exactly like `source`.** `source` already has
 * that recorded — `oauth:<connection-id>` is proof a caller *is* a connection,
 * and the mint doors carry a forged-source axis because of it. This is the
 * same shape one field over, and it is the reason this lives in one place
 * rather than at each call site: the previous attempt patched three of six.
 *
 * The empty string is the "matches nothing" value, and what makes that safe is
 * checked rather than assumed. A namespace arrives either as a path segment,
 * which a route pattern will not match empty, or as a key of a stored
 * extensions object. Every write door takes it from the first, so no ordinary
 * path can store an empty one — but an archive restore copies the keys it is
 * given, so a crafted line could have. `archiveExtensions` drops it, which is
 * what keeps this value unforgeable rather than merely unreached.
 */
export function extensionLabelOf(
  key: { label?: string; scope_enforced?: boolean } | undefined,
): string {
  if (!key || key.scope_enforced === true) return "";
  return key.label ?? "";
}
