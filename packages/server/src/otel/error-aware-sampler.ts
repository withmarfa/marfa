import { SpanStatusCode } from "@opentelemetry/api";
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
 * of a trace not yet known to be exported are held until one errors (they
 * are then released with it) or the trace's local root ends without one
 * (they are then dropped). It's stateless across instances: the same trace id
 * buckets identically.
 *
 * Caveat (documented, not a bug): every span is fully recorded in memory
 * before the drop decision, and a trace's undecided spans are held until its
 * root ends, within the bounds below. That's cheap at Marfa's scale. It is
 * NOT cross-service tail sampling — that needs an OTel Collector. For a
 * single in-process service this is exactly right.
 */

/** Most traces held at once; the oldest is let go to make room. */
const MAX_HELD_TRACES = 1_000;
/** Most spans held for one trace; later spans of it are not held. */
const MAX_HELD_SPANS_PER_TRACE = 1_000;

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

/** A span with no parent here: the trace began in this process or in a caller's. */
function isLocalRoot(span: ReadableSpan): boolean {
  const parent = span.parentSpanContext;
  return parent === undefined || parent.isRemote === true;
}

interface TraceState {
  /** Set once the trace is known to be exported, so its later spans pass. */
  exporting: boolean;
  held: ReadableSpan[];
}

export class ErrorBucketFilterSpanProcessor implements SpanProcessor {
  private readonly traces = new Map<string, TraceState>();

  constructor(
    private readonly delegate: SpanProcessor,
    private readonly sampleRatio: number,
  ) {}

  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    const state = this.traces.get(traceId);
    const root = isLocalRoot(span);

    if (state?.exporting || shouldExportSpan(span, this.sampleRatio)) {
      for (const held of state?.held ?? []) this.delegate.onEnd(held);
      this.delegate.onEnd(span);
      if (root) this.traces.delete(traceId);
      else this.traces.set(traceId, { exporting: true, held: [] });
      return;
    }

    if (root) {
      this.traces.delete(traceId);
      return;
    }
    const undecided = state ?? { exporting: false, held: [] };
    if (undecided.held.length < MAX_HELD_SPANS_PER_TRACE) {
      undecided.held.push(span);
    }
    if (!state) {
      this.traces.set(traceId, undecided);
      if (this.traces.size > MAX_HELD_TRACES) {
        const oldest = this.traces.keys().next();
        if (!oldest.done) this.traces.delete(oldest.value);
      }
    }
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}
