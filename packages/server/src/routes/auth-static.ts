/** Inline auth assets use content hashes in page URLs so a deployment changes
 *  the browser cache identity whenever the asset bytes change. */
import { PASSKEYS_JS } from "./auth-static/passkeys-js.js";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { AUTH_CSS } from "./auth-static/auth-css.js";
import { PASSWORD_TOGGLE_JS } from "./auth-static/password-toggle-js.js";
import { SUBMIT_STATE_JS } from "./auth-static/submit-state-js.js";
import { PAGE_ASSETS } from "../pages/assets.js";

function makeAsset(body: string, contentType: string) {
  const version = createHash("sha1").update(body).digest("hex");
  return {
    version,
    body,
    contentType,
    etag: `"${version}"`,
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

const ASSETS = {
  "pages.css": makeAsset(
    PAGE_ASSETS["pages.css"].body,
    PAGE_ASSETS["pages.css"].contentType,
  ),
  "pages.js": makeAsset(
    PAGE_ASSETS["pages.js"].body,
    PAGE_ASSETS["pages.js"].contentType,
  ),
  "auth.css": CSS,
  "password-toggle.js": PASSWORD_TOGGLE,
  "submit-state.js": SUBMIT_STATE,
  "passkeys.js": makeAsset(
    PASSKEYS_JS,
    "application/javascript; charset=utf-8",
  ),
};

export function authAssetUrl(name: keyof typeof ASSETS): string {
  return `/auth/static/${name}?v=${ASSETS[name].version}`;
}

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

  for (const [name, asset] of Object.entries(ASSETS))
    app.get(`/${name}`, serveAsset(asset));

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
