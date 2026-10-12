import { MarfaError } from "@withmarfa/shared";

/**
 * The refusal the code chose, inside whatever is wrapping it, if there is one.
 *
 * A library between the throw and the catch re-wraps what it caught (Drizzle
 * wraps every statement's failure in an error whose `cause` is the original),
 * so the server's own class is looked for along the `cause` chain. Only
 * `MarfaError` counts: nothing is known about who built a wrapper, so a library
 * error that carries a `code` of its own is not a refusal the server chose.
 *
 * The walk is bounded, because a `cause` chain is data and a cycle in one
 * should not hang the caller. The error itself is not tested.
 */
export function refusalInCauses(err: unknown): MarfaError | undefined {
  for (let step: unknown = err, depth = 0; depth < 8; depth++) {
    if (step === null || typeof step !== "object") break;
    step = (step as { cause?: unknown }).cause;
    if (step instanceof MarfaError) return step;
  }
  return undefined;
}
