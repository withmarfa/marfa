import { describe, it, expect, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  ErrorBucketFilterSpanProcessor,
  hashTraceIdToUnitInterval,
  shouldExportSpan,
} from "./error-aware-sampler.js";

function fakeSpan(opts: {
  traceId: string;
  statusCode?: SpanStatusCode;
  httpStatus?: number;
}): ReadableSpan {
  return {
    status: { code: opts.statusCode ?? SpanStatusCode.UNSET },
    attributes:
      opts.httpStatus !== undefined
        ? { "http.response.status_code": opts.httpStatus }
        : {},
    spanContext: () => ({ traceId: opts.traceId, spanId: "0".repeat(16) }),
  } as unknown as ReadableSpan;
}

const TWO_POW_64 = 1n << 64n;
const ZERO_BUCKET = "f".repeat(32); // low 64 bits all-ones → ratio ≈ 1 (never sampled)
const ALWAYS_BUCKET = "0".repeat(32); // low 64 bits zero → ratio 0 (always sampled)

describe("hashTraceIdToUnitInterval", () => {
  it("is deterministic", () => {
    const id = "abcdef0123456789abcdef0123456789";
    expect(hashTraceIdToUnitInterval(id)).toBe(hashTraceIdToUnitInterval(id));
  });

  it("returns values in [0, 1)", () => {
    expect(hashTraceIdToUnitInterval(ALWAYS_BUCKET)).toBe(0);
    expect(hashTraceIdToUnitInterval(ZERO_BUCKET)).toBeGreaterThan(0.99);
    expect(hashTraceIdToUnitInterval(ZERO_BUCKET)).toBeLessThan(1);
  });

  it("buckets ~5% of evenly-spaced trace ids below 0.05", () => {
    const N = 10000;
    let inBucket = 0;
    for (let i = 0; i < N; i++) {
      const low = (BigInt(i) * TWO_POW_64) / BigInt(N);
      const hex = low.toString(16).padStart(16, "0").slice(-16);
      const traceId = "0".repeat(16) + hex;
      if (hashTraceIdToUnitInterval(traceId) < 0.05) inBucket++;
    }
    expect(inBucket / N).toBeCloseTo(0.05, 2);
  });
});

describe("shouldExportSpan — 5% baseline + 100% on error", () => {
  it("always exports a span with ERROR status, even outside the bucket", () => {
    const span = fakeSpan({
      traceId: ZERO_BUCKET,
      statusCode: SpanStatusCode.ERROR,
    });
    expect(shouldExportSpan(span, 0.05)).toBe(true);
  });

  it("always exports a 5xx span, even outside the bucket", () => {
    const span = fakeSpan({ traceId: ZERO_BUCKET, httpStatus: 503 });
    expect(shouldExportSpan(span, 0.05)).toBe(true);
  });

  it("does not export a non-error span outside the bucket", () => {
    const span = fakeSpan({ traceId: ZERO_BUCKET, httpStatus: 200 });
    expect(shouldExportSpan(span, 0.05)).toBe(false);
  });

  it("exports a non-error span inside the bucket", () => {
    const span = fakeSpan({ traceId: ALWAYS_BUCKET, httpStatus: 200 });
    expect(shouldExportSpan(span, 0.05)).toBe(true);
  });

  it("ratio 0 still exports errors but no baseline traffic", () => {
    expect(
      shouldExportSpan(
        fakeSpan({ traceId: ALWAYS_BUCKET, httpStatus: 200 }),
        0,
      ),
    ).toBe(false);
    expect(
      shouldExportSpan(
        fakeSpan({ traceId: ALWAYS_BUCKET, statusCode: SpanStatusCode.ERROR }),
        0,
      ),
    ).toBe(true);
  });
});

describe("ErrorBucketFilterSpanProcessor — a trace is exported whole or not at all", () => {
  const OUTSIDE = ZERO_BUCKET;
  const INSIDE = ALWAYS_BUCKET;

  function span(opts: {
    traceId: string;
    spanId: string;
    root?: boolean;
    failed?: boolean;
    remoteParent?: boolean;
  }): ReadableSpan {
    return {
      name: opts.spanId,
      status: {
        code: opts.failed ? SpanStatusCode.ERROR : SpanStatusCode.UNSET,
      },
      attributes: {},
      parentSpanContext: opts.root
        ? undefined
        : {
            traceId: opts.traceId,
            spanId: "p".repeat(16),
            traceFlags: 1,
            isRemote: opts.remoteParent ?? false,
          },
      spanContext: () => ({ traceId: opts.traceId, spanId: opts.spanId }),
    } as unknown as ReadableSpan;
  }

  function gate(ratio: number) {
    const exported: string[] = [];
    const delegate = {
      onStart: vi.fn(),
      onEnd: (s: ReadableSpan) => {
        exported.push(s.spanContext().spanId);
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
    return {
      processor: new ErrorBucketFilterSpanProcessor(delegate, ratio),
      exported,
    };
  }

  it("exports the spans that ended before the error, with the one that failed", () => {
    const { processor, exported } = gate(0);
    processor.onEnd(span({ traceId: OUTSIDE, spanId: "child-ok" }));
    processor.onEnd(
      span({ traceId: OUTSIDE, spanId: "child-bad", failed: true }),
    );
    processor.onEnd(span({ traceId: OUTSIDE, spanId: "child-after" }));
    processor.onEnd(span({ traceId: OUTSIDE, spanId: "root", root: true }));
    expect(exported.sort()).toEqual(
      ["child-after", "child-bad", "child-ok", "root"].sort(),
    );
  });

  it("exports the spans that ended before a failing root", () => {
    const { processor, exported } = gate(0);
    processor.onEnd(span({ traceId: OUTSIDE, spanId: "child-ok" }));
    processor.onEnd(
      span({ traceId: OUTSIDE, spanId: "root", root: true, failed: true }),
    );
    expect(exported).toEqual(["child-ok", "root"]);
  });

  it("drops every span of a trace that never failed and is outside the baseline", () => {
    const { processor, exported } = gate(0);
    processor.onEnd(span({ traceId: OUTSIDE, spanId: "child-ok" }));
    processor.onEnd(span({ traceId: OUTSIDE, spanId: "root", root: true }));
    expect(exported).toEqual([]);
  });

  it("exports every span of a trace inside the baseline", () => {
    const { processor, exported } = gate(0.05);
    processor.onEnd(span({ traceId: INSIDE, spanId: "child-ok" }));
    processor.onEnd(span({ traceId: INSIDE, spanId: "root", root: true }));
    expect(exported).toEqual(["child-ok", "root"]);
  });

  it("keeps two traces apart", () => {
    const { processor, exported } = gate(0);
    const other = "e".repeat(32);
    processor.onEnd(span({ traceId: OUTSIDE, spanId: "a-child" }));
    processor.onEnd(span({ traceId: other, spanId: "b-child", failed: true }));
    processor.onEnd(span({ traceId: OUTSIDE, spanId: "a-root", root: true }));
    processor.onEnd(span({ traceId: other, spanId: "b-root", root: true }));
    expect(exported).toEqual(["b-child", "b-root"]);
  });

  it("treats a span whose parent is in another process as its trace's root here", () => {
    const { processor, exported } = gate(0);
    processor.onEnd(span({ traceId: OUTSIDE, spanId: "child-ok" }));
    processor.onEnd(
      span({ traceId: OUTSIDE, spanId: "server", remoteParent: true }),
    );
    // The trace ended without a failure, so a later trace with the same id
    // starts from nothing and nothing from this one is still held.
    processor.onEnd(span({ traceId: OUTSIDE, spanId: "later", failed: true }));
    expect(exported).toEqual(["later"]);
  });

  it("holds a bounded number of traces that never end", () => {
    const { processor, exported } = gate(0);
    for (let i = 0; i < 5_000; i++) {
      const traceId = i.toString(16).padStart(32, "f");
      processor.onEnd(span({ traceId, spanId: `child-${String(i)}` }));
    }
    // The oldest were let go to make room, so an error in the first trace
    // exports only itself, and one in the last exports what it held.
    processor.onEnd(
      span({ traceId: "f".repeat(32), spanId: "first-bad", failed: true }),
    );
    processor.onEnd(
      span({
        traceId: (4_999).toString(16).padStart(32, "f"),
        spanId: "last-bad",
        failed: true,
      }),
    );
    expect(exported).toContain("first-bad");
    expect(exported).not.toContain("child-0");
    expect(exported).toContain("child-4999");
    expect(exported).toContain("last-bad");
  });
});
