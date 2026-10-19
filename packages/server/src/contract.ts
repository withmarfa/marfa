/**
 * The contract version: one integer the root answers as `contract`, every
 * response carries as `X-Marfa-Contract`, and the document carries as
 * `info.version`, so a generated client can check it on whatever answer
 * arrives before it trusts that answer. It is not the build: the root's
 * `version` is.
 *
 * **It stays at 0 until the first public release**, whatever the wire does
 * before then: nothing built on Marfa is live, so no number protects a
 * caller yet.
 *
 * The root, the header and the document read this one constant, and the
 * committed document is compared to the source, so none of them can drift
 * from the others.
 */
export const CONTRACT_VERSION = 0;

let served: number = CONTRACT_VERSION;

/**
 * The contract version this process speaks: the build's, unless a server
 * started with the test hooks was told to speak another, so a harness can
 * show how the server behaves once its contract has changed.
 */
export function servedContractVersion(): number {
  return served;
}

/**
 * Sets the version this process speaks. Called once at boot, before the app
 * is made, and only from a setting that is refused unless the test hooks are
 * on. `undefined` leaves the build's version.
 */
export function setServedContractVersion(version: number | undefined): void {
  served = version ?? CONTRACT_VERSION;
}

/**
 * The response header that carries the contract version. On every answer
 * the application gives, so a client checks the answer it is about to read
 * against the contract it was generated for.
 */
export const CONTRACT_HEADER = "X-Marfa-Contract";
