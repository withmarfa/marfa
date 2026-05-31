import { describe, it, expect } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
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
