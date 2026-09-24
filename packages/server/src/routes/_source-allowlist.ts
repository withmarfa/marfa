import { ErrorCode, MarfaError, getSourceAllowlist } from "@withmarfa/shared";
import type { EnforcementSettings } from "@withmarfa/shared";

/**
 * The source allow-list, as the create doors ask it: `POST /items`, and each
 * entry of `POST /items/bulk`.
 *
 * **Asked of the source the write resolves to**, the credential's own or one
 * its key claims and the write names, because that is the source the row
 * would carry. Asking it of the credential alone would let a claim carry a
 * write past a list that excludes the claimed source.
 *
 * **One reading, so the two doors cannot drift.** The bulk door is the one
 * built for volume, and a lever it did not ask would be a lever a caller
 * steps around by batching.
 *
 * Returns the refusal rather than throwing it, because the single create
 * throws into the error handler and the bulk door reports it as that entry's
 * `errored` outcome.
 */
export function sourceAllowlistRefusal(
  enforcement: EnforcementSettings,
  type: string,
  source: string | undefined,
): MarfaError | null {
  const allowed = getSourceAllowlist(enforcement, type);
  if (allowed === null) return null;
  if (source !== undefined && allowed.includes(source)) return null;
  return new MarfaError(
    ErrorCode.FORBIDDEN,
    `Source "${source ?? "(unknown)"}" is not in the allow-list for type ${type}`,
    { type, source, allowed },
  );
}
