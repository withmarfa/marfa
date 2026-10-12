import { diag, SpanStatusCode } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/**
 * "5% baseline + 100% on errors" trace sampling.
 *
 * Head-based sampling (`TraceIdRatioBasedSampler`) decides at span *start*,
 * before the handler runs — so it can't know a request will error and would
 * drop 95% of error traces. The correct pattern for a single service with
 * no tail-sampling collector is: record EVERY span (the SDK runs with
 * `AlwaysOnSampler`), then gate EXPORT at span end, when the error outcome
 * is known.
 *
 * `ErrorBucketFilterSpanProcessor` wraps the real exporting processor (a
 * `BatchSpanProcessor`). A trace is exported whole or not at all: the
 * baseline bucket is a hash of the trace id, so every span of a trace in it
 * is exported, and a trace outside it is exported when any span of it
 * errored. A request's child spans end before the span that fails, so spans
 * of a trace not yet known to be exported are held until one of its spans
 * errors, when they are released with it and every later span of the trace
 * passes straight through, or until the last span of the trace has ended
 * without one, when they are dropped.
 *
 * **State exists only while spans of the trace are open.** `onStart` counts
 * the trace's open spans and `onEnd` counts them down; the entry goes when
 * the count reaches zero. That covers a child that ends after its root and
 * two local roots that share a trace id (a propagated `traceparent`), and
 * `onEnd` never creates an entry, so a span that ends with none cannot leave
 * one behind. It is judged alone, by {@link shouldExportSpan}. A span that
 * starts after the count has reached zero begins a new entry, so it is not
 * released with an error trace that was exported before it started.
 *
 * **Bounds** ({@link HOLD_LIMITS}). A span can stay open for a long time (an
 * event stream) or for ever (a span nothing ends), so every entry also has
 * these limits, and the bounds hold on every insertion:
 *
 * - at most `maxUndecidedTraces` undecided traces at once. Past it the oldest
 *   is let go: what it held is dropped and its later spans are judged alone,
 *   so a later error still exports the span that carries it but not the
 *   spans that ended before it.
 * - at most `maxExportingTraces` exporting traces at once. They are a flag
 *   and a count, with no spans. Past the bound the oldest is let go and its
 *   later spans are judged alone, so one that is neither an error nor in the
 *   baseline bucket is lost, and a warning goes to the OpenTelemetry
 *   diagnostic logger.
 * - at most `maxHeldSpansPerTrace` held spans for one trace and `maxHeldSpans`
 *   across all of them. A span that would exceed either is not held, so an
 *   error exports the spans held and every span after it, and not those the
 *   bound turned away.
 * - an entry lives at most `maxAgeMs` after its first span started. A sweep
 *   every `sweepIntervalMs`, on a timer that does not keep the process alive,
 *   lets go of older entries as it does the oldest past a count bound.
 *
 * Held spans are released into the batch processor's queue in one go, which
 * `maxHeldSpansPerTrace` keeps well under {@link BATCH_QUEUE_SIZE}. At
 * shutdown what is still held is dropped, since no span of it has errored, and
 * the exporting processor is shut down, which flushes its queue.
 *
 * Caveat (documented, not a bug): every span is fully recorded in memory
 * before the drop decision. It is NOT cross-service tail sampling — that
 * needs an OTel Collector. For a single in-process service this is exactly
 * right.
 */

/** The limits the processor holds itself to, exported for the tests. */
export const HOLD_LIMITS = {
  maxUndecidedTraces: 1_000,
  maxExportingTraces: 10_000,
  maxHeldSpansPerTrace: 500,
  maxHeldSpans: 10_000,
  maxAgeMs: 5 * 60_000,
  sweepIntervalMs: 30_000,
} as const;

/**
 * The batch processor's queue length. Spans past it are dropped, so it is
 * raised from the default 2,048 to leave room for a released trace of
 * `maxHeldSpansPerTrace` beside the traffic already queued.
 */
export const BATCH_QUEUE_SIZE = 4_096;

const SCALE = 1_000_000n;
const TWO_POW_64 = 1n << 64n;

/**
 * Maps a 128-bit hex trace id into [0, 1) using its low 64 bits, the same
 * basis `TraceIdRatioBasedSampler` uses — stable and ~uniform. BigInt math
 * avoids float-precision loss on the 64-bit value. Unparseable ids return 1
 * (never in the baseline bucket; they still export via the error path).
 *
 * Exported for unit testing.
 */
export function hashTraceIdToUnitInterval(traceId: string): number {
  const low = traceId.length >= 16 ? traceId.slice(-16) : traceId;
  let v: bigint;
  try {
    v = BigInt(`0x${low}`);
  } catch {
    return 1;
  }
  return Number((v * SCALE) / TWO_POW_64) / Number(SCALE);
}

/**
 * The export gate. Exported for unit testing.
 */
export function shouldExportSpan(
  span: ReadableSpan,
  sampleRatio: number,
): boolean {
  if (span.status.code === SpanStatusCode.ERROR) return true;
  const statusCode = span.attributes["http.response.status_code"];
  if (typeof statusCode === "number" && statusCode >= 500) return true;
  return hashTraceIdToUnitInterval(span.spanContext().traceId) < sampleRatio;
}

interface TraceState {
  /** Spans of the trace started and not yet ended. */
  open: number;
  /** Set once the trace is known to be exported, so its later spans pass. */
  exporting: boolean;
  /** Spans that ended before the trace was known to be exported. */
  held: ReadableSpan[];
  startedAt: number;
}

export interface ProcessorOptions {
  now?: () => number;
  maxAgeMs?: number;
  sweepIntervalMs?: number;
}

export class ErrorBucketFilterSpanProcessor implements SpanProcessor {
  /** Both maps are in the order their entries were made. */
  private readonly undecided = new Map<string, TraceState>();
  private readonly exporting = new Map<string, TraceState>();
  /** The entry each open span was counted in, which may no longer be live. */
  private readonly counted = new WeakMap<object, TraceState>();
  private heldTotal = 0;
  private lastWarningAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly delegate: SpanProcessor,
    private readonly sampleRatio: number,
    options: ProcessorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? HOLD_LIMITS.maxAgeMs;
    this.timer = setInterval(() => {
      this.sweep();
    }, options.sweepIntervalMs ?? HOLD_LIMITS.sweepIntervalMs);
    this.timer.unref();
  }

  /** Traces with an entry, for the tests. */
  liveTraces(): number {
    return this.undecided.size + this.exporting.size;
  }

  /** Spans held, for the tests. */
  heldSpans(): number {
    return this.heldTotal;
  }

  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
    const traceId = span.spanContext().traceId;
    let state = this.undecided.get(traceId) ?? this.exporting.get(traceId);
    if (!state) {
      state = {
        open: 0,
        exporting: false,
        held: [],
        startedAt: this.now(),
      };
      this.undecided.set(traceId, state);
      this.trim();
    }
    state.open += 1;
    this.counted.set(span, state);
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    const counted = this.counted.get(span);
    this.counted.delete(span);
    // An entry let go while the span was open is not the live one, if any.
    const state =
      counted !== undefined &&
      (this.undecided.get(traceId) === counted ||
        this.exporting.get(traceId) === counted)
        ? counted
        : undefined;

    if (state?.exporting || shouldExportSpan(span, this.sampleRatio)) {
      if (state) this.export(traceId, state);
      this.delegate.onEnd(span);
    } else if (
      state &&
      state.held.length < HOLD_LIMITS.maxHeldSpansPerTrace &&
      this.heldTotal < HOLD_LIMITS.maxHeldSpans
    ) {
      state.held.push(span);
      this.heldTotal += 1;
    }

    if (counted) {
      counted.open -= 1;
      if (state && counted.open <= 0) this.remove(traceId, counted);
    }
  }

  /** Lets go of every entry older than the age bound. */
  sweep(): void {
    const oldest = this.now() - this.maxAgeMs;
    for (const map of [this.undecided, this.exporting]) {
      for (const [traceId, state] of map) {
        if (state.startedAt < oldest) this.remove(traceId, state);
      }
    }
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    clearInterval(this.timer);
    for (const state of this.undecided.values()) state.held = [];
    this.undecided.clear();
    this.exporting.clear();
    this.heldTotal = 0;
    return this.delegate.shutdown();
  }

  /** The trace is now known to be exported: release what it held. */
  private export(traceId: string, state: TraceState): void {
    if (!state.exporting) {
      state.exporting = true;
      this.undecided.delete(traceId);
      this.exporting.set(traceId, state);
      this.trim();
    }
    const held = state.held;
    state.held = [];
    this.heldTotal -= held.length;
    for (const span of held) this.delegate.onEnd(span);
  }

  private remove(traceId: string, state: TraceState): void {
    this.heldTotal -= state.held.length;
    state.held = [];
    (state.exporting ? this.exporting : this.undecided).delete(traceId);
  }

  /** Brings both maps back within their bounds, oldest first. */
  private trim(): void {
    while (this.undecided.size > HOLD_LIMITS.maxUndecidedTraces) {
      this.letGoOfOldest(this.undecided);
    }
    while (this.exporting.size > HOLD_LIMITS.maxExportingTraces) {
      this.letGoOfOldest(this.exporting);
      const at = this.now();
      if (at - this.lastWarningAt > 60_000) {
        this.lastWarningAt = at;
        diag.warn(
          "Trace sampling let go of an exporting trace past its bound; later spans of it are judged one by one.",
        );
      }
    }
  }

  private letGoOfOldest(map: Map<string, TraceState>): void {
    for (const [traceId, state] of map) {
      this.remove(traceId, state);
      return;
    }
  }
}
