import {
  PAGE_CSS,
  PAGE_CSS_VERSION,
  PAGE_JS,
  PAGE_JS_VERSION,
} from "./assets.generated.js";

/**
 * The files every page loads, as built by `scripts/build-page-assets.ts`.
 * `version` is the SHA-1 of the body, which is also the file's cache identity:
 * a page names the file by it, so a deployment that changes the bytes changes
 * the URL.
 */
export const PAGE_ASSETS = {
  "pages.css": {
    body: PAGE_CSS,
    version: PAGE_CSS_VERSION,
    contentType: "text/css; charset=utf-8",
  },
  "pages.js": {
    body: PAGE_JS,
    version: PAGE_JS_VERSION,
    contentType: "application/javascript; charset=utf-8",
  },
} as const;

export type PageAssetName = keyof typeof PAGE_ASSETS;

/** Where a page loads `name` from: the static route that serves it, with its version. */
export function pageAssetUrl(name: PageAssetName): string {
  return `/auth/static/${name}?v=${PAGE_ASSETS[name].version}`;
}
