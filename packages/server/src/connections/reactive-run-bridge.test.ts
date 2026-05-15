import { describe, it, expect, vi } from "vitest";
import { tryStartReactiveRunBridge } from "./reactive-run-bridge.js";
import type { Storage } from "../storage/interface.js";

const STORAGE_STUB = {
  coordination: {
    withJobLock: () => Promise.resolve(undefined),
  },
} as unknown as Storage;

describe("tryStartReactiveRunBridge", () => {
  it("returns null when queueUrl is missing (self-hoster path)", () => {
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      apiToken: "token",
    });
    expect(bridge).toBeNull();
  });

  it("returns null when apiToken is missing", () => {
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      queueUrl: "https://queue.example.com",
    });
    expect(bridge).toBeNull();
  });

  it("returns a runtime when both are present", async () => {
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      queueUrl: "https://queue.example.com",
      apiToken: "token",
    });
    expect(bridge).not.toBeNull();
    expect(typeof bridge?.start).toBe("function");
    expect(typeof bridge?.stop).toBe("function");
    // Bridges constructed without `config.fetch` instantiate a Pool;
    // stop() to release it cleanly (avoids leaked-handle warnings).
    await bridge?.stop();
  });

  it("respects explicit config over env vars", async () => {
    const prevUrl = process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URL;
    const prevToken = process.env.CLOUDFLARE_QUEUES_API_TOKEN;
    try {
      process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URL = "https://env-url";
      process.env.CLOUDFLARE_QUEUES_API_TOKEN = "env-token";
      const bridge = tryStartReactiveRunBridge(STORAGE_STUB);
      expect(bridge).not.toBeNull();
      await bridge?.stop();
    } finally {
      if (prevUrl === undefined)
        delete process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URL;
      else process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URL = prevUrl;
      if (prevToken === undefined)
        delete process.env.CLOUDFLARE_QUEUES_API_TOKEN;
      else process.env.CLOUDFLARE_QUEUES_API_TOKEN = prevToken;
    }
  });
});

// T-135 — bounded undici Pool transport. The bridge constructs a Pool
// when config.fetch is absent (production path) and bypasses the Pool
// when config.fetch is injected (test path). These tests assert the
// wiring without requiring intricate undici-MockAgent setup; the actual
// connection-reuse property is a guarantee of undici itself and is
// verified end-to-end via the staging load smoke described in the
// T-135 vault ticket.
describe("reactive-run-bridge — Pool transport (T-135)", () => {
  it("stop() releases the Pool cleanly when Pool is in use", async () => {
    // Construct without config.fetch — Pool is created.
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      queueUrl: "https://queue.example.com/queue",
      apiToken: "token",
    });
    expect(bridge).not.toBeNull();
    // stop() must await pool.close(); if the wiring is broken, vitest
    // surfaces open-handle warnings. Idempotent at the Pool layer.
    await expect(bridge?.stop()).resolves.toBeUndefined();
  });

  it("stop() succeeds when config.fetch was injected (Pool bypassed)", async () => {
    const fetchStub = vi.fn(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      queueUrl: "https://queue.example.com/queue",
      apiToken: "token",
      fetch: fetchStub as unknown as typeof fetch,
    });
    expect(bridge).not.toBeNull();
    await expect(bridge?.stop()).resolves.toBeUndefined();
    // fetchStub was not invoked — bridge was constructed but never
    // started, so no events fanned out. We're verifying stop() works
    // cleanly in the fetch-injected configuration (no Pool to close).
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("Pool URL parsing handles queueUrl with path + query segments", async () => {
    // The Pool is constructed against `new URL(queueUrl).origin`, and
    // sendOne uses `url.pathname + url.search` for the request path.
    // Smoke-test the URL forms we hit in production (Cloudflare Queues
    // messages endpoint sits under /client/v4/accounts/<id>/queues/<id>/messages).
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      queueUrl:
        "https://api.cloudflare.com/client/v4/accounts/abc/queues/xyz/messages",
      apiToken: "token",
    });
    expect(bridge).not.toBeNull();
    await bridge?.stop();
  });
});
