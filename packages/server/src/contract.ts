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

/**
 * The response header that carries the contract version. On every answer
 * the application gives, so a client checks the answer it is about to read
 * against the contract it was generated for.
 */
export const CONTRACT_HEADER = "X-Marfa-Contract";
