import { describe, expect, it } from "vitest";

import {
  PORT_READY_TIMEOUT_MS,
  SERVER_PORT,
  serveThroughContainer,
  type WakeableContainer,
} from "./server-container/src/cold-start.js";

/**
 * A request arriving at a cold container is served, not refused.
 *
 * The Worker was a bare passthrough to `container.fetch(request)`. With the
 * instance scaled to zero, the request that triggers the wake came back as the
 * proxy layer's own failure — `500` carrying `Error proxying request to
 * container: The container is not running, consider calling start()`. Measured
 * from cold against production: attempt one 500 in 0.4s, attempt two 200 in
 * 12.6s, attempt three 200 in 0.7s. The 11-to-15 second wake is the accepted
 * cost of scaling to zero; answering the request that caused it with an error
 * was not.
 *
 * It is the first thing a person sees. The experimental web app's Connect
 * screen reported "Couldn't reach the default instance" purely because its
 * discovery fetch landed on a sleeping instance that was otherwise healthy, and
 * any client treating a 500 as fatal shows a broken app to the one visitor most
 * likely to be arriving fresh.
 *
 * Tests target `cold-start.ts` rather than the Worker entry, which reaches for
 * `cloudflare:workers` and the containers library at import time. Neither
 * resolves outside the Workers runtime, and `server-container` carries its own
 * `node_modules`, so a specifier mock written here resolves to a different
 * physical copy of the library and silently misses. Extracting the logic is
 * what makes it testable at all; the entry is now a thin binding with nothing
 * left to get wrong.
 */

/** A container that comes up, recording what it was asked for. */
function readyContainer(
  respondWith: (request: Request) => Promise<Response>,
): WakeableContainer & {
  waits: { ports: number; budgetMs: number }[];
  proxied: number;
} {
  const waits: { ports: number; budgetMs: number }[] = [];
  let proxied = 0;
  return {
    waits,
    get proxied() {
      return proxied;
    },
    startAndWaitForPorts(args) {
      waits.push({
        ports: args.ports,
        budgetMs: args.cancellationOptions.portReadyTimeoutMS,
      });
      return Promise.resolve();
    },
    fetch(request) {
      proxied += 1;
      return respondWith(request);
    },
  };
}

/** A container that never starts listening. */
function deadContainer(): WakeableContainer & { proxied: number } {
  let proxied = 0;
  return {
    get proxied() {
      return proxied;
    },
    startAndWaitForPorts() {
      return Promise.reject(
        new Error("There has been an internal error connecting to the port"),
      );
    },
    fetch() {
      proxied += 1;
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  };
}

describe("a cold container is woken, not reported as broken", () => {
  it("REGRESSION: waits for the port, then proxies, and returns the container's response", async () => {
    const container = readyContainer(() =>
      Promise.resolve(new Response("ok", { status: 200 })),
    );

    const res = await serveThroughContainer(
      new Request("https://api.test/items"),
      container,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(container.waits).toHaveLength(1);
    expect(container.proxied).toBe(1);
  });

  it("sends the request body exactly once, so no body needs buffering", async () => {
    // The reason the fix waits rather than retries after a failure. A retry
    // has to replay the request, replaying means holding the body, and a blob
    // upload runs to 50 MB inside a Worker — trading one failure mode for a
    // worse one.
    const seen: string[] = [];
    const container = readyContainer(async (request) => {
      seen.push(await request.text());
      return new Response(null, { status: 201 });
    });

    const res = await serveThroughContainer(
      new Request("https://api.test/blobs", {
        method: "POST",
        body: "payload",
      }),
      container,
    );

    expect(res.status).toBe(201);
    expect(seen).toEqual(["payload"]);
    expect(container.proxied).toBe(1);
  });

  it("gives up in a Marfa error shape rather than raw proxy text", async () => {
    const container = deadContainer();

    const res = await serveThroughContainer(
      new Request("https://api.test/health"),
      container,
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = (await res.json()) as { error?: { code?: string } };
    // A code is the whole point: a bare string cannot be classified, so a
    // client cannot tell "retry in a moment" from "this instance is broken".
    expect(body.error?.code).toBe("service_unavailable");
  });

  it("does not proxy at all when the container never became ready", async () => {
    // Proxying anyway would surface the original raw 500 underneath the handled
    // one, and would send a body to an instance that cannot receive it.
    const container = deadContainer();

    await serveThroughContainer(
      new Request("https://api.test/items"),
      container,
    );

    expect(container.proxied).toBe(0);
  });

  it("asks for the server's port with a bounded budget", async () => {
    // Unbounded, a container that is not coming up becomes a hung request
    // rather than an answer — which is the production case, where the database
    // was unreachable and no wait would ever have succeeded.
    const container = readyContainer(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );

    await serveThroughContainer(
      new Request("https://api.test/health"),
      container,
    );

    expect(container.waits[0]!.ports).toBe(SERVER_PORT);
    expect(container.waits[0]!.budgetMs).toBe(PORT_READY_TIMEOUT_MS);
    // Comfortably past the measured 11-to-15s wake, and finite.
    expect(PORT_READY_TIMEOUT_MS).toBeGreaterThan(20_000);
    expect(PORT_READY_TIMEOUT_MS).toBeLessThan(120_000);
    expect(SERVER_PORT).toBe(8600);
  });

  it("does not swallow a failure the container itself returns", async () => {
    // The 503 is for "could not reach the app". A 500 the app produced is the
    // app's own answer and must travel back unchanged, or every server error
    // would read as a cold start.
    const container = readyContainer(() =>
      Promise.resolve(
        Response.json({ error: { code: "internal" } }, { status: 500 }),
      ),
    );

    const res = await serveThroughContainer(
      new Request("https://api.test/items"),
      container,
    );

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "internal",
    );
  });

  it("lets a proxy rejection propagate rather than dressing it as a cold start", async () => {
    // Once the port is ready the wake question is settled, so a later failure
    // is a different problem and hiding it behind a retryable 503 would send
    // clients round a loop that cannot resolve.
    const container: WakeableContainer = {
      startAndWaitForPorts: () => Promise.resolve(),
      fetch: () => Promise.reject(new Error("socket hang up")),
    };

    await expect(
      serveThroughContainer(new Request("https://api.test/items"), container),
    ).rejects.toThrow("socket hang up");
  });
});

describe("the Worker entry stays a thin binding", () => {
  it("delegates rather than reimplementing the wait", async () => {
    // The entry cannot be imported here (platform-only imports), so this reads
    // it as text. Cheap, and it catches the regression that matters: someone
    // inlining the logic back into the entry, where it becomes untestable
    // again and drifts from what these tests pin.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const entry = readFileSync(
      fileURLToPath(
        new URL("./server-container/src/index.ts", import.meta.url),
      ),
      "utf-8",
    );

    expect(entry).toContain("serveThroughContainer");
    // The bare passthrough this replaced, and the shape of any hand-rolled
    // retry that would reintroduce body buffering.
    expect(entry).not.toMatch(/return\s+getContainer\([^)]*\)\.fetch\(/);
    expect(entry).not.toContain("arrayBuffer()");
  });
});
