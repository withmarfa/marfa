/**
 * The contract version: one integer the root answers as `contract` and the
 * document carries as `info.version`, which a generated client checks before
 * it trusts an answer. It is not the build: the root's `version` is.
 *
 * **It moves when a client generated for the old number cannot read the new
 * answers**: a path, a method, an operation, a field, an enum member, a status
 * or a refusal code removed or reshaped, including one the document never
 * declared, because a body the document leaves open is still a shape a
 * caller reads. An addition does not move it. One change moves it by one,
 * however many breaks it carries.
 *
 * The number is guarded; the decision to move it is not. The root and the
 * document read this one constant, and the committed document is compared to
 * the source, so the two cannot drift apart. Whether it moved when the wire
 * did is a judgment, stated here so it is applied without one.
 */
export const CONTRACT_VERSION = 1;
