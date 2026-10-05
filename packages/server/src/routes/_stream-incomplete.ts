/**
 * Why a stream stopped, as the `reason` of its terminal `stream_incomplete`.
 * One frame with a reason rather than a frame per cause: the client's
 * recovery is the same in every case, reconnect from the cursor it already
 * holds, so a client learns one frame and an operator still reads which
 * thing happened.
 *
 * Both streams and the published document read this list.
 */
export const STREAM_INCOMPLETE_REASONS = [
  /** The `Last-Event-ID` catch-up threw partway through. */
  "replay_failed",
  /** Live frames held during the prologue outgrew their cap, or a replay
   *  reached a row it cannot read whose live copy it had taken over from
   *  the hold. */
  "backlog_overflow",
  /** The subscription failed for a reason that was not the client leaving,
   *  or the credential could not be read again. */
  "live_delivery_failed",
  /** The credential no longer stands: revoked, deleted, past its expiry, or
   *  a sign-in's token revoked, expired or gone with its app's grant. A
   *  reconnect with it is refused `401`; a reconnect with the token an app
   *  refreshed to resumes. */
  "credential_ended",
  /** A live frame found the unsent-bytes bound reached, or the reader took
   *  no frame for the stall window while the replay or the opening's
   *  release waited for room. */
  "reader_behind",
  /** The instance is stopping. Everything after the cursor is still in
   *  the log, so the recovery is the same as for every other reason: connect
   *  again with it, to the instance once it is back. */
  "server_stopping",
] as const;

export type StreamIncompleteReason = (typeof STREAM_INCOMPLETE_REASONS)[number];
