import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkConfigOnce, _resetConfigCheckForTests } from "./index.js";
import type { ControlPlaneEnv } from "./env.js";

const BASE_ENV: ControlPlaneEnv = {
  MARFA_API_URL: "http://localhost:8602",
  MARFA_RUNTIME_BROKER_KEY: "marfa_k1_broker_test",
  ENVIRONMENT: "test",
};

describe("runtime-control boot config check", () => {
  let warnCalls: string[] = [];
  const originalWarn = console.warn;

  beforeEach(() => {
    _resetConfigCheckForTests();
    warnCalls = [];
    console.warn = vi.fn((message: unknown) => {
      warnCalls.push(typeof message === "string" ? message : String(message));
    });
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it("emits one structured WARN when CLOUDFLARE_QUEUES_API_TOKEN is unset", () => {
    checkConfigOnce(BASE_ENV);

    expect(warnCalls).toHaveLength(1);
    const payload = JSON.parse(warnCalls[0] ?? "{}") as {
      level: string;
      message: string;
    };
    expect(payload.level).toBe("warn");
    expect(payload.message).toMatch(/CLOUDFLARE_QUEUES_API_TOKEN/);
    expect(payload.message).toMatch(/cf_queues_not_configured/);
  });

  it("does not emit a WARN when CLOUDFLARE_QUEUES_API_TOKEN is set", () => {
    checkConfigOnce({
      ...BASE_ENV,
      CLOUDFLARE_QUEUES_API_TOKEN: "tok_test",
      CLOUDFLARE_ACCOUNT_ID: "acc_test",
    });

    expect(warnCalls).toHaveLength(0);
  });

  it("only emits the WARN once across multiple invocations (per-isolate gate)", () => {
    checkConfigOnce(BASE_ENV);
    checkConfigOnce(BASE_ENV);
    checkConfigOnce(BASE_ENV);

    expect(warnCalls).toHaveLength(1);
  });
});
