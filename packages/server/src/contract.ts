/**
 * The contract version: one integer the root answers as `contract`, every
 * response carries as `X-Marfa-Contract`, and the document carries as
 * `info.version`, so a generated client can check it on whatever answer
 * arrives before it trusts that answer. It is not the build: the root's
 * `version` is.
 *
 * **It moves when a client generated for the old number cannot read the new
 * answers**: a path, a method, an operation, a field, an enum member, a status
 * or a refusal code removed or reshaped, including one the document never
 * declared, because a body the document leaves open is still a shape a
 * caller reads. A member added to an enum a response carries moves it too,
 * a refusal code included, because a generated client decodes that enum as
 * closed and fails on a value it was not generated with. Any other addition
 * does not move it. One change moves it by one, however many breaks it
 * carries.
 *
 * The number is guarded; the decision to move it is not. The root, the
 * header and the document read this one constant, and the committed
 * document is compared to the source, so none of them can drift from the
 * others. Whether it moved when the wire did is a judgment, stated here so
 * it is applied without one.
 */
export const CONTRACT_VERSION = 2;

/**
 * The response header that carries the contract version. On every answer
 * the application gives, so a client checks the answer it is about to read
 * against the contract it was generated for.
 */
export const CONTRACT_HEADER = "X-Marfa-Contract";
