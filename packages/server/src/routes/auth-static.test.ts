import { createHash } from "node:crypto";
import { authAssetUrl } from "./auth-static.js";
import { PAGE_ASSETS, pageAssetUrl } from "../pages/assets.js";
import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * `GET /auth/static/auth.css` is the shared auth-page stylesheet.
 * Tests cover:
 *   - 200 + text/css with the bytes
 *   - Cache-Control + ETag headers present
 *   - 304 on If-None-Match match (cached revalidation path)
 *   - Different ETag returns 200
 *   - Public route (no auth required)
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

describe("GET /auth/static/auth.css", () => {
  it("returns 200 + text/css with the stylesheet", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/static/auth.css", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/css/);
    const body = await res.text();
    // A few sentinel pieces of the stylesheet — validates the bytes
    // are flowing end-to-end without asserting the entire blob.
    expect(body).toContain(":root");
    expect(body).toContain("--fg:");
    expect(body).toContain(".btn--primary");
  });

  it("sends Cache-Control: public, max-age=3600 + ETag", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/static/auth.css", {
      headers: { origin: ORIGIN },
    });
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    // Strong ETag — quoted SHA-1 hex. Length: `"` + 40 hex + `"` = 42.
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("returns 304 with no body when If-None-Match matches the ETag", async () => {
    ctx = await createTestContext();
    const first = await request(ctx.app, "GET", "/auth/static/auth.css", {
      headers: { origin: ORIGIN },
    });
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await request(ctx.app, "GET", "/auth/static/auth.css", {
      headers: { origin: ORIGIN, "if-none-match": etag ?? "" },
    });
    expect(second.status).toBe(304);
    const body = await second.text();
    expect(body).toBe("");
    // ETag still echoes on 304 so the cache stays warm across rounds.
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("returns 200 (full body) when If-None-Match differs", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/static/auth.css", {
      headers: { origin: ORIGIN, "if-none-match": '"stale-etag"' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/css/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("is public — no auth header required", async () => {
    ctx = await createTestContext();
    // Deliberately no Authorization header.
    const res = await request(ctx.app, "GET", "/auth/static/auth.css", {});
    expect(res.status).toBe(200);
  });
});

describe("GET /auth/static/password-toggle.js", () => {
  it("returns 200 + javascript with the toggle script", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/static/password-toggle.js",
      { headers: { origin: ORIGIN } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    const body = await res.text();
    // Sentinel pieces — the IIFE wraps password inputs and toggles type.
    expect(body).toContain('input[type="password"]');
    expect(body).toContain("pw-toggle");
    expect(body).toContain("Show password");
  });

  it("sends Cache-Control: public, max-age=3600 + a strong ETag", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/static/password-toggle.js",
      { headers: { origin: ORIGIN } },
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("returns 304 with no body when If-None-Match matches", async () => {
    ctx = await createTestContext();
    const first = await request(
      ctx.app,
      "GET",
      "/auth/static/password-toggle.js",
      { headers: { origin: ORIGIN } },
    );
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await request(
      ctx.app,
      "GET",
      "/auth/static/password-toggle.js",
      { headers: { origin: ORIGIN, "if-none-match": etag ?? "" } },
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("is public — no auth header required", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/static/password-toggle.js",
      {},
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /auth/static/submit-state.js", () => {
  it("returns 200 + javascript with the submit-state script", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/static/submit-state.js", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    const body = await res.text();
    // Sentinel pieces — the IIFE swaps the loading label and guards double
    // submits on POST forms.
    expect(body).toContain("data-loading-label");
    expect(body).toContain("is-loading");
    expect(body).toContain("data-submitting");
  });

  it("sends Cache-Control: public, max-age=3600 + a strong ETag", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/static/submit-state.js", {
      headers: { origin: ORIGIN },
    });
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("returns 304 with no body when If-None-Match matches", async () => {
    ctx = await createTestContext();
    const first = await request(
      ctx.app,
      "GET",
      "/auth/static/submit-state.js",
      {
        headers: { origin: ORIGIN },
      },
    );
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await request(
      ctx.app,
      "GET",
      "/auth/static/submit-state.js",
      { headers: { origin: ORIGIN, "if-none-match": etag ?? "" } },
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("is public — no auth header required", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/static/submit-state.js",
      {},
    );
    expect(res.status).toBe(200);
  });
});

it.each([
  "auth.css",
  "password-toggle.js",
  "submit-state.js",
  "passkeys.js",
] as const)("versions %s with the hash of its served bytes", async (name) => {
  ctx = await createTestContext();
  const url = authAssetUrl(name);
  const response = await ctx.app.request(url);
  expect(response.status).toBe(200);
  const hash = createHash("sha1")
    .update(await response.text())
    .digest("hex");
  expect(new URL(url, "http://localhost").searchParams.get("v")).toBe(hash);
  expect(response.headers.get("etag")).toBe(`"${hash}"`);
});

describe.each([
  ["pages.css", /text\/css/],
  ["pages.js", /javascript/],
] as const)("GET /auth/static/%s", (name, type) => {
  const path = `/auth/static/${name}`;

  it("serves the bytes the page system built, with the type, a strong ETag and the one cache rule", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", path, {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(type);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("etag")).toBe(`"${PAGE_ASSETS[name].version}"`);
    expect(await res.text()).toBe(PAGE_ASSETS[name].body);
  });

  it("is the address a page loads it from, hash included", () => {
    expect(authAssetUrl(name)).toBe(pageAssetUrl(name));
  });

  it("answers 304 with no body when the ETag matches, and 200 when it does not", async () => {
    ctx = await createTestContext();
    const cached = await request(ctx.app, "GET", path, {
      headers: { "if-none-match": `"${PAGE_ASSETS[name].version}"` },
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    const stale = await request(ctx.app, "GET", path, {
      headers: { "if-none-match": '"stale-etag"' },
    });
    expect(stale.status).toBe(200);
  });
});
