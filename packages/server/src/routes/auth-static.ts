/**
 * Static assets served from `/auth/static/*`.
 *
 * Wave C PR4 — `GET /auth/static/auth.css` (the shared auth-page
 * stylesheet).
 * Wave C PR6 / T-034 — `GET /auth/static/passkey.js` (browser-side
 * WebAuthn ceremony).
 *
 * Public routes — no bearer / cookie required. The CSS is needed by
 * every auth page; the passkey JS is needed by `/auth/sign-in` and
 * `/auth/passkey/enroll`. Both bundles are bundled into the build
 * via TypeScript template literals (see `auth-static/auth-css.ts`,
 * `auth-static/passkey-js.ts`) so there's no static-asset copy step
 * in tsup. ETags are SHA-1 of the bytes; `If-None-Match` returns 304
 * with no body. `Cache-Control: public, max-age=3600` — browsers
 * cache for an hour but the ETag forces revalidation across deploys
 * when bytes shift.
 */
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { AUTH_CSS } from "./auth-static/auth-css.js";
import { PASSKEY_JS } from "./auth-static/passkey-js.js";

function makeAsset(body: string, contentType: string) {
  return {
    body,
    contentType,
    etag: `"${createHash("sha1").update(body).digest("hex")}"`,
    bytes: Buffer.byteLength(body, "utf-8"),
  };
}

const CSS = makeAsset(AUTH_CSS, "text/css; charset=utf-8");
const JS = makeAsset(PASSKEY_JS, "application/javascript; charset=utf-8");

export function authStaticRoutes(): Hono {
  const app = new Hono();

  function serveAsset(
    asset: ReturnType<typeof makeAsset>,
  ): (c: AssetCtx) => Response {
    return (c) => {
      const ifNoneMatch = c.req.header("if-none-match");
      if (ifNoneMatch === asset.etag) {
        return c.body(null, 304, {
          ETag: asset.etag,
          "Cache-Control": "public, max-age=3600",
        });
      }
      return c.body(asset.body, 200, {
        "Content-Type": asset.contentType,
        "Content-Length": String(asset.bytes),
        ETag: asset.etag,
        "Cache-Control": "public, max-age=3600",
      });
    };
  }

  app.get("/auth.css", serveAsset(CSS));
  app.get("/passkey.js", serveAsset(JS));

  return app;
}

// Narrow Hono context shape used by `serveAsset`. Avoids dragging the
// full `Context<Env>` generic in here when the handler only needs
// `req.header` + `body()`.
interface AssetCtx {
  req: { header: (name: string) => string | undefined };
  body: (
    body: string | null,
    status: number,
    headers: Record<string, string>,
  ) => Response;
}
