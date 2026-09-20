import { describe, expect, it } from "vitest";
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
  it("GETs the receiver once per run and reports its answer", async () => {
    const { impl, calls } = makeFetch([() => new Response("ok")]);
    const pinger = new HeartbeatPinger("https://hb.example/ping", impl);
    expect(await pinger.runOnce()).toEqual({ ok: true, status: 200 });
    expect(calls).toEqual(["https://hb.example/ping"]);
  });

  it("never throws for a receiver that fails or answers non-2xx", async () => {
    const { impl, calls } = makeFetch([
      () => new Error("ECONNREFUSED"),
      () => new Response("late", { status: 503 }),
      () => new Response("ok"),
    ]);
    const pinger = new HeartbeatPinger("https://hb.example/ping", impl);
    // The pinger must outlive its receiver's bad days: a run reports the
    // failure and the next run still goes out.
    expect(await pinger.runOnce()).toEqual({ ok: false, status: null });
    expect(await pinger.runOnce()).toEqual({ ok: false, status: 503 });
    expect(await pinger.runOnce()).toEqual({ ok: true, status: 200 });
    expect(calls).toHaveLength(3);
  });
});
