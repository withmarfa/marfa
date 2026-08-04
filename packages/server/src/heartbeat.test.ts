import { describe, expect, it, vi } from "vitest";
import { HeartbeatPinger } from "./heartbeat.js";

function makeFetch(responses: (() => Response | Error)[]) {
  const calls: string[] = [];
  const impl = ((input: string | URL | Request) => {
    calls.push(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    const out = next ? next() : new Response("ok");
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve(out);
  }) as typeof fetch;
  return { impl, calls };
}

describe("HeartbeatPinger", () => {
  it("pings immediately on start and again on the interval", async () => {
    vi.useFakeTimers();
    try {
      const { impl, calls } = makeFetch([() => new Response("ok")]);
      const pinger = new HeartbeatPinger(
        "https://hb.example/ping",
        60_000,
        impl,
      );
      pinger.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe("https://hb.example/ping");
      pinger.stop();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failing receiver never throws out of the timer", async () => {
    vi.useFakeTimers();
    try {
      const { impl, calls } = makeFetch([
        () => new Error("ECONNREFUSED"),
        () => new Response("late", { status: 503 }),
        () => new Response("ok"),
      ]);
      const pinger = new HeartbeatPinger(
        "https://hb.example/ping",
        1_000,
        impl,
      );
      pinger.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      // Three pings despite a network failure and a non-2xx: the pinger
      // must outlive its receiver's bad days.
      expect(calls).toHaveLength(3);
      pinger.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("start is idempotent", async () => {
    vi.useFakeTimers();
    try {
      const { impl, calls } = makeFetch([() => new Response("ok")]);
      const pinger = new HeartbeatPinger(
        "https://hb.example/ping",
        1_000,
        impl,
      );
      pinger.start();
      pinger.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      // One immediate ping plus one interval tick — not doubled.
      expect(calls).toHaveLength(2);
      pinger.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
