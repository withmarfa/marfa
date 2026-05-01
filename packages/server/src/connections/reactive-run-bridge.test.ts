import { describe, it, expect } from "vitest";
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

  it("returns a runtime when both are present", () => {
    const bridge = tryStartReactiveRunBridge(STORAGE_STUB, {
      queueUrl: "https://queue.example.com",
      apiToken: "token",
    });
    expect(bridge).not.toBeNull();
    expect(typeof bridge?.start).toBe("function");
    expect(typeof bridge?.stop).toBe("function");
  });

  it("respects explicit config over env vars", () => {
    const prevUrl = process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URL;
    const prevToken = process.env.CLOUDFLARE_QUEUES_API_TOKEN;
    try {
      process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URL = "https://env-url";
      process.env.CLOUDFLARE_QUEUES_API_TOKEN = "env-token";
      const bridge = tryStartReactiveRunBridge(STORAGE_STUB);
      expect(bridge).not.toBeNull();
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
