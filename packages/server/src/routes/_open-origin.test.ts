import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../test-utils.js";
import { OPEN_TO_EVERY_ORIGIN } from "./_open-origin.js";

const FOREIGN = "https://foreign.example";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("the operations open to every origin", () => {
  it("names only operations the app serves", () => {
    const served = new Set(
      ctx.app.routes.map((route) => `${route.method} ${route.path}`),
    );
    for (const [path, methods] of OPEN_TO_EVERY_ORIGIN) {
      for (const method of methods) {
        // Registration is served by the sign-in library behind `/auth/*`.
        const key =
          served.has(`${method} ${path}`) || !path.startsWith("/auth/")
            ? `${method} ${path}`
            : `${method} /auth/*`;
        expect(served, `${method} ${path}`).toContain(key);
      }
    }
  });

  it("answers every origin with * on exactly those, and on no other path the app serves", async () => {
    const paths = new Set(
      ctx.app.routes
        .filter((route) => route.method === "GET" || route.method === "POST")
        .map((route) => route.path)
        .filter((path) => !path.includes(":") && !path.includes("*")),
    );
    for (const path of OPEN_TO_EVERY_ORIGIN.keys()) paths.add(path);
    expect(paths.size).toBeGreaterThan(20);
    for (const path of paths) {
      const method = OPEN_TO_EVERY_ORIGIN.get(path)?.[0] ?? "GET";
      const asked = await ctx.app.request(path, {
        method: "OPTIONS",
        headers: {
          origin: FOREIGN,
          "access-control-request-method": method,
          "access-control-request-headers": "content-type",
        },
      });
      const open = OPEN_TO_EVERY_ORIGIN.has(path);
      expect(asked.headers.get("access-control-allow-origin"), path).toBe(
        open ? "*" : null,
      );
      expect(asked.headers.get("access-control-allow-credentials"), path).toBe(
        null,
      );
    }
  });

  it.each([
    ["another origin", FOREIGN],
    ["the instance's own origin", "http://localhost:0"],
  ])(
    "registers a client from %s carrying the owner's session cookie, as one without it",
    async (_where, origin) => {
      expect(new URL(ctx.config.authBaseUrl).origin === origin).toBe(
        origin !== FOREIGN,
      );
      const register = (cookie?: string) =>
        ctx.app.request("/auth/oauth2/register", {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            ...(cookie === undefined ? {} : { cookie }),
          },
          body: JSON.stringify({
            client_name: "Foreign Page",
            redirect_uris: [`${FOREIGN}/callback`],
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        });
      const withCookie = await register(ctx.owner.cookie);
      expect(withCookie.status).toBe(201);
      const { client_id: clientId } = (await withCookie.json()) as {
        client_id: string;
      };
      const s = ctx.storage as unknown as {
        __sqliteAll: (q: string) => Promise<{ user_id: string | null }[]>;
      };
      const rows = await s.__sqliteAll(
        `SELECT user_id FROM auth_oauth_client WHERE client_id = '${clientId}'`,
      );
      expect(rows).toEqual([{ user_id: null }]);
      expect((await register()).status).toBe(201);
    },
  );
});
