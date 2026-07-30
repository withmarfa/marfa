/**
 * Per-Worker identity keys for the hosted integrations substrate.
 *
 * The control plane holds one platform credential that can mint a
 * runtime credential for any Connection in any space. Handing that
 * value to the integration Workers so they can authenticate to the
 * lease broker makes every Worker a platform principal: any one of them
 * can present it to the Marfa server directly and mint against a
 * Connection belonging to a different integration, a different space,
 * or a different customer. One shared secret across a fleet is one
 * identity across a fleet.
 *
 * Instead each Worker gets its own key, derived from a root secret the
 * control plane alone holds:
 *
 *     identity_key = HMAC-SHA256(root_secret, integration_name)
 *
 * Derivation rather than thirteen independently generated secrets is
 * what keeps the control plane's provisioning at one value. It also
 * means adding an integration needs no control-plane change: the key
 * for a name that did not exist yesterday is computable today.
 *
 * The properties that matter:
 *
 *   - **The root never leaves the control plane.** A Worker holds only
 *     its own derived key. HMAC is one-way, so holding a derived key
 *     does not let a Worker compute a sibling's.
 *   - **The key names the integration.** Presenting a key that derives
 *     from `google.calendar` is a claim to be that integration, and the
 *     control plane forwards that authenticated name to the server,
 *     which checks it against the Connection's persisted manifest. A
 *     Worker asking for a Connection it does not own is refused by an
 *     authority that trusts neither of them.
 *   - **Rotation is per-fleet or per-Worker.** Rotating the root
 *     invalidates every derived key at once; rotating one Worker means
 *     re-deriving and re-setting that Worker's secret alone.
 *
 * Web Crypto only, so the same function runs in a Workers isolate, in
 * Node, and in a browser. `openssl dgst -sha256 -hmac <root>` over the
 * same bytes produces the same hex, which is what lets the provisioning
 * script derive a key without running this package.
 *
 * For npm consumers of `@withmarfa/shared` this is implementation
 * detail of the hosted runtime substrate.
 */

const ENCODER = new TextEncoder();

/**
 * Derive an integration Worker's identity key from the control plane's
 * root secret.
 *
 * Returns lowercase hex. The encoding is part of the contract: the
 * value is written into a Worker secret by a shell script and compared
 * as a bearer token, so both ends have to agree on the exact string,
 * not merely on the underlying bytes.
 *
 * Throws on an empty root or an empty name rather than deriving from
 * one. An empty root is a control plane missing its secret, and
 * `HMAC("", name)` is a perfectly valid tag that every equally
 * misconfigured deployment would compute identically — a fleet-wide
 * shared secret reintroduced by accident, and one an attacker can
 * compute too. The same argument applies to an empty name, which would
 * hand every unnamed caller the same key.
 */
export async function deriveWorkerIdentityKey(
  rootSecret: string,
  integrationName: string,
): Promise<string> {
  if (!rootSecret) {
    throw new Error(
      "Worker identity derivation requires a non-empty root secret",
    );
  }
  if (!integrationName) {
    throw new Error(
      "Worker identity derivation requires a non-empty integration name",
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(rootSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const tag = await crypto.subtle.sign(
    "HMAC",
    key,
    ENCODER.encode(integrationName),
  );
  return toHex(new Uint8Array(tag));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Header an integration Worker uses to say which integration it is.
 *
 * The name is not a credential and is not trusted on its own: it
 * selects which derived key the control plane compares the presented
 * bearer against. A caller claiming a name it cannot prove fails that
 * comparison, so the header can only ever narrow what a caller is
 * allowed to be, never widen it.
 */
export const INTEGRATION_NAME_HEADER = "x-marfa-integration";
