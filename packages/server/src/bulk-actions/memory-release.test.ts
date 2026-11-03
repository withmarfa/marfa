import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
let totalHeap = 0;

vi.mock("node:inspector", () => ({
  Session: class {
    connect = connect;
    post = post;
    disconnect = disconnect;
  },
}));
vi.mock("node:v8", () => ({
  getHeapStatistics: () => ({ total_heap_size: totalHeap }),
}));

const { noteBulkWork } = await import("./memory-release.js");

const MB = 1024 * 1024;

beforeEach(() => {
  vi.useFakeTimers();
  totalHeap = 100 * MB;
  post.mockReset();
  connect.mockReset();
  disconnect.mockReset();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("noteBulkWork", () => {
  it("collects the heap once, after the work has been quiet", () => {
    noteBulkWork();
    totalHeap = 400 * MB;
    vi.advanceTimersByTime(1_500);
    noteBulkWork();
    vi.advanceTimersByTime(1_500);
    expect(post).not.toHaveBeenCalled();

    vi.advanceTimersByTime(600);
    expect(post).toHaveBeenCalledExactlyOnceWith(
      "HeapProfiler.collectGarbage",
      expect.any(Function),
    );
  });

  it("closes its session after the collection answers", async () => {
    noteBulkWork();
    totalHeap = 400 * MB;
    vi.advanceTimersByTime(2_000);
    expect(disconnect).not.toHaveBeenCalled();

    (post.mock.calls[0] as [string, () => void])[1]();
    await vi.advanceTimersByTimeAsync(1);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("leaves a heap that barely grew alone", () => {
    noteBulkWork();
    totalHeap = 130 * MB;
    vi.advanceTimersByTime(2_000);
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps going when the inspector is unavailable", () => {
    connect.mockImplementation(() => {
      throw new Error("inspector unavailable");
    });
    noteBulkWork();
    totalHeap = 400 * MB;
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
