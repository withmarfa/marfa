import type { PgClient } from "./connection.js";

type Reserved = Awaited<ReturnType<PgClient["reserve"]>>;

/**
 * How long the first ask is given before the second one starts.
 *
 * Short on purpose. A reservation lost to the race below is never granted,
 * so waiting the caller's whole budget on it buys nothing: the wait is pure
 * loss and the second ask succeeds in about fifteen milliseconds. What the
 * probe has to be long enough for is an ordinary busy moment, where the
 * first ask is simply queued behind live work and will be served.
 *
 * Capped at half the caller's budget so both asks happen at every budget
 * rather than only at generous ones. The tightest caller here allows two
 * seconds, so in practice this is the quarter-second and the second ask
 * takes what is left.
 */
const FIRST_ASK_MS = 250;

export interface ReserveOutcome {
  /** The reserved connection, or `null` if no attempt was served. */
  connection: Reserved | null;
  /** How long the caller actually waited, across every attempt. */
  waitedMs: number;
  /** How many attempts were made. Above one means the first was lost. */
  attempts: number;
}

/**
 * Reserve a connection from `client` within `timeoutMs`, asking twice.
 *
 * **A reservation can be destroyed rather than queued.** In postgres.js
 * 3.4.9, a connection closing for any reason moves to `closed` and then
 * hands the head of its query queue to its own reconnect, as that
 * connection's initial query. When the fresh connection reaches
 * `ReadyForQuery` and still needs to fetch array types, it drops that
 * initial query on the floor if it is a reservation
 * (`initial.reserve && (initial = null)`). The caller's promise is neither
 * resolved nor rejected: it stays pending for the life of the process.
 *
 * Measured against a two-slot pool with no other caller: the reservation is
 * never granted, and a fresh ask is served in around fifteen milliseconds
 * at the same instant. The victim is whichever reservation is at the head
 * of the queue when the close lands, which need not be the one that raced
 * it.
 *
 * **This is not specific to an idle timer**, though that is the common way
 * to meet it: reserving on the same period as `idle_timeout` means arriving
 * on a close every time. A recycled connection, a database restart, a
 * pooler bounce or a compute resume closes connections too, and each does
 * the same thing to whatever is queued.
 *
 * So the first ask gets a short probe and the second gets the rest of the
 * budget. **The total is the caller's budget, unchanged**, which matters:
 * three of the callers here sit on a request path and one of them is a
 * destructive admin cascade whose client gives up at thirty seconds.
 *
 * A pool with genuinely nothing to give still times out, which is the state
 * the bound exists for: a background tick should skip and a stream request
 * should answer 503 rather than joining a pileup.
 *
 * The proper fix is upstream, in that queue bookkeeping. Until it lands,
 * asking again is the cheapest thing that turns a permanent loss into a
 * quarter-second one.
 */
export async function reserveWithTimeout(
  client: PgClient,
  timeoutMs: number,
): Promise<ReserveOutcome> {
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);

  const probeMs = Math.min(FIRST_ASK_MS, Math.floor(timeoutMs / 2));
  const first = await reserveOnce(client, probeMs);
  if (first !== null) {
    return { connection: first, waitedMs: elapsed(), attempts: 1 };
  }

  const second = await reserveOnce(client, Math.max(1, timeoutMs - elapsed()));
  return { connection: second, waitedMs: elapsed(), attempts: 2 };
}

/**
 * The rejections that mean this connection is going away rather than that
 * the database refused us.
 *
 * Only these are swallowed. The narrow case worth absorbing is a
 * reservation caught by a shutdown, which turns into an exception from a
 * layer the caller has no answer for; everything else is a real failure
 * the caller has to see. Swallowing all of them made `ECONNREFUSED`, a
 * rejected credential and the server's own connection ceiling arrive as
 * "no capacity right now", with the cause logged nowhere. The last of
 * those is the one this pool is capped at five to avoid.
 */
const LIFECYCLE_REJECTIONS = new Set([
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECTION_CLOSED",
]);

function isLifecycleRejection(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof err.code === "string" &&
    LIFECYCLE_REJECTIONS.has(err.code)
  );
}

/**
 * One ask, bounded. Returns `null` on timeout and on a rejection that says
 * the connection is closing; anything else is rethrown.
 *
 * An abandoned reservation is left with a handler that releases it if it is
 * ever granted. In the race above it never is, which costs a closure and
 * nothing else; behind a genuinely full pool it is granted the moment a
 * slot frees, and without this it would be held by nobody.
 */
async function reserveOnce(
  client: PgClient,
  timeoutMs: number,
): Promise<Reserved | null> {
  const reservation = client.reserve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
  });
  try {
    const winner = await Promise.race([
      reservation.catch((err: unknown) => {
        if (isLifecycleRejection(err)) return null;
        throw err;
      }),
      timeout,
    ]);
    if (winner !== null) return winner;
    reservation
      .then((late) => {
        late.release();
      })
      .catch(() => {
        // Rejected before the queued reservation was granted, or the pool
        // was ended with a bounded timeout, which rejects what is queued.
        // Either way there is nothing to release.
      });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
