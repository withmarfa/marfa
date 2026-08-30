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
 *
 * ## Two durabilities, and you have to say which you want
 *
 * A checkpoint in the queue payload survives a process death. It does not
 * survive a chain the queue never delivers: when the runtime abandons a
 * chain, the position goes with the payload. Recovery is by watermark, so
 * for a provider with a usable domain key that costs at most a re-walk of
 * the tail.
 *
 * **A watermark is not always a position.** Where the key space is coarse,
 * unordered or absent, "start fresh from the watermark" means walking the
 * whole thing again. `resumeAcrossChains` mirrors the position into this
 * sweep's own cursor key as well, so a chain lost between slices resumes
 * where it stopped rather than where it started.
 *
 * It implies `resumeAcrossSlices` and carries that flag's precondition
 * twice over: a position durable enough to survive a chain gap — which
 * can be a whole scheduling interval rather than minutes — is a domain
 * key or an index, not a provider page token. Do not set it on a token.
 *
 * ## The key is this sweep's own
 *
 * Every exit writes the whole value at `spec.key`, and a cursor write
 * replaces rather than merges. A key an integration already stores
 * anything else under therefore loses that on the sweep's first page, so
 * the driver refuses one rather than discovering it in production.
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

/**
 * Fields any page reports whatever became of it.
 *
 * A failed page may still have written some of what it read, so both
 * halves are available on every arm rather than only on the happy one.
 */
interface SweepPageProgress {
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
}

/** There is more to fetch. */
export interface SweepPageContinue<
  TResume extends Json,
> extends SweepPageProgress {
  outcome: "continue";
  /** Where the next page starts. */
  next: TResume;
  /**
   * Ask not to be resumed before this epoch-ms. The answer to a 429.
   *
   * Reporting it ends the slice: the page loop stops where the refusal
   * was reported rather than calling the page again, so no re-entry guard
   * of your own is needed to stop the loop running on.
   */
  notBefore?: number;
}

/** The sweep reached the end. */
export interface SweepPageDone extends SweepPageProgress {
  outcome: "done";
}

/**
 * The page could not be fetched or processed.
 *
 * This arm exists because its absence made the obvious code wrong. When
 * omitting a field was the only exit, an author whose page met a 500 and
 * reached for it shipped a run that stopped early and reported success —
 * which is the failure this whole contract exists to end. A page that
 * fails now cannot be spelled the same way as a page that finished.
 */
export interface SweepPageFailed extends SweepPageProgress {
  outcome: "failed";
  /** What an operator is told. */
  reason: string;
  /** Whether another attempt could succeed. A 500 or a timeout is true;
   *  a malformed document or a rejected credential is not. */
  retry: boolean;
  /** Where the failure was a rate limit rather than an error. */
  notBefore?: number;
}

/** What an author reports after processing one page. */
export type SweepPageOutput<TResume extends Json> =
  SweepPageContinue<TResume> | SweepPageDone | SweepPageFailed;

export interface SweepSpec<TResume extends Json> {
  /**
   * A cursor key belonging to this sweep and nothing else.
   *
   * Every exit writes the whole value here, and a cursor write replaces
   * rather than merges, so a key the integration already stores anything
   * else under loses it on the sweep's first page. The driver refuses such
   * a key rather than discovering the loss in production. `"sweep"`
   * alongside your own `"main"` is the convention.
   */
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
  /**
   * Also mirror the position into this sweep's cursor key, so it survives
   * a chain the queue never delivers rather than only a process death.
   *
   * Implies `resumeAcrossSlices`, and carries that flag's precondition
   * twice over: a chain gap can be a whole scheduling interval. Set it for
   * a domain key or an index, never for a provider page token.
   */
  resumeAcrossChains?: boolean;
  /**
   * Bound the chain by the slice and wall-clock ceilings alone, because
   * nothing this sweep can report advances.
   *
   * The runtime otherwise abandons a chain whose two consecutive slices
   * report the same position, comparing processed count against watermark
   * and carried position. A sweep with a fixed per-slice cap, no domain
   * key and no carried position reports the same triple every slice and is
   * abandoned on its second — which made a watermark mandatory in practice
   * while the type presented it as optional.
   *
   * Declaring this is the honest answer for such a provider. The
   * alternative an author is otherwise pushed towards is reporting an
   * invented watermark purely to keep the comparison moving, which defeats
   * the guard silently rather than saying so.
   */
  stallGuard?: "ceilings";
  /**
   * The provider serves this source as one whole document rather than as
   * pages, so a park inside it costs a re-fetch of the entire thing.
   *
   * Parking is cheap when the next slice can ask for the next page. It is
   * not cheap when the unit is a document: the slice that resumes must
   * pull the whole thing again, and a conditional request cannot help,
   * because a `304` returns no body and a resumed drain has nothing to
   * continue into.
   *
   * Declaring it does not change where the driver parks — the budget still
   * decides that, and a driver that ran on because a page asked it to
   * could overrun the dispatch bound. What it changes is that a source
   * which cannot be paid for in one slice is reported rather than retried
   * silently forever. See `ZERO_PROGRESS_PARKS_BEFORE_REPORT`.
   */
  atomicUnit?: boolean;
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
  /** Where the sweep stopped, mirrored here only under
   *  `resumeAcrossChains` so it survives an abandoned chain. */
  position?: Json;
  /**
   * Consecutive parks against an `atomicUnit` source that wrote nothing.
   *
   * Cleared by any slice that processes anything, which is what separates
   * a provider having one bad interval from a source that can never be
   * paid for in one slice. Without the distinction both present as a
   * single zero-progress park, and an alert that might be nothing is one
   * people learn to scroll past.
   */
  zero_progress_parks?: number;
  /** Set when the count above crossed the threshold and an operator was
   *  told, so a source that stays unpayable is reported once rather than
   *  every slice. Cleared by the same progress that clears the count. */
  unpayable_reported?: boolean;
}

/**
 * Every field `SweepState` defines. The collision guard compares against
 * this rather than against a type, because the check has to happen at
 * runtime on a value that was written by something else.
 */
const SWEEP_STATE_FIELDS = new Set<string>([
  "watermark",
  "signpost",
  "sweep_id",
  "last_sweep_id",
  "position",
  "zero_progress_parks",
  "unpayable_reported",
]);

/**
 * How many consecutive zero-progress parks against an `atomicUnit` source
 * are reported to an operator as a source that cannot be paid for.
 *
 * Not one. A CDN having a single bad interval and a document that can
 * never fit a slice both produce one zero-progress park, and if the first
 * report cannot be told from the second then `action_required` comes to
 * mean "might be nothing". Recurrence is what separates them, and a
 * transient cause does not recur.
 */
const ZERO_PROGRESS_PARKS_BEFORE_REPORT = 3;

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
  assertKeyIsOwned(spec.key, state);
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
  const carryAcrossChains = spec.resumeAcrossChains === true;
  const carryAcrossSlices =
    carryAcrossChains || spec.resumeAcrossSlices === true;

  // Frozen once per chain. Recomputing it per slice would let the bound
  // walk forward with the sweep, so a provider writing faster than the
  // sweep reads would never let it end.
  let signpost = isFreshChain ? undefined : state.signpost;
  if (signpost === undefined && spec.signpost !== undefined) {
    signpost = await spec.signpost();
  }

  // A fresh chain has no payload to read a position from, so under
  // `resumeAcrossChains` it reads the one the cursor kept. That is the
  // whole difference between the two durabilities: without it, a chain the
  // queue never delivered costs the walk back from the watermark.
  let resume: TResume | undefined;
  if (inbound !== undefined) {
    resume = (inbound.resume ?? undefined) as TResume | undefined;
  } else if (carryAcrossChains) {
    resume = (state.position ?? undefined) as TResume | undefined;
  }

  let watermark = state.watermark;
  let processed = 0;
  let notBefore: number | undefined;
  const maxPages = spec.maxPagesPerSlice ?? DEFAULT_MAX_PAGES_PER_SLICE;

  // Written per page, before the yield check, so a slice that parks has
  // already recorded everything it wrote. This is the whole reason the
  // watermark is reported per page rather than at the end.
  //
  // "Recorded", not "durable": on the in-process substrate a cursor
  // write is journalled in the worker thread and applied when the
  // dispatch returns, so a thread that dies mid-run loses every page's
  // watermark rather than the last one's. Durable at call time on a
  // substrate that commits immediately.
  const persistOpen = async (position: TResume | undefined): Promise<void> => {
    await ctx.cursor.write(spec.key, {
      ...(watermark !== undefined && { watermark }),
      ...(signpost !== undefined && { signpost }),
      ...(carryAcrossChains && position !== undefined && { position }),
      ...(state.zero_progress_parks !== undefined && {
        zero_progress_parks: state.zero_progress_parks,
      }),
      ...(state.unpayable_reported === true && { unpayable_reported: true }),
      sweep_id: sweepId,
    } satisfies SweepState);
  };

  for (let page = 0; page < maxPages; page++) {
    const output = await spec.page({
      resume,
      signpost,
      watermark,
      sweepId,
      slice: startingSlice,
    });
    processed += output.processed ?? 0;

    if (output.watermark !== undefined && output.watermark !== watermark) {
      watermark = output.watermark;
      await persistOpen(resume);
    }

    if (output.outcome === "failed") {
      // The watermark above is already committed, so whatever this page
      // did write is not re-read. The failure is reported as itself rather
      // than as a sweep that finished, which is the entire reason this arm
      // exists.
      return {
        ok: false,
        retry: output.retry,
        reason: output.reason,
      };
    }

    if (output.outcome === "done") {
      // Finished. The signpost and the chain id are cleared so the next
      // cron tick starts a fresh chain from the watermark rather than
      // inheriting a bound that has since gone stale. The position goes
      // with them: a finished sweep has nowhere to resume to, and leaving
      // one would send the next chain back to it.
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
    notBefore = output.notBefore ?? notBefore;

    // A page that asked not to be resumed before a given time has answered
    // a rate limit, and calling the provider again inside this slice is the
    // one response that cannot help. Breaking here rather than collecting
    // `notBefore` and acting on it only after the loop is the difference
    // between parking with the provider's own delay and spending the whole
    // page allowance against a provider that has already refused.
    if (output.notBefore !== undefined) break;

    if (ctx.budget.shouldYield) break;
  }

  // Out of budget or out of pages: park.
  //
  // `resume` is dropped unless the author opted in. A dropped position is
  // not lost work — the watermark is committed and the next slice
  // re-derives from it — whereas a stale token silently reinterpreted by
  // the provider is.
  const carried: Json = carryAcrossSlices ? (resume ?? null) : null;

  // A source served as one document that a slice could not get anything
  // out of has told us something the next identical attempt will not: it
  // re-downloads the whole thing to reach the same place. Counted rather
  // than reported on sight, because one bad interval at a provider looks
  // exactly like a document that will never fit.
  let zeroProgressParks = state.zero_progress_parks ?? 0;
  let unpayableReported = state.unpayable_reported === true;
  if (spec.atomicUnit === true && processed === 0) {
    zeroProgressParks += 1;
    if (
      zeroProgressParks >= ZERO_PROGRESS_PARKS_BEFORE_REPORT &&
      !unpayableReported
    ) {
      await ctx.activity.emit({
        severity: "action_required",
        summary:
          "This sync cannot get through its source in the time it is given",
        detail: {
          consecutive_empty_attempts: zeroProgressParks,
          // Named rather than left for the reader to infer, because the
          // generic reading — that the sync stopped making progress —
          // argues against the one thing that would resolve it.
          cause:
            "The provider serves this source whole, and fetching it uses the entire dispatch before any record can be written. Each attempt downloads it again and reaches the same place.",
        },
      });
      unpayableReported = true;
    }
  } else if (processed > 0) {
    zeroProgressParks = 0;
    unpayableReported = false;
  }

  await ctx.cursor.write(spec.key, {
    ...(watermark !== undefined && { watermark }),
    ...(signpost !== undefined && { signpost }),
    ...(carryAcrossChains && resume !== undefined && { position: resume }),
    ...(zeroProgressParks > 0 && { zero_progress_parks: zeroProgressParks }),
    ...(unpayableReported && { unpayable_reported: true }),
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
      ...(resume !== undefined && { position: digestPosition(resume) }),
    },
    ...(spec.stallGuard !== undefined && { stallGuard: spec.stallGuard }),
    ...(notBefore !== undefined && { notBefore }),
  };
  return { ok: true, done: false, continuation };
}

/**
 * Refuse a cursor key that already belongs to something else.
 *
 * Every exit writes the whole value at the key, and a cursor write
 * replaces rather than merges, so a key an integration already stores
 * state under loses that state on this sweep's first page: mapping tables,
 * sync tokens, per-entity watermarks, the ids needed to stop a push
 * channel.
 *
 * Nothing else catches it. The types are satisfied, and a handler that
 * rewrites its own value later in the same dispatch repairs the damage
 * before any single-dispatch test can observe it — so the suite stays
 * green and the loss only lands on a run that ends while parked, which is
 * a run that was already going badly. Failing here turns that into a
 * refusal on the first run in development.
 */
function assertKeyIsOwned(key: string, state: SweepState): void {
  const foreign = Object.keys(state).filter(
    (field) => !SWEEP_STATE_FIELDS.has(field),
  );
  if (foreign.length === 0) return;
  throw new Error(
    `sweep() was given cursor key "${key}", which already holds ${foreign.join(", ")}. ` +
      `A cursor write replaces the whole value rather than merging it, so this sweep would ` +
      `discard ${foreign.length === 1 ? "that field" : "those fields"} on its first page. ` +
      `Give the sweep a key of its own.`,
  );
}

/**
 * A comparable stand-in for the position a slice carried.
 *
 * Folded into the progress fingerprint so a sweep that advances without a
 * watermark is not read as stalled. Stable rather than short: the runtime
 * only ever compares it against the previous slice's, so collisions are
 * what matter and length is not.
 */
function digestPosition(position: Json): string {
  return typeof position === "string" ? position : JSON.stringify(position);
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
