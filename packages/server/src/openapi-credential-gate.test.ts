/**
 * The wrapper that hangs the credential gate off a declared route.
 *
 * `credential-door-census.test.ts` holds the real app to the rule. This holds
 * the two properties the census cannot see, because no route in the tree
 * exercises them: that the gate runs ahead of the validators the route
 * derives from its own schemas, and that a route declaring middleware of its
 * own keeps it. The second is why the wrapper prepends rather than assigns —
 * an assignment would drop that middleware silently, and the first route to
 * declare one would be the one that found out.
 */

import { describe, expect, it } from "vitest";
import { createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { createOpenAPIRouter } from "./openapi.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import type { AppEnv } from "./middleware/auth.js";

const BodySchema = z.object({ name: z.string() });

/** The app's own handler, so a thrown `MarfaError` reaches the wire as the
 *  status it carries rather than as an unhandled 500. */
function router() {
  const r = createOpenAPIRouter<AppEnv>();
  r.onError(createErrorHandler({ errorWebhookUrl: "" }));
  return r;
}

function routeConfig(path: string) {
  return createRoute({
    method: "post" as const,
    path,
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: BodySchema } } },
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ ok: z.boolean() }) },
        },
        description: "ok",
      },
    },
  });
}

describe("the credential gate on a declared route", () => {
  it("refuses a bare request before the body validator sees it", async () => {
    const app = router();
    app.openapi(routeConfig("/gate"), (c) => c.json({ ok: true }));

    const res = await app.request("/gate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("keeps middleware the route declared for itself, behind the gate", async () => {
    const seen: string[] = [];
    const ownMiddleware = createMiddleware<AppEnv>(async (_c, next) => {
      seen.push("own");
      await next();
    });

    const app = router();
    app.openapi(
      { ...routeConfig("/both"), middleware: [ownMiddleware] },
      (c) => {
        seen.push("handler");
        return c.json({ ok: true });
      },
    );

    // Bare, so the gate refuses: the route's own middleware must not have run
    // and neither must the handler. Ordering is the claim, not just presence.
    const refused = await app.request("/both", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(refused.status).toBe(401);
    expect(seen).toEqual([]);
  });
});
