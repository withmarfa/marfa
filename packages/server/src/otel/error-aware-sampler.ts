import { SpanStatusCode } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/**
 * "5% baseline + 100% on errors" trace sampling (T-275).
 *
 * Head-based sampling (`TraceIdRatioBasedSampler`) decides at span *start*,
 * before the handler runs — so it can't know a request will error and would
 * drop 95% of error traces. The correct pattern for a single service with
 * no tail-sampling collector is: record EVERY span (the SDK runs with
 * `AlwaysOnSampler`), then gate EXPORT at span end, when the error outcome
 * is known.
 *
 * `ErrorBucketFilterSpanProcessor` wraps the real exporting processor (a
 * `BatchSpanProcessor`) and only forwards a span to it when the span errored
 * OR its trace falls in the deterministic baseline bucket. The decision is
 * per-trace (hash of the trace id), so all spans of a sampled-in trace stay
 * together, and it's stateless — the same trace id buckets identically
 * across instances.
 *
 * Caveat (documented, not a bug): every span is fully recorded in memory
 * before the drop decision. That's cheap at Marfa's scale. It is NOT
 * cross-service tail sampling — that needs an OTel Collector. For a single
 * in-process service this is exactly right.
 */

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

export class ErrorBucketFilterSpanProcessor implements SpanProcessor {
  constructor(
    private readonly delegate: SpanProcessor,
    private readonly sampleRatio: number,
  ) {}

  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (shouldExportSpan(span, this.sampleRatio)) {
      this.delegate.onEnd(span);
    }
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}
