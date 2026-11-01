import { describe, it, expect, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
} from "@opentelemetry/sdk-trace";
import {
  BATCH_QUEUE_SIZE,
  ErrorBucketFilterSpanProcessor,
  HOLD_LIMITS,
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

  /** A span as the SDK hands the same object to `onStart` and `onEnd`. */
  function span(opts: {
    traceId: string;
    spanId: string;
    root?: boolean;
    failed?: boolean;
    remoteParent?: boolean;
  }): Span & ReadableSpan {
    const made = {
      name: opts.spanId,
      status: { code: SpanStatusCode.UNSET },
      attributes: {},
      resource: { asyncAttributesPending: false, attributes: {} },
      parentSpanContext: opts.root
        ? undefined
        : {
            traceId: opts.traceId,
            spanId: "p".repeat(16),
            traceFlags: 1,
            isRemote: opts.remoteParent ?? false,
          },
      spanContext: () => ({
        traceId: opts.traceId,
        spanId: opts.spanId,
        traceFlags: 1,
      }),
    };
    return made as unknown as Span & ReadableSpan;
  }

  const fail = (s: ReadableSpan): void => {
    (s as { status: { code: SpanStatusCode } }).status = {
      code: SpanStatusCode.ERROR,
    };
  };

  function gate(
    ratio: number,
    options?: ConstructorParameters<typeof ErrorBucketFilterSpanProcessor>[2],
  ) {
    const exported: string[] = [];
    const delegate = {
      onStart: vi.fn(),
      onEnd: (s: ReadableSpan) => {
        exported.push(s.spanContext().spanId);
      },
      forceFlush: () => Promise.resolve(),
      shutdown: vi.fn(() => Promise.resolve()),
    };
    const processor = new ErrorBucketFilterSpanProcessor(
      delegate,
      ratio,
      options,
    );
    const noContext = {} as never;
    return {
      processor,
      exported,
      delegate,
      start: (...spans: Span[]) => {
        for (const s of spans) processor.onStart(s, noContext);
      },
      end: (...spans: ReadableSpan[]) => {
        for (const s of spans) processor.onEnd(s);
      },
    };
  }

  it("exports the spans that ended before the error, with the one that failed", () => {
    const g = gate(0);
    const root = span({ traceId: OUTSIDE, spanId: "root", root: true });
    const ok = span({ traceId: OUTSIDE, spanId: "child-ok" });
    const bad = span({ traceId: OUTSIDE, spanId: "child-bad" });
    const after = span({ traceId: OUTSIDE, spanId: "child-after" });
    g.start(root, ok, bad, after);
    g.end(ok);
    fail(bad);
    g.end(bad, after, root);
    expect(g.exported.sort()).toEqual(
      ["child-after", "child-bad", "child-ok", "root"].sort(),
    );
    expect(g.processor.liveTraces()).toBe(0);
  });

  it("exports the spans that ended before a failing root", () => {
    const g = gate(0);
    const root = span({ traceId: OUTSIDE, spanId: "root", root: true });
    const ok = span({ traceId: OUTSIDE, spanId: "child-ok" });
    g.start(root, ok);
    g.end(ok);
    fail(root);
    g.end(root);
    expect(g.exported).toEqual(["child-ok", "root"]);
  });

  it("drops every span of a trace that never failed and is outside the baseline", () => {
    const g = gate(0);
    const root = span({ traceId: OUTSIDE, spanId: "root", root: true });
    const ok = span({ traceId: OUTSIDE, spanId: "child-ok" });
    g.start(root, ok);
    g.end(ok, root);
    expect(g.exported).toEqual([]);
    expect(g.processor.heldSpans()).toBe(0);
    expect(g.processor.liveTraces()).toBe(0);
  });

  it("exports every span of a trace inside the baseline", () => {
    const g = gate(0.05);
    const root = span({ traceId: INSIDE, spanId: "root", root: true });
    const ok = span({ traceId: INSIDE, spanId: "child-ok" });
    g.start(root, ok);
    g.end(ok, root);
    expect(g.exported).toEqual(["child-ok", "root"]);
  });

  it("keeps two traces apart", () => {
    const g = gate(0);
    const other = "e".repeat(32);
    const aRoot = span({ traceId: OUTSIDE, spanId: "a-root", root: true });
    const aChild = span({ traceId: OUTSIDE, spanId: "a-child" });
    const bRoot = span({ traceId: other, spanId: "b-root", root: true });
    const bChild = span({ traceId: other, spanId: "b-child" });
    g.start(aRoot, aChild, bRoot, bChild);
    g.end(aChild);
    fail(bChild);
    g.end(bChild, aRoot, bRoot);
    expect(g.exported).toEqual(["b-child", "b-root"]);
  });

  it("keeps a child that ends after its root, and leaves no state behind at ratio 1", () => {
    const g = gate(1);
    for (let i = 0; i < 5_000; i++) {
      const traceId = i.toString(16).padStart(32, "0");
      const root = span({ traceId, spanId: `root-${String(i)}`, root: true });
      const late = span({ traceId, spanId: `late-${String(i)}` });
      g.start(root, late);
      g.end(root, late);
    }
    expect(g.exported).toHaveLength(10_000);
    expect(g.processor.liveTraces()).toBe(0);
  });

  it("holds a child that ends after an unfailed root until the trace closes, then exports it with a later error", () => {
    const g = gate(0);
    const root = span({ traceId: OUTSIDE, spanId: "root", root: true });
    const early = span({ traceId: OUTSIDE, spanId: "early" });
    const late = span({ traceId: OUTSIDE, spanId: "late" });
    g.start(root, early, late);
    g.end(early, root);
    expect(g.exported).toEqual([]);
    fail(late);
    g.end(late);
    expect(g.exported.sort()).toEqual(["early", "late", "root"].sort());
    expect(g.processor.liveTraces()).toBe(0);
  });

  it("lets a root that never ends go at the age bound, and drops what it held", () => {
    let now = 1_000;
    const g = gate(0, { now: () => now });
    const root = span({ traceId: OUTSIDE, spanId: "root", root: true });
    const child = span({ traceId: OUTSIDE, spanId: "child" });
    g.start(root, child);
    g.end(child);
    expect(g.processor.liveTraces()).toBe(1);
    expect(g.processor.heldSpans()).toBe(1);

    now += HOLD_LIMITS.maxAgeMs - 1;
    g.processor.sweep();
    expect(g.processor.liveTraces()).toBe(1);

    now += 2;
    g.processor.sweep();
    expect(g.processor.liveTraces()).toBe(0);
    expect(g.processor.heldSpans()).toBe(0);
    // The root ends at last, finds nothing of its own, and is judged alone.
    fail(root);
    g.end(root);
    expect(g.exported).toEqual(["root"]);
    expect(g.processor.liveTraces()).toBe(0);
  });

  it("sweeps on a timer of its own, which does not keep the process alive", () => {
    vi.useFakeTimers();
    try {
      const g = gate(0);
      const root = span({ traceId: OUTSIDE, spanId: "root", root: true });
      g.start(root);
      expect(g.processor.liveTraces()).toBe(1);
      vi.advanceTimersByTime(
        HOLD_LIMITS.maxAgeMs + HOLD_LIMITS.sweepIntervalMs,
      );
      expect(g.processor.liveTraces()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not lose a later span of an exporting trace when many undecided traces arrive", () => {
    const g = gate(0);
    const root = span({ traceId: OUTSIDE, spanId: "root", root: true });
    const bad = span({ traceId: OUTSIDE, spanId: "bad" });
    const later = span({ traceId: OUTSIDE, spanId: "later" });
    g.start(root, bad, later);
    fail(bad);
    g.end(bad);
    for (let i = 0; i < HOLD_LIMITS.maxUndecidedTraces * 3; i++) {
      const traceId = "b" + i.toString(16).padStart(31, "0");
      g.start(span({ traceId, spanId: `flood-${String(i)}`, root: true }));
    }
    g.end(later, root);
    expect(g.exported).toEqual(["bad", "later", "root"]);
  });

  it("lets go of the oldest undecided trace past the bound, which is then judged span by span", () => {
    const g = gate(0);
    const max = HOLD_LIMITS.maxUndecidedTraces;
    const firstRoot = span({
      traceId: "a".repeat(32),
      spanId: "first-root",
      root: true,
    });
    const firstChild = span({ traceId: "a".repeat(32), spanId: "first-child" });
    g.start(firstRoot, firstChild);
    g.end(firstChild);
    for (let i = 1; i <= max; i++) {
      const traceId = "b" + i.toString(16).padStart(31, "0");
      g.start(span({ traceId, spanId: `r-${String(i)}`, root: true }));
    }
    expect(g.processor.liveTraces()).toBeLessThanOrEqual(max);
    expect(g.processor.heldSpans()).toBe(0);
    fail(firstRoot);
    g.end(firstRoot);
    expect(g.exported).toEqual(["first-root"]);
  });

  it("lets go of the oldest exporting trace past its bound, whose later spans are then judged alone", () => {
    const g = gate(0);
    const max = HOLD_LIMITS.maxExportingTraces;
    const ids: string[] = [];
    for (let i = 0; i <= max; i++) {
      const traceId = "c" + i.toString(16).padStart(31, "0");
      ids.push(traceId);
      const root = span({ traceId, spanId: `root-${String(i)}`, root: true });
      const bad = span({ traceId, spanId: `bad-${String(i)}` });
      g.start(root, bad);
      fail(bad);
      g.end(bad);
    }
    expect(g.processor.liveTraces()).toBe(max);
    const first = span({ traceId: ids[0] ?? "", spanId: "first-later" });
    const last = span({ traceId: ids[max] ?? "", spanId: "last-later" });
    // The first trace was let go, so a span of it now starts an undecided
    // entry and, with no error, is not exported; the last is still exporting.
    g.start(first, last);
    g.end(first, last);
    expect(g.exported).toContain("last-later");
    expect(g.exported).not.toContain("first-later");
  });

  it("exports a trace whole when either of two local roots sharing its trace id fails", () => {
    for (const failing of ["a", "b"] as const) {
      const g = gate(0);
      const aRoot = span({
        traceId: OUTSIDE,
        spanId: "a-root",
        remoteParent: true,
      });
      const bRoot = span({
        traceId: OUTSIDE,
        spanId: "b-root",
        remoteParent: true,
      });
      const aChild = span({ traceId: OUTSIDE, spanId: "a-child" });
      const bChild = span({ traceId: OUTSIDE, spanId: "b-child" });
      g.start(aRoot, bRoot, aChild, bChild);
      g.end(aChild, bChild);
      fail(failing === "a" ? aRoot : bRoot);
      g.end(aRoot);
      // The first root to end must not have discarded the other's spans.
      if (failing === "b") expect(g.exported).toEqual([]);
      g.end(bRoot);
      expect(g.exported.sort(), failing).toEqual(
        ["a-child", "a-root", "b-child", "b-root"].sort(),
      );
      expect(g.processor.liveTraces()).toBe(0);
    }
  });

  it("holds no more than the bound for one trace, and exports what it held with the error and all that follows", () => {
    const g = gate(0);
    const per = HOLD_LIMITS.maxHeldSpansPerTrace;
    const root = span({ traceId: OUTSIDE, spanId: "root", root: true });
    g.start(root);
    for (let i = 0; i < per + 50; i++) {
      const child = span({ traceId: OUTSIDE, spanId: `c-${String(i)}` });
      g.start(child);
      g.end(child);
    }
    expect(g.processor.heldSpans()).toBe(per);
    fail(root);
    g.end(root);
    expect(g.exported).toHaveLength(per + 1);
    expect(g.exported).toContain("c-0");
    expect(g.exported).not.toContain(`c-${String(per)}`);
  });

  it("holds no more than the bound across all traces", () => {
    const g = gate(0);
    const total = HOLD_LIMITS.maxHeldSpans;
    const perTrace = HOLD_LIMITS.maxHeldSpansPerTrace;
    const traces = Math.ceil(total / perTrace) + 5;
    expect(traces).toBeLessThanOrEqual(HOLD_LIMITS.maxUndecidedTraces);
    for (let t = 0; t < traces; t++) {
      const traceId = t.toString(16).padStart(32, "f");
      g.start(span({ traceId, spanId: `root-${String(t)}`, root: true }));
      for (let i = 0; i < perTrace; i++) {
        const child = span({ traceId, spanId: `c-${String(t)}-${String(i)}` });
        g.start(child);
        g.end(child);
      }
    }
    expect(g.processor.heldSpans()).toBe(total);
  });

  it("releases a held trace into the batch queue without overflowing it", async () => {
    expect(HOLD_LIMITS.maxHeldSpansPerTrace).toBeLessThan(BATCH_QUEUE_SIZE);
    const exportedSpans: ReadableSpan[] = [];
    const memory = {
      export: (
        spans: ReadableSpan[],
        done: (result: { code: number }) => void,
      ) => {
        exportedSpans.push(...spans);
        done({ code: 0 });
      },
      shutdown: () => Promise.resolve(),
    };
    const batch = new BatchSpanProcessor({
      exporter: memory,
      maxQueueSize: BATCH_QUEUE_SIZE,
      scheduledDelayMillis: 60_000,
    });
    const processor = new ErrorBucketFilterSpanProcessor(batch, 0);
    const noContext = {} as never;
    const root = span({ traceId: OUTSIDE, spanId: "root", root: true });
    processor.onStart(root, noContext);
    const per = HOLD_LIMITS.maxHeldSpansPerTrace;
    for (let i = 0; i < per; i++) {
      const child = span({ traceId: OUTSIDE, spanId: `c-${String(i)}` });
      processor.onStart(child, noContext);
      processor.onEnd(child);
    }
    fail(root);
    processor.onEnd(root);
    await processor.shutdown();
    expect(exportedSpans).toHaveLength(per + 1);
  });

  it("holds no state once a run is over, whichever way each trace ended", () => {
    const g = gate(0.5);
    for (let i = 0; i < 300; i++) {
      const traceId = (i * 7919).toString(16).padStart(32, "a");
      const root = span({ traceId, spanId: `r${String(i)}`, root: true });
      const a = span({ traceId, spanId: `a${String(i)}` });
      const b = span({ traceId, spanId: `b${String(i)}` });
      g.start(root, a, b);
      if (i % 3 === 0) fail(b);
      if (i % 2 === 0) g.end(a, b, root);
      else g.end(root, b, a);
    }
    expect(g.processor.liveTraces()).toBe(0);
    expect(g.processor.heldSpans()).toBe(0);
  });

  it("drops what it holds at shutdown, shuts the exporting processor down and stops its timer", async () => {
    const g = gate(0);
    const root = span({ traceId: OUTSIDE, spanId: "root", root: true });
    const child = span({ traceId: OUTSIDE, spanId: "child" });
    g.start(root, child);
    g.end(child);
    await g.processor.shutdown();
    expect(g.delegate.shutdown).toHaveBeenCalledOnce();
    expect(g.processor.heldSpans()).toBe(0);
    expect(g.processor.liveTraces()).toBe(0);
  });
});
