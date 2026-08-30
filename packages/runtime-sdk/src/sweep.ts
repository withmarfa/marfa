/**
 * The driver that turns a page loop into a resumable sweep.
 *
 * `SweepResult` is the contract; this is the thing that makes adopting it
 * cheap. An author writes how to fetch and process one page, and this owns
 * the parts every integration was previously reinventing and mostly
 * getting wrong: polling the budget, freezing an upper bound, committing
 * a watermark, and deciding what may safely be carried into the next
 * slice.
 *
 * ## The vocabulary
 *
 * Four words, used precisely, because the whole design turns on the
 * difference between them:
 *
 * - **watermark** — how far a *finished* sweep got, in the provider's own
 *   domain key space: a timestamp, a monotonic id, a revision number.
 *   Durable, committed as the sweep runs, and the thing a fresh sweep
 *   starts from. Never an offset — "item 4,300" means nothing once the
 *   provider inserts something.
 * - **checkpoint** — where *this slice* stopped. Lives in the queue
 *   payload rather than in the cursor, so a redelivered slice is
 *   deterministic and so an unrelated dispatch running in the gap between
 *   slices cannot read it.
 * - **signpost** — the upper bound, frozen before the first page and held
 *   for the whole chain. An entry added mid-chain is next chain's problem.
 *   Without one a busy provider can feed a sweep for as long as it keeps
 *   writing, and the sweep never reaches an end it can report.
 * - **sweep id** — a correlation identity for one chain of slices. Handed
 *   to the author for idempotency keys, and compared by the runtime: a
 *   continuation whose id does not match what the connection now expects
 *   is a straggler from an abandoned chain and is discarded.
 *
 * ## The one default worth arguing about
 *
 * A provider page token is **not** carried across a slice boundary unless
 * the author opts in with `resumeAcrossSlices`.
 *
 * A token valid for hours and a token valid for five minutes have the same
 * type signature, and a slice boundary can be minutes wide. Carrying one
 * that has expired produces an error the author sees; carrying one the
 * provider silently reinterprets — as a fresh page, or as a page from a
 * shifted result set — produces a sweep that skips records and reports
 * success. The default therefore throws the token away and re-derives
 * position from the watermark, which costs a re-fetch of at most one page
 * and cannot skip. Opt in per integration, once, having actually read the
 * provider's documentation on token lifetime.
 *
 * **The precondition, which is not optional.** Re-deriving only works if
 * the watermark strictly advances as pages are processed. Against a
 * provider whose watermark is coarse — a date, or a timestamp many
 * records share — a slice can do real work and end where it began, and
 * the next slice then re-derives to the same place and does the same work
 * again. That is a genuine loop, and the chain guards will stop it, but
 * they will report a connection as failing when the fault is this default
 * meeting a key space it does not suit.
 *
 * So: if the watermark cannot separate two records, either make it
 * compound (timestamp plus a tiebreaking id) or set `resumeAcrossSlices`
 * and carry the provider's own token. Do not leave it on the default and
 * hope the pages line up.
 */
import type { ConnectionContext } from "./connection-context.js";
import type { Continuation, Json, SweepResult } from "./types.js";

/** What the driver hands an author for one page. */
export interface SweepPageInput<TResume extends Json> {
  /** Where this page starts. `undefined` on the first page of a chain,
   *  and on the first page of any slice that did not carry its position
   *  across — re-derive from `watermark` in that case. */
  resume: TResume | undefined;
  /** The frozen upper bound for this chain, if the sweep declared one. */
  signpost: string | undefined;
  /** How far the last finished sweep got. `undefined` on a first sync. */
  watermark: string | undefined;
  /** Correlation id for this chain. Stable across its slices — the right
   *  input to an idempotency key. */
  sweepId: string;
  /** Which slice this is, counting from 0 for the first. */
  slice: number;
}

/** What an author reports after processing one page. */
export interface SweepPageOutput<TResume extends Json> {
  /** Where the next page starts. Omit — or return `undefined` — to say
   *  the sweep has reached the end. That is the only thing that ends a
   *  sweep, so a loop that can never return `undefined` is a loop that
   *  runs until a guard stops it. */
  next?: TResume;
  /**
   * The highest position this page durably processed, in the provider's
   * domain key space.
   *
   * Reported per page rather than once at the end, because a sweep that
   * only reports at the end has nothing to commit when it parks and
   * restarts from the beginning every slice. Report it only for work that
   * is actually written — a watermark past a record that failed to write
   * strands it permanently.
   */
  watermark?: string;
  /** Records processed by this page. Progress, not a count of anything
   *  the runtime interprets — it is compared against the previous slice's
   *  to notice a chain that has stopped advancing. */
  processed?: number;
  /** Ask not to be resumed before this epoch-ms. The answer to a 429. */
  notBefore?: number;
}

export interface SweepSpec<TResume extends Json> {
  /** Cursor key the watermark and signpost live under. Usually `"main"`. */
  key: string;
  /** Fetch and process one page. */
  page: (input: SweepPageInput<TResume>) => Promise<SweepPageOutput<TResume>>;
  /**
   * Compute the upper bound, once, before the first page of a chain.
   * Omit for a provider with no meaningful bound.
   */
  signpost?: () => Promise<string> | string;
  /**
   * Carry the provider's page token across a slice boundary rather than
   * re-deriving from the watermark.
   *
   * Opt in where the provider documents a token lifetime comfortably
   * longer than a slice gap, **or where the watermark cannot strictly
   * advance per page** — a coarse timestamp many records share makes the
   * default re-derive to the same position forever. See the note at the
   * top of this file for both halves.
   */
  resumeAcrossSlices?: boolean;
  /**
   * Stop after this many pages within a single slice even if the budget
   * has not asked for a yield. A brake against a provider that returns a
   * next-token forever; the sweep parks and continues rather than
   * failing, so a wrong guess here costs an extra slice and nothing else.
   */
  maxPagesPerSlice?: number;
}

/** Persisted between chains under `<key>`. */
interface SweepState {
  watermark?: string;
  /** Present only while a chain is open. */
  signpost?: string;
  /** The chain this state belongs to; a continuation naming a different
   *  one is a straggler. Present only while a chain is open. */
  sweep_id?: string;
  /** The last chain to finish. Kept after `sweep_id` is cleared so a
   *  slice arriving late from a completed chain is still recognised. */
  last_sweep_id?: string;
}

const DEFAULT_MAX_PAGES_PER_SLICE = 500;

/**
 * Run one slice of a sweep and report whether it finished.
 *
 * Reads its inbound position from `message.continuation`, so it is driven
 * entirely by what the runtime hands it and holds no state of its own
 * between calls.
 */
export async function sweep<TResume extends Json>(
  ctx: ConnectionContext,
  message: { continuation?: { resume: Json; chain_id: string; slice: number } },
  spec: SweepSpec<TResume>,
): Promise<SweepResult> {
  const state = ((await ctx.cursor.read(spec.key)) as SweepState | null) ?? {};
  const inbound = message.continuation;

  // A continuation naming a chain this connection is no longer running is
  // discarded rather than honoured. It can happen: a chain is abandoned
  // when its guards trip, and a slice already on the queue arrives after.
  // Resuming it would append to a chain nothing is tracking and write a
  // watermark derived from a signpost that no longer exists.
  //
  // `last_sweep_id` is what makes this work after a chain has *finished*
  // as well as after one was abandoned. The completed path clears
  // `sweep_id`, so comparing against that alone would let a duplicate
  // slice arriving after completion reopen a chain nobody is tracking.
  const currentChain = state.sweep_id ?? state.last_sweep_id;
  if (
    inbound !== undefined &&
    currentChain !== undefined &&
    currentChain !== inbound.chain_id
  ) {
    return {
      ok: false,
      retry: false,
      reason: `stale_continuation: slice for chain ${inbound.chain_id} arrived while ${currentChain} is current`,
    };
  }

  // A message with no continuation is a fresh start, whatever the cursor
  // still holds. That matters because a chain can end without the cursor
  // being tidied: the runtime abandons one whose guards trip, and it does
  // so without touching handler state. The `sweep_id` and `signpost` of
  // the abandoned chain therefore survive, and inheriting them would run
  // the new sweep against a bound frozen before the last one started —
  // deferring everything the provider wrote in between by a whole further
  // chain, which reads as a sync that is running and is silently behind.
  const isFreshChain = inbound === undefined;
  const sweepId = inbound?.chain_id ?? newSweepId();
  const startingSlice = inbound?.slice ?? 0;

  // Frozen once per chain. Recomputing it per slice would let the bound
  // walk forward with the sweep, so a provider writing faster than the
  // sweep reads would never let it end.
  let signpost = isFreshChain ? undefined : state.signpost;
  if (signpost === undefined && spec.signpost !== undefined) {
    signpost = await spec.signpost();
  }

  let resume =
    inbound === undefined ? undefined : (inbound.resume as TResume | null);
  let watermark = state.watermark;
  let processed = 0;
  let notBefore: number | undefined;
  const maxPages = spec.maxPagesPerSlice ?? DEFAULT_MAX_PAGES_PER_SLICE;

  for (let page = 0; page < maxPages; page++) {
    const output = await spec.page({
      resume: resume ?? undefined,
      signpost,
      watermark,
      sweepId,
      slice: startingSlice,
    });
    processed += output.processed ?? 0;
    notBefore = output.notBefore ?? notBefore;

    // Written per page, before the yield check, so a slice that parks has
    // already recorded everything it wrote. This is the whole reason the
    // watermark is reported per page rather than at the end.
    //
    // "Recorded", not "durable": on the in-process substrate a cursor
    // write is journalled in the worker thread and applied when the
    // dispatch returns, so a thread that dies mid-run loses every page's
    // watermark rather than the last one's. Durable at call time on a
    // substrate that commits immediately.
    if (output.watermark !== undefined && output.watermark !== watermark) {
      watermark = output.watermark;
      await ctx.cursor.write(spec.key, {
        watermark,
        ...(signpost !== undefined && { signpost }),
        sweep_id: sweepId,
      } satisfies SweepState);
    }

    if (output.next === undefined) {
      // Finished. The signpost and the chain id are cleared so the next
      // cron tick starts a fresh chain from the watermark rather than
      // inheriting a bound that has since gone stale.
      await ctx.cursor.write(spec.key, {
        ...(watermark !== undefined && { watermark }),
        // Kept, so a duplicate slice from the chain that just finished is
        // still recognised as belonging to a chain that is over rather
        // than reopening one.
        last_sweep_id: sweepId,
      } satisfies SweepState);
      return { ok: true, done: true };
    }
    resume = output.next;

    // A page that asked not to be resumed before a given time has answered
    // a rate limit, and calling the provider again inside this slice is the
    // one response that cannot help. Breaking here rather than collecting
    // `notBefore` and acting on it only after the loop is the difference
    // between parking with the provider's own delay and spending the whole
    // page allowance against a provider that has already refused.
    //
    // The alternative an adopter is otherwise pushed towards is worse: a
    // re-entry guard inside `page()` that returns the same position without
    // touching the wire, whose obvious neighbour — returning `{}` on the
    // second call — is a sweep that stopped early and reported completion.
    if (output.notBefore !== undefined) break;

    if (ctx.budget.shouldYield) break;
  }

  // Out of budget or out of pages: park.
  //
  // `resume` is dropped unless the author opted in. A dropped position is
  // not lost work — the watermark is committed and the next slice
  // re-derives from it — whereas a stale token silently reinterpreted by
  // the provider is.
  const carried: Json =
    spec.resumeAcrossSlices === true ? (resume ?? null) : null;
  await ctx.cursor.write(spec.key, {
    ...(watermark !== undefined && { watermark }),
    ...(signpost !== undefined && { signpost }),
    sweep_id: sweepId,
  } satisfies SweepState);

  const continuation: Continuation = {
    // The runtime stamps this onto the next envelope's `chain_id`, so the
    // id this slice recorded in the cursor is the one the next slice
    // arrives carrying. Minted independently on both sides, the straggler
    // check above would reject every slice after the first.
    sweepId,
    resume: carried,
    progress: {
      processed,
      ...(watermark !== undefined && { watermark }),
    },
    ...(notBefore !== undefined && { notBefore }),
  };
  return { ok: true, done: false, continuation };
}

/**
 * Correlation id for one chain.
 *
 * `crypto.randomUUID` is Web Crypto rather than Node's, so it resolves on
 * every substrate this SDK targets — the same reason this package decodes
 * base64 by hand instead of reaching for `Buffer`.
 */
function newSweepId(): string {
  return `sweep_${crypto.randomUUID()}`;
}
