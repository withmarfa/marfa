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
 * tenant. That is the failure with no symptom at all, so what has to be
 * asserted is the absence of that value from the outgoing request.
 *
 * **Asserted on the `Request`, not on the source.** An earlier version of
 * this file read the argument text of each `.fetch(` call and checked it
 * did not mention `MARFA_RUNTIME_BROKER_KEY`. Both dispatch sites hoist
 * the header into a local first, so what that check actually read was
 * `authorization: dispatchAuthorization` — the name of a variable, never
 * its value. Switching a dispatch to the platform key through that same
 * local left it green. A check on whether a credential is the wrong one
 * has to look at the credential.
 *
 * Two things make this a separate file rather than more cases in
 * `arm-schedule.test.ts` and `verify.test.ts`, which already assert the
 * header on the routes they cover:
 *
 *   - Coverage is driven by what the code contains rather than by a list
 *     of routes someone maintained. Dispatch sites are counted from
 *     source and the count is held equal to the number of exercises
 *     below, so a site added later fails this file until it is actually
 *     driven — bumping the count alone does not buy anything. A schedule
 *     route added later is swept the day it is registered.
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
 * of them is driven by an exercise below, and the two counts are
 * asserted equal — so raising a number here without adding an exercise
 * fails rather than widening the gap it was meant to close.
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

/** The operator bearer verify's own gate accepts. Never sent onward. */
const OPERATOR_BEARER = "marfa_k1_op";

/**
 * One entry per dispatch site: drives it through the app and returns
 * what the receiving Worker was handed.
 *
 * `module` names the route module the site lives in, so the exercises
 * can be counted against the sites found in source. A site added in a
 * module with no matching exercise leaves the two counts unequal, which
 * is the only thing standing between "a dispatch exists" and "a dispatch
 * has been shown to present the right credential".
 */
interface DispatchExercise {
  module: string;
  label: string;
  run: () => Promise<BindingCall[]>;
}

const DISPATCH_EXERCISES: DispatchExercise[] = [
  {
    module: "arm-schedule.ts",
    label: "arm-schedule.ts — every schedule route",
    run: async () => {
      const calls: BindingCall[] = [];
      for (const routePath of scheduleRoutePaths()) {
        const binding = mockBinding();
        const env: ControlPlaneEnv = {
          MARFA_RUNTIME_BROKER_KEY: BROKER_KEY,
          MARFA_WORKER_IDENTITY_SECRET: IDENTITY_ROOT,
          INTEGRATION_RSS_WATCHER: binding,
        };
        const res = await buildApp().request(
          routePath.replace(":connection_id", "conn_1"),
          {
            method: "POST",
            body: JSON.stringify({ integration_name: INTEGRATION }),
            headers: {
              "content-type": "application/json",
              // The inbound gate here is the server's platform bearer.
              // It authorizes the route and stops: what the Worker sees
              // is a key derived for that Worker alone.
              authorization: `Bearer ${BROKER_KEY}`,
            },
          },
          env,
        );
        expect(res.status).toBe(200);
        expect(binding.calls).toHaveLength(1);
        calls.push(...binding.calls);
      }
      return calls;
    },
  },
  {
    module: "verify.ts",
    label: "verify.ts — POST /connections/:connection_id/verify",
    run: async () => {
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
        const res = await buildApp().request(
          "/connections/conn_1/verify",
          {
            method: "POST",
            body: JSON.stringify({
              event: { item_id: "item_1", event_type: "item.created" },
            }),
            headers: {
              "content-type": "application/json",
              // Verify's own gate is the operator's platform bearer. It
              // authorizes the route and stops there.
              authorization: `Bearer ${OPERATOR_BEARER}`,
            },
          },
          env,
        );
        expect(res.status).toBe(200);
        expect(binding.calls).toHaveLength(1);
        return binding.calls;
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
];

/** Exercises per route module, to be held equal to the sites in source. */
function exerciseCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { module } of DISPATCH_EXERCISES) {
    counts[module] = (counts[module] ?? 0) + 1;
  }
  return counts;
}

describe("every Service-Binding dispatch site is exercised", () => {
  it("finds no dispatch site without an exercise", () => {
    // Two independent readings of the same set: what the source
    // contains, and what this file actually drives. The checklist in
    // `COVERED_DISPATCHES` is what ties them together, and it is only
    // load-bearing because both are compared against it.
    expect(dispatchSiteCounts()).toEqual(COVERED_DISPATCHES);
    expect(exerciseCounts()).toEqual(COVERED_DISPATCHES);
  });

  it("finds the schedule routes to check", () => {
    // Vacuity guard for the schedule exercise, which sweeps a pattern
    // rather than a list. An empty sweep would leave it asserting
    // nothing, and renaming arm-schedule out of the pattern is the
    // likeliest way to get there.
    const paths = scheduleRoutePaths();
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain("/connections/:connection_id/arm-schedule");
  });

  it.each(DISPATCH_EXERCISES)(
    "$label presents the Worker's own key and nothing else",
    async ({ run }) => {
      const calls = await run();
      // Vacuity guard per exercise: an exercise that stops reaching its
      // dispatch would otherwise pass over an empty list.
      expect(calls.length).toBeGreaterThan(0);
      const expected = `Bearer ${await deriveWorkerIdentityKey(IDENTITY_ROOT, INTEGRATION)}`;
      for (const call of calls) {
        expect(call.authorization).toBe(expected);
        // The value, not the name of whatever variable carried it. This
        // is the assertion the source-text version could not make, and
        // the one that catches a dispatch reaching for the platform key
        // through a local.
        expect(call.authorization ?? "").not.toContain(BROKER_KEY);
        expect(call.authorization ?? "").not.toContain(OPERATOR_BEARER);
      }
    },
  );
});

describe("dispatch source lint", () => {
  // A lint, not a proof. It reads the argument text of each `.fetch(`
  // call, so it can only see what is written literally at the call site
  // — a dispatch that hoists its header into a local, which both of
  // today's do, shows this check a variable name. It is kept because it
  // is free and catches the careless inline form early; the guarantee
  // comes from the behavioral cases above.
  it("found dispatch sites to read", () => {
    expect(dispatchSites().length).toBeGreaterThan(0);
  });

  it.each(dispatchSites())(
    "$label mentions an authorization header",
    ({ text }) => {
      expect(text).toContain("authorization");
    },
  );

  it.each(dispatchSites())(
    "$label does not name the platform key inline",
    ({ text }) => {
      expect(text).not.toContain("MARFA_RUNTIME_BROKER_KEY");
    },
  );
});
