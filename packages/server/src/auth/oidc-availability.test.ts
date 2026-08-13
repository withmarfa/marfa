import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resilientGenericOAuth } from "./oidc-availability.js";

/**
 * The retry loop is driven by an injected scheduler rather than by
 * elapsed time. Every case here asserts on the condition it cares about
 * after firing the scheduler deliberately, so nothing depends on how
 * busy the machine is.
 */
function manualScheduler() {
  const queued: (() => void)[] = [];
  const delays: number[] = [];
  return {
    schedule: (fn: () => void, delayMs: number) => {
      queued.push(fn);
      delays.push(delayMs);
      return {
        cancel: () => {
          const at = queued.indexOf(fn);
          if (at >= 0) queued.splice(at, 1);
        },
      };
    },
    /** Fire every pending retry and wait for it to settle. */
    fire: async () => {
      const due = queued.splice(0, queued.length);
      for (const fn of due) fn();
      // The scheduled work is async; yield until its promise chain drains.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    },
    pending: () => queued.length,
    delays: () => [...delays],
  };
}

/** Discovery documents are fetched over the network by the library, so a
 *  provider is made reachable or unreachable by what `fetch` answers. */
function discoveryDocument(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    id_token_signing_alg_values_supported: ["RS256"],
  };
}

/** The slice of better-auth's context the plugin reads. */
function fakeContext() {
  return {
    socialProviders: [{ id: "builtin" }],
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    baseURL: "https://marfa.example",
  };
}

const realFetch = globalThis.fetch;

/** `fetch` accepts a string, a URL or a Request; only the last needs a
 *  property read rather than a conversion. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("federated providers degrade instead of taking the server down", () => {
  let reachable: Set<string>;

  beforeEach(() => {
    reachable = new Set<string>();
    const stub: typeof fetch = (input) => {
      const issuer = urlOf(input).replace(
        "/.well-known/openid-configuration",
        "",
      );
      if (!reachable.has(issuer)) {
        return Promise.reject(new Error("connect ECONNREFUSED"));
      }
      return Promise.resolve(
        new Response(JSON.stringify(discoveryDocument(issuer)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    globalThis.fetch = stub;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("keeps the reachable providers when one cannot be reached", async () => {
    reachable.add("https://up.example");
    const scheduler = manualScheduler();
    const oidc = resilientGenericOAuth({
      providers: [
        {
          providerId: "down",
          clientId: "c",
          clientSecret: "s",
          discoveryUrl: "https://down.example/.well-known/openid-configuration",
        },
        {
          providerId: "up",
          clientId: "c",
          clientSecret: "s",
          discoveryUrl: "https://up.example/.well-known/openid-configuration",
        },
      ],
      scheduler: scheduler.schedule,
    });

    const ctx = fakeContext();
    // The whole point: this resolves. Before the per-provider split, one
    // unreachable discovery URL rejected inside plugin init, escaped
    // where no caller could reach it, and terminated the process.
    const init = (
      oidc.plugin as unknown as {
        init: (
          c: unknown,
        ) => Promise<{ context: { socialProviders: unknown[] } }>;
      }
    ).init;
    const result = await init(ctx);

    const ids = result.context.socialProviders.map(
      (p) => (p as { id: string }).id,
    );
    expect(ids).toContain("up");
    expect(ids).toContain("builtin");
    expect(ids).not.toContain("down");

    const health = oidc.snapshot();
    expect(health.find((p) => p.provider_id === "up")?.status).toBe("ok");
    const down = health.find((p) => p.provider_id === "down");
    expect(down?.status).toBe("unavailable");
    expect(down?.error).toBeTruthy();
    expect(down?.attempts).toBe(1);
    expect(down?.unavailable_since).toBeTruthy();

    oidc.stop();
  });

  it("retries a degraded provider and serves it once it answers", async () => {
    const scheduler = manualScheduler();
    const oidc = resilientGenericOAuth({
      providers: [
        {
          providerId: "flaky",
          clientId: "c",
          clientSecret: "s",
          discoveryUrl:
            "https://flaky.example/.well-known/openid-configuration",
        },
      ],
      scheduler: scheduler.schedule,
    });

    const ctx = fakeContext();
    const init = (
      oidc.plugin as unknown as {
        init: (
          c: unknown,
        ) => Promise<{ context: { socialProviders: unknown[] } }>;
      }
    ).init;
    const result = await init(ctx);
    const live = result.context.socialProviders;

    expect(oidc.snapshot()[0]?.status).toBe("unavailable");
    expect(scheduler.pending()).toBe(1);

    // Still unreachable: the retry fails and schedules another. A
    // degradation that gave up would cost the same manual intervention
    // that refusing to boot does.
    await scheduler.fire();
    expect(oidc.snapshot()[0]?.status).toBe("unavailable");
    expect(oidc.snapshot()[0]?.attempts).toBe(2);
    expect(scheduler.pending()).toBe(1);

    // The provider comes back.
    reachable.add("https://flaky.example");
    await scheduler.fire();

    expect(oidc.snapshot()[0]?.status).toBe("ok");
    expect(oidc.snapshot()[0]?.error).toBeUndefined();
    // Recovery lands in the array better-auth is already holding, so a
    // request in flight sees it without the instance being rebuilt.
    expect(live.map((p) => (p as { id: string }).id)).toContain("flaky");
    expect(scheduler.pending()).toBe(0);

    oidc.stop();
  });

  it("degrades the only configured provider rather than refusing to start", async () => {
    const scheduler = manualScheduler();
    const oidc = resilientGenericOAuth({
      providers: [
        {
          providerId: "sole",
          clientId: "c",
          clientSecret: "s",
          discoveryUrl: "https://sole.example/.well-known/openid-configuration",
        },
      ],
      scheduler: scheduler.schedule,
    });

    const init = (
      oidc.plugin as unknown as {
        init: (
          c: unknown,
        ) => Promise<{ context: { socialProviders: unknown[] } }>;
      }
    ).init;
    await expect(init(fakeContext())).resolves.toBeTruthy();
    expect(oidc.statusOf("sole")?.status).toBe("unavailable");
    // Still retrying — the awkward case gets no special handling.
    expect(scheduler.pending()).toBe(1);

    oidc.stop();
  });

  it("stops retrying when asked, so nothing outlives its server", async () => {
    const scheduler = manualScheduler();
    const oidc = resilientGenericOAuth({
      providers: [
        {
          providerId: "gone",
          clientId: "c",
          clientSecret: "s",
          discoveryUrl: "https://gone.example/.well-known/openid-configuration",
        },
      ],
      scheduler: scheduler.schedule,
    });

    const init = (
      oidc.plugin as unknown as {
        init: (
          c: unknown,
        ) => Promise<{ context: { socialProviders: unknown[] } }>;
      }
    ).init;
    await init(fakeContext());
    expect(scheduler.pending()).toBe(1);

    oidc.stop();
    expect(scheduler.pending()).toBe(0);

    await scheduler.fire();
    expect(scheduler.pending()).toBe(0);
  });
});
