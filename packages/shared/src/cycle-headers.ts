/**
 * The header names that carry cycle metadata from an integration's reaction
 * back to the Marfa server.
 *
 * Declared here because both ends of the exchange need them and neither end
 * can own them. The server's cycle middleware reads these headers; the
 * runtime kit's `ConnectionClient` stamps them. Both previously held their
 * own copy, and both docblocks claimed to be the one place they were kept —
 * which is how two copies of a two-line constant survive review.
 *
 * **One declaration closes the drift inside this repository and does not
 * close the skew across the split.** An integration pinned to an older
 * runtime kit holds whatever names that kit was built with, so a rename
 * here reaches the server immediately and reaches that integration only
 * when it upgrades. The crossing test in the server's cycle middleware
 * suite is what catches a rename; this constant is what stops the two ends
 * disagreeing by accident in the meantime.
 *
 * So renaming one of these is a breaking change to the runtime contract and
 * wants a major on the kit, not a quiet edit.
 */
export const CYCLE_HEADERS = {
  ORIGIN: "X-Marfa-Cycle-Origin",
  HOP: "X-Marfa-Cycle-Hop",
} as const;
