/**
 * The contract version a document states, or a refusal. Digits with no
 * leading zero: `1.0` or `01` would read as 1 and hide a document that no
 * longer states the contract the way the root answers it.
 */
export function contractVersionOf(infoVersion: string): number {
  if (!/^[1-9][0-9]*$/.test(infoVersion)) {
    throw new Error(
      `openapi.json's info.version is "${infoVersion}", not a contract version`,
    );
  }
  return Number(infoVersion);
}
