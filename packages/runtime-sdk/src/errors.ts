/**
 * Runtime-SDK error types that carry a decision, not just a message.
 *
 * The queue consumer branches on error identity rather than on parsed
 * error strings — a substrate that reports failures differently only has
 * to throw the right class.
 */

/**
 * The Connection this message belongs to can no longer run: the lease
 * broker reports it missing, or present but no longer active.
 *
 * Terminal by definition. Retrying cannot fix it, and any self-renewing
 * work bound to the Connection (the per-Connection schedule alarm) needs
 * tearing down rather than backing off.
 */
export class ConnectionGoneError extends Error {
  constructor(
    message: string,
    /** Status the lease broker reported (404 gone, 403 inactive). */
    public readonly status: number,
  ) {
    super(message);
    this.name = "ConnectionGoneError";
  }
}
