/**
 * The refusal of a query key a route does not declare, as
 * `createOpenAPIRouter` installs it.
 *
 * `routes/undeclared-query-key-census.test.ts` holds the real app to the rule
 * on every door. This holds the properties of the wrapper itself: what is
 * refused and what is not, the shape of the refusal, and where in the chain
 * it stands.
 */

import { describe, expect, it } from "vitest";
import { createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { ErrorCode, MarfaError, type ApiKey } from "@withmarfa/shared";
import { createOpenAPIRouter } from "./openapi.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import type { AppEnv } from "./middleware/auth.js";
import { takesQueryKeysLike } from "./middleware/undeclared-query-keys.js";

const OK = {
  200: {
    content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    description: "ok",
  },
};

interface Refusal {
  error: {
    code: string;
    message: string;
    details?: { unknown_parameters?: string[] };
  };
}

/** A router whose requests carry a credential, unless they say otherwise. */
function router() {
  const r = createOpenAPIRouter<AppEnv>();
  r.onError(createErrorHandler({ errorWebhookUrl: "" }));
  r.use("*", async (c, next) => {
    if (c.req.header("X-Test-Anonymous") === undefined) {
      c.set("apiKey", { id: "key" } as ApiKey);
    }
    await next();
  });
  return r;
}

const listing = createRoute({
  method: "get" as const,
  path: "/listing",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      state: z.enum(["active", "trashed"]).optional(),
      limit: z.coerce.number().optional(),
    }),
  },
  responses: OK,
});

const noQuery = createRoute({
  method: "get" as const,
  path: "/no-query",
  security: [{ bearerAuth: [] }],
  responses: OK,
});

async function refusalOf(res: Response): Promise<Refusal> {
  return (await res.json()) as Refusal;
}

describe("a query key the route does not declare", () => {
  it("is refused 400 and named, where the validator alone would have dropped it", async () => {
    const app = router();
    let reached = false;
    app.openapi(listing, (c) => {
      reached = true;
      return c.json({ ok: true }, 200);
    });

    // The witness: the same request without the stray key is served, so the
    // refusal below is the key's and not the route's.
    const served = await app.request("/listing?state=active");
    expect(served.status).toBe(200);
    expect(reached).toBe(true);

    reached = false;
    const res = await app.request("/listing?state=active&stat=trashed");
    expect(res.status).toBe(400);
    const body = await refusalOf(res);
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details?.unknown_parameters).toEqual(["stat"]);
    expect(body.error.message).toContain('"stat"');
    expect(body.error.message).toContain("limit, state");
    expect(reached).toBe(false);
  });

  it("names every unknown key once, however often it is repeated", async () => {
    const app = router();
    app.openapi(listing, (c) => c.json({ ok: true }, 200));
    const res = await app.request("/listing?a=1&b=2&a=3");
    expect(res.status).toBe(400);
    expect((await refusalOf(res)).error.details?.unknown_parameters).toEqual([
      "a",
      "b",
    ]);
  });

  it("is refused on a route that declares no query at all", async () => {
    const app = router();
    app.openapi(noQuery, (c) => c.json({ ok: true }, 200));
    expect((await app.request("/no-query")).status).toBe(200);
    const res = await app.request("/no-query?anything=1");
    expect(res.status).toBe(400);
    const body = await refusalOf(res);
    expect(body.error.details?.unknown_parameters).toEqual(["anything"]);
    expect(body.error.message).toContain("takes no query parameters");
  });

  it("is refused on a route that declares no credential", async () => {
    const app = router();
    app.openapi(
      createRoute({
        method: "get" as const,
        path: "/open",
        responses: OK,
      }),
      (c) => c.json({ ok: true }, 200),
    );
    expect((await app.request("/open")).status).toBe(200);
    expect((await app.request("/open?x=1")).status).toBe(400);
  });

  it("is let through when it starts with an underscore", async () => {
    const app = router();
    app.openapi(listing, (c) => c.json({ ok: true }, 200));
    expect((await app.request("/listing?_cache=1")).status).toBe(200);
    // A misspelling of a real key is not a client's own.
    expect((await app.request("/listing?_state=1&stat=1")).status).toBe(400);
  });

  it("is let through when the route says it takes keys of that kind, and only that route", async () => {
    const app = router();
    app.openapi(
      takesQueryKeysLike(listing, {
        pattern: /^edge\[[^\]]+\]$/,
        spelling: "edge[<type>]",
      }),
      (c) => c.json({ ok: true }, 200),
    );
    app.openapi(noQuery, (c) => c.json({ ok: true }, 200));

    expect((await app.request("/listing?edge[parent-of]=x")).status).toBe(200);
    const stray = await app.request("/listing?edge=x&edge[a]=1");
    expect(stray.status).toBe(400);
    const body = await refusalOf(stray);
    expect(body.error.details?.unknown_parameters).toEqual(["edge"]);
    expect(body.error.message).toContain("edge[<type>]");
    expect((await app.request("/no-query?edge[parent-of]=x")).status).toBe(400);
  });
});

describe("where the refusal stands in the chain", () => {
  it("answers a bare request 401, whatever its query says", async () => {
    const app = router();
    app.openapi(listing, (c) => c.json({ ok: true }, 200));
    const res = await app.request("/listing?stat=1", {
      headers: { "X-Test-Anonymous": "1" },
    });
    expect(res.status).toBe(401);
  });

  it("answers a credential the door turns away 403, whatever its query says", async () => {
    const app = router();
    const turnedAway = createMiddleware<AppEnv>(() =>
      Promise.reject(
        new MarfaError(ErrorCode.FORBIDDEN, "This door is not yours"),
      ),
    );
    app.openapi({ ...listing, middleware: [turnedAway] }, (c) =>
      c.json({ ok: true }, 200),
    );
    const res = await app.request("/listing?stat=1");
    expect(res.status).toBe(403);
  });

  it("stands ahead of the validators, which would have refused a bad value first", async () => {
    const app = router();
    app.openapi(listing, (c) => c.json({ ok: true }, 200));
    const res = await app.request("/listing?state=nonsense&stat=1");
    expect(res.status).toBe(400);
    expect((await refusalOf(res)).error.details?.unknown_parameters).toEqual([
      "stat",
    ]);
  });
});

describe("a route whose query schema cannot be read", () => {
  it("is refused when it is registered, not by refusing every key later", () => {
    const app = router();
    expect(() =>
      app.openapi(
        createRoute({
          method: "get" as const,
          path: "/odd",
          request: { query: z.string() as never },
          responses: OK,
        }),
        (c) => c.json({ ok: true }, 200),
      ),
    ).toThrow(/object schema/);
  });
});
