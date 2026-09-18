/**
 * Static assets served from `/auth/static/*`.
 *
 *   - `GET /auth/static/auth.css` — shared auth-page stylesheet.
 *   - `GET /auth/static/password-toggle.js` — show/hide password fields.
 *   - `GET /auth/static/submit-state.js` — submitting-state + double-submit guard.
 *
 * Public routes — no bearer / cookie required. Every file is inlined
 * via TypeScript template literals (`auth-static/auth-css.ts`,
 * `auth-static/password-toggle-js.ts`,
 * `auth-static/submit-state-js.ts`) so there is no static-asset copy step
 * in the build. ETags are SHA-1 of the bytes; `If-None-Match` returns 304
 * with no body. `Cache-Control: public, max-age=3600` — browsers cache for
 * an hour but the ETag forces revalidation across deploys when bytes shift.
 */
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { AUTH_CSS } from "./auth-static/auth-css.js";
import { PASSWORD_TOGGLE_JS } from "./auth-static/password-toggle-js.js";
import { SUBMIT_STATE_JS } from "./auth-static/submit-state-js.js";

function makeAsset(body: string, contentType: string) {
  return {
    body,
    contentType,
    etag: `"${createHash("sha1").update(body).digest("hex")}"`,
    bytes: Buffer.byteLength(body, "utf-8"),
  };
}

const CSS = makeAsset(AUTH_CSS, "text/css; charset=utf-8");
const PASSWORD_TOGGLE = makeAsset(
  PASSWORD_TOGGLE_JS,
  "application/javascript; charset=utf-8",
);
const SUBMIT_STATE = makeAsset(
  SUBMIT_STATE_JS,
  "application/javascript; charset=utf-8",
);

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
  app.get("/password-toggle.js", serveAsset(PASSWORD_TOGGLE));
  app.get("/submit-state.js", serveAsset(SUBMIT_STATE));

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
