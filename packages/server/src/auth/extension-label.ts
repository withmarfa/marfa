/**
 * The label a key may claim an extension namespace with — or nothing.
 *
 * `resolveExtensionPermission` grants write when a namespace equals the key's
 * label, on the reading that a key writes its own namespace. **The condition
 * that reading actually needs is that whoever chose the label was trusted with
 * that namespace, which is not the same as their having chosen it.** A signed-in
 * app chooses its own: one minting a key called `com.othervendor.sync` would
 * hold that vendor's extension data on every item stored, from a grant
 * that named no extension anything, durably and after the app was revoked.
 *
 * The test is whether an app chose the label, which `oauth_client_id` answers
 * for both shapes that carry one: a signed-in app acting through its own grant,
 * and a key that app minted, which outlives the grant and would otherwise keep
 * the claim after the app was revoked.
 *
 * `oauth_client_id` is stamped by the server at mint and is settable from no
 * request, so it is the fact itself rather than a stand-in for it. That
 * matters in one direction: a test that stops discriminating goes quietly true
 * for every credential, which is the direction that hands out a namespace
 * rather than withholding one.
 *
 * The same gap exists one step away and is inert: the self-serve key page lets
 * a signed-in person name a label freely. One instance has one owner and that
 * owner holds everything, so there is no one for them to escalate against; it
 * bites the day an instance can hold more than one person.
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
  key: { label?: string; oauth_client_id?: string } | undefined,
): string {
  if (!key || key.oauth_client_id !== undefined) return "";
  return key.label ?? "";
}
