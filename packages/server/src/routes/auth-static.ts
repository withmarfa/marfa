/**
 * `GET /auth/static/auth.css` — the shared auth-page stylesheet.
 *
 * Wave C PR4. Public route — no bearer / cookie required, anyone
 * landing on `/auth/sign-in` must be able to fetch the stylesheet.
 *
 * The CSS body is bundled into the build (see `auth-static/auth-css.ts`)
 * so there's no static-asset copy step in tsup. ETag is a SHA-1 of
 * the bytes; `If-None-Match` returns 304 with no body.
 * `Cache-Control: public, max-age=3600` — browsers cache for an hour
 * but the ETag forces revalidation across deploys when the bytes
 * shift.
 */
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { AUTH_CSS } from "./auth-static/auth-css.js";

const cssEtag = `"${createHash("sha1").update(AUTH_CSS).digest("hex")}"`;
const cssBytes = Buffer.byteLength(AUTH_CSS, "utf-8");

export function authStaticRoutes(): Hono {
  const app = new Hono();

  app.get("/auth.css", (c) => {
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch === cssEtag) {
      return c.body(null, 304, {
        ETag: cssEtag,
        "Cache-Control": "public, max-age=3600",
      });
    }
    return c.body(AUTH_CSS, 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Content-Length": String(cssBytes),
      ETag: cssEtag,
      "Cache-Control": "public, max-age=3600",
    });
  });

  return app;
}
