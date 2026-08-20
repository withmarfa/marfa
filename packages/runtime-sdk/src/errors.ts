/**
 * Runtime-SDK error types that carry a decision, not just a message.
 *
 * The queue consumer branches on error identity rather than on parsed
 * error strings — a substrate that reports failures differently only has
 * to throw the right class.
 */

/**
 * The Connection this message belongs to can no longer run: the mint
 * path reports it missing, or present but no longer active.
 *
 * Terminal by definition. Retrying cannot fix it, and any self-renewing
 * work bound to the Connection (its schedule) needs tearing down rather
 * than backing off. The server's supervisor has its own not-found and
 * inactive handling; today this class is thrown only inside the
 * queue-consumer harness path, kept for the same structural-parity
 * reason as `consumeBatch` itself.
 */
export class ConnectionGoneError extends Error {
  constructor(
    message: string,
    /** Status the mint path reported (404 gone, 403 inactive). */
    public readonly status: number,
  ) {
    super(message);
    this.name = "ConnectionGoneError";
  }
}
