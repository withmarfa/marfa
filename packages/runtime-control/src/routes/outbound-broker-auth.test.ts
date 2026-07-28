/**
 * Every control-plane hop into a per-Integration Worker presents that
 * Worker's own identity key, and never the platform broker key.
 *
 * Two failures, opposite in character, live on this one hop.
 *
 * Present nothing and the dispatch is refused: Workers gate their whole
 * `fetch` surface, so install-time arming, uninstall-time disarming and
 * operator verify all fail across the fleet, and the only symptom is an
 * `action_required` activity row nobody is watching.
 *
 * Present the broker key and the dispatch succeeds — while handing the
 * receiving Worker a credential that mints against any Connection in any
 * tenant. That is the failure with no symptom at all, which is why the
 * source guard below asserts the absence of that env var by name rather
 * than only the presence of an `authorization` header.
 *
 * Two things make this a separate file rather than more cases in
 * `arm-schedule.test.ts` and `verify.test.ts`, which already assert the
 * header on the routes they cover:
 *
 *   - It is driven by what the code contains rather than by a list of
 *     routes someone maintained. A dispatch site added later fails the
 *     source guard below until it is covered, and a schedule route
 *     added later is swept the day it is registered. That is the same
 *     reasoning behind gating the Worker's whole fetch surface in one
 *     place instead of route by route.
 *   - Those two files are the ones a branch touching dispatch will
 *     rewrite, and a merge that resolves in favor of the larger rewrite
 *     would take their assertions with it. A file that only this side
 *     has merges cleanly and keeps asserting.
 *
 * The schedule route pattern is matched, not enumerated. If a schedule
 * route is ever named outside `<verb>-schedule`, extend the pattern
 * rather than letting the coverage quietly shrink.
 */
import { describe, it, expect } from "vitest";
import { deriveWorkerIdentityKey } from "@withmarfa/shared";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../app.js";
import type { ControlPlaneEnv } from "../env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Platform key. Held by the server and this Worker; never sent onward. */
const BROKER_KEY = "broker-key-test";
/** Root the per-Worker identity keys derive from. Held only here. */
const IDENTITY_ROOT = "worker-identity-root-test";
const INTEGRATION = "withmarfa.rss-watcher";

/**
 * Service-Binding dispatch sites, counted per route module. Every one
 * of them is exercised below. Adding an entry or raising a count here
 * without adding a case is the one way to weaken this file, so treat
 * it as a checklist rather than a formality.
 *
 * Counts rather than a set of file names. A set only notices the first
 * dispatch a module gains: a second one added inside `arm-schedule.ts`
 * or `verify.ts`, on a route outside the schedule pattern and with no
 * `authorization` header, leaves the file list identical and ships an
 * ungated hop past a guard whose whole job is to stop exactly that.
 */
const COVERED_DISPATCHES: Record<string, number> = {
  "arm-schedule.ts": 1,
  "verify.ts": 1,
};

/** `POST /connections/:connection_id/<verb>-schedule`. */
const SCHEDULE_ROUTE = /^\/connections\/:connection_id\/[a-z-]+-schedule$/;

/** Route modules, test files excluded. */
function routeModules(): string[] {
  return readdirSync(__dirname)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
}

/**
 * The argument text of every Service-Binding dispatch in a module.
 *
 * Read from source rather than driven through the app, because what is
 * being guarded is the existence of a dispatch: one added on a route
 * nothing calls yet still ships, and no request would reach it. Parens
 * are matched by depth, which holds for the shape every dispatch here
 * uses, the Request built inline at the call. A dispatch that builds
 * its Request further up fails this guard rather than passing it. For
 * a check on whether a credential is present, a call site that cannot
 * be read has to read as absent.
 */
function dispatchArguments(file: string): string[] {
  const source = readFileSync(join(__dirname, file), "utf8");
  const found: string[] = [];
  const CALL = ".fetch(";
  let from = 0;
  for (;;) {
    const call = source.indexOf(CALL, from);
    if (call === -1) return found;
    const open = call + CALL.length;
    let depth = 1;
    let i = open;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    found.push(source.slice(open, i - 1));
    from = i;
  }
}

/** Route modules that dispatch, with how many dispatches each holds. */
function dispatchSiteCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of routeModules()) {
    const sites = dispatchArguments(file).length;
    if (sites > 0) counts[file] = sites;
  }
  return counts;
}

/** Every dispatch site in the package, one entry per call. */
function dispatchSites(): { label: string; text: string }[] {
  return routeModules().flatMap((file) =>
    dispatchArguments(file).map((text, index) => ({
      label: `${file} dispatch ${String(index + 1)}`,
      text,
    })),
  );
}

function scheduleRoutePaths(): string[] {
  const app = buildApp();
  const paths = app.routes
    .filter((r) => r.method === "POST" && SCHEDULE_ROUTE.test(r.path))
    .map((r) => r.path);
  return [...new Set(paths)].sort();
}

interface BindingCall {
  url: string;
  authorization: string | null;
}

function mockBinding(responseBody: unknown = { ok: true }) {
  const calls: BindingCall[] = [];
  return {
    calls,
    fetch(req: Request) {
      calls.push({
        url: req.url,
        authorization: req.headers.get("authorization"),
      });
      return Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  };
}

/** Verify calls back into the server twice; neither hop is under test here. */
function mockMarfaFetch(): typeof fetch {
  return (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/verify-context")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            connection_id: "conn_1",
            integration_name: INTEGRATION,
            tenant_id: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

describe("every Service-Binding dispatch site is covered", () => {
  it("finds no dispatch site without a case here", () => {
    expect(dispatchSiteCounts()).toEqual(COVERED_DISPATCHES);
  });

  it("found dispatch sites to read", () => {
    // Vacuity guard. A change to how a dispatch is written that the
    // paren walk cannot follow would leave the per-site assertions
    // below iterating an empty list and passing.
    expect(dispatchSites().length).toBeGreaterThan(0);
  });

  it.each(dispatchSites())("$label carries a credential", ({ text }) => {
    // Named per site rather than per route, so a dispatch added on a
    // route the behavioral cases below do not reach is still held to
    // the contract.
    expect(text).toContain("authorization");
  });

  it.each(dispatchSites())(
    "$label does not carry the platform key",
    ({ text }) => {
      // Asserted by name, and as an absence. A dispatch that reaches for
      // `MARFA_RUNTIME_BROKER_KEY` still works — the Worker would accept
      // it if it held the same value — so nothing behavioral notices, and
      // what has actually happened is that a platform credential has been
      // handed to a Worker. The behavioral cases below check the positive
      // half; this checks the half that succeeds while being wrong.
      expect(text).not.toContain("MARFA_RUNTIME_BROKER_KEY");
    },
  );
});

describe("schedule dispatch presents the Worker's identity key onward", () => {
  it("finds the schedule routes to check", () => {
    // Vacuity guard. An empty list would make the assertions below
    // pass while checking nothing, and renaming arm-schedule out of the
    // pattern is the likeliest way to get there.
    const paths = scheduleRoutePaths();
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain("/connections/:connection_id/arm-schedule");
  });

  it.each(scheduleRoutePaths())("%s", async (routePath) => {
    const binding = mockBinding();
    const env: ControlPlaneEnv = {
      MARFA_RUNTIME_BROKER_KEY: BROKER_KEY,
      MARFA_WORKER_IDENTITY_SECRET: IDENTITY_ROOT,
      INTEGRATION_RSS_WATCHER: binding,
    };
    const app = buildApp();
    const res = await app.request(
      routePath.replace(":connection_id", "conn_1"),
      {
        method: "POST",
        body: JSON.stringify({ integration_name: INTEGRATION }),
        headers: {
          "content-type": "application/json",
          // The inbound gate here is the server's platform bearer. It
          // authorizes the route and stops: what the Worker sees is a
          // key derived for that Worker alone.
          authorization: `Bearer ${BROKER_KEY}`,
        },
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(binding.calls).toHaveLength(1);
    expect(binding.calls[0]!.authorization).toBe(
      `Bearer ${await deriveWorkerIdentityKey(IDENTITY_ROOT, INTEGRATION)}`,
    );
    expect(binding.calls[0]!.authorization).not.toBe(`Bearer ${BROKER_KEY}`);
  });
});

describe("verify dispatch presents the Worker's identity key onward", () => {
  it("POST /connections/:connection_id/verify", async () => {
    const binding = mockBinding({
      ok: true,
      handler_result: { ok: true },
      envelope_used: {},
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMarfaFetch();
    try {
      const env: ControlPlaneEnv = {
        MARFA_API_URL: "http://localhost:0",
        MARFA_RUNTIME_BROKER_KEY: BROKER_KEY,
        MARFA_WORKER_IDENTITY_SECRET: IDENTITY_ROOT,
        INTEGRATION_RSS_WATCHER: binding,
      };
      const app = buildApp();
      const res = await app.request(
        "/connections/conn_1/verify",
        {
          method: "POST",
          body: JSON.stringify({
            event: { item_id: "item_1", event_type: "item.created" },
          }),
          headers: {
            "content-type": "application/json",
            // Verify's own gate is the operator's platform bearer. It
            // authorizes the route and stops there: what the Worker
            // must see is the broker key, not this.
            authorization: "Bearer marfa_k1_op",
          },
        },
        env,
      );

      expect(res.status).toBe(200);
      expect(binding.calls).toHaveLength(1);
      expect(binding.calls[0]!.authorization).toBe(
        `Bearer ${await deriveWorkerIdentityKey(IDENTITY_ROOT, INTEGRATION)}`,
      );
      expect(binding.calls[0]!.authorization).not.toBe("Bearer marfa_k1_op");
      expect(binding.calls[0]!.authorization).not.toBe(`Bearer ${BROKER_KEY}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
