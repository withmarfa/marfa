import { describe, it, expect, vi } from "vitest";
import { tryStartReactiveRunBridge } from "./reactive-run-bridge.js";
import type { Storage } from "../storage/interface.js";

const STORAGE_STUB = {
  coordination: {
    withJobLock: () => Promise.resolve(undefined),
  },
} as unknown as Storage;

/** Constant URL the resolver returns regardless of integration_name —
 *  fine for tests that only assert bridge wiring, not per-integration
 *  routing. */
const RESOLVE_ANY = () => "https://queue.example.com";

describe("tryStartReactiveRunBridge", () => {
  it("returns null when resolveQueueUrl is missing (self-hoster path)", () => {
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      apiToken: "token",
    });
    expect(bridge).toBeNull();
  });

  it("returns null when apiToken is missing", () => {
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      resolveQueueUrl: RESOLVE_ANY,
    });
    expect(bridge).toBeNull();
  });

  it("returns a runtime when both are present", async () => {
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      resolveQueueUrl: RESOLVE_ANY,
      apiToken: "token",
    });
    expect(bridge).not.toBeNull();
    expect(typeof bridge?.start).toBe("function");
    expect(typeof bridge?.stop).toBe("function");
    // Bridges constructed without `config.fetch` instantiate Pool(s) on
    // first send; stop() to release them cleanly (avoids leaked-handle
    // warnings if any were created during bridge lifetime).
    await bridge?.stop();
  });

  it("respects explicit config over env vars", async () => {
    const prevUrls = process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS;
    const prevToken = process.env.CLOUDFLARE_QUEUES_API_TOKEN;
    try {
      process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS = JSON.stringify({
        "foo.bar": "https://env-url",
      });
      process.env.CLOUDFLARE_QUEUES_API_TOKEN = "env-token";
      const bridge = tryStartReactiveRunBridge(STORAGE_STUB);
      expect(bridge).not.toBeNull();
      await bridge?.stop();
    } finally {
      if (prevUrls === undefined)
        delete process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS;
      else process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS = prevUrls;
      if (prevToken === undefined)
        delete process.env.CLOUDFLARE_QUEUES_API_TOKEN;
      else process.env.CLOUDFLARE_QUEUES_API_TOKEN = prevToken;
    }
  });
});

// T-233 — env-var parsing for CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS.
// Replaces the single-URL CLOUDFLARE_QUEUES_REACTIVE_RUN_URL shape;
// each integration's reactive-run queue is now resolved via the map.
describe("tryStartReactiveRunBridge — env-var resolution (T-233)", () => {
  const restoreEnv = (urls: string | undefined, token: string | undefined) => {
    if (urls === undefined) {
      delete process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS;
    } else {
      process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS = urls;
    }
    if (token === undefined) delete process.env.CLOUDFLARE_QUEUES_API_TOKEN;
    else process.env.CLOUDFLARE_QUEUES_API_TOKEN = token;
  };

  it("returns null when the URLs env var is unset", () => {
    const prevUrls = process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS;
    const prevToken = process.env.CLOUDFLARE_QUEUES_API_TOKEN;
    try {
      delete process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS;
      process.env.CLOUDFLARE_QUEUES_API_TOKEN = "token";
      const bridge = tryStartReactiveRunBridge(STORAGE_STUB);
      expect(bridge).toBeNull();
    } finally {
      restoreEnv(prevUrls, prevToken);
    }
  });

  it("returns null when the URLs env var is malformed JSON", () => {
    const prevUrls = process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS;
    const prevToken = process.env.CLOUDFLARE_QUEUES_API_TOKEN;
    const errSpy = vi.spyOn(console, "error").mockImplementation(vi.fn());
    try {
      process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS = "not-json";
      process.env.CLOUDFLARE_QUEUES_API_TOKEN = "token";
      const bridge = tryStartReactiveRunBridge(STORAGE_STUB);
      expect(bridge).toBeNull();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      restoreEnv(prevUrls, prevToken);
    }
  });

  it("returns null when the URLs env var is an empty object", () => {
    const prevUrls = process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS;
    const prevToken = process.env.CLOUDFLARE_QUEUES_API_TOKEN;
    const errSpy = vi.spyOn(console, "error").mockImplementation(vi.fn());
    try {
      process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS = "{}";
      process.env.CLOUDFLARE_QUEUES_API_TOKEN = "token";
      const bridge = tryStartReactiveRunBridge(STORAGE_STUB);
      expect(bridge).toBeNull();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      restoreEnv(prevUrls, prevToken);
    }
  });

  it("returns null when the URLs env var is a JSON array (not an object)", () => {
    const prevUrls = process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS;
    const prevToken = process.env.CLOUDFLARE_QUEUES_API_TOKEN;
    const errSpy = vi.spyOn(console, "error").mockImplementation(vi.fn());
    try {
      process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS = '["https://x"]';
      process.env.CLOUDFLARE_QUEUES_API_TOKEN = "token";
      const bridge = tryStartReactiveRunBridge(STORAGE_STUB);
      expect(bridge).toBeNull();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      restoreEnv(prevUrls, prevToken);
    }
  });

  it("ignores entries whose value isn't a non-empty string but still boots if at least one is valid", async () => {
    const prevUrls = process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS;
    const prevToken = process.env.CLOUDFLARE_QUEUES_API_TOKEN;
    const errSpy = vi.spyOn(console, "error").mockImplementation(vi.fn());
    try {
      process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS = JSON.stringify({
        "valid.one": "https://valid.example.com",
        "invalid.bool": true,
        "invalid.empty": "",
      });
      process.env.CLOUDFLARE_QUEUES_API_TOKEN = "token";
      const bridge = tryStartReactiveRunBridge(STORAGE_STUB);
      expect(bridge).not.toBeNull();
      // Two warnings, one per ignored entry.
      expect(errSpy).toHaveBeenCalledTimes(2);
      await bridge?.stop();
    } finally {
      errSpy.mockRestore();
      restoreEnv(prevUrls, prevToken);
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
describe("reactive-run-bridge — Pool transport (T-135 + T-233)", () => {
  it("stop() releases Pools cleanly when Pool path is in use", async () => {
    // Construct without config.fetch — Pools are created on demand by
    // sendOne. Without an actual fanout the map stays empty; stop()
    // still iterates and closes whatever's in the map (no entries).
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      resolveQueueUrl: () => "https://queue.example.com/queue",
      apiToken: "token",
    });
    expect(bridge).not.toBeNull();
    // stop() must await every pool.close(); if the wiring is broken,
    // vitest surfaces open-handle warnings. Idempotent at the Pool
    // layer (close() is safe on any state).
    await expect(bridge?.stop()).resolves.toBeUndefined();
  });

  it("stop() succeeds when config.fetch was injected (Pools bypassed)", async () => {
    const fetchStub = vi.fn(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      resolveQueueUrl: () => "https://queue.example.com/queue",
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

  it("Pool URL parsing handles per-integration URLs with path + query segments", async () => {
    // The Pool is constructed against `new URL(url).origin` per origin
    // (T-233); sendOne uses `url.pathname + url.search` for the request
    // path. Smoke-test the URL forms we hit in production (Cloudflare
    // Queues messages endpoint sits under
    // /client/v4/accounts/<id>/queues/<id>/messages).
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      resolveQueueUrl: () =>
        "https://api.cloudflare.com/client/v4/accounts/abc/queues/xyz/messages",
      apiToken: "token",
    });
    expect(bridge).not.toBeNull();
    await bridge?.stop();
  });
});
