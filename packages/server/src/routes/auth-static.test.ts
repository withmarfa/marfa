import { authAssetUrl } from "./auth-static.js";
import { PAGE_ASSETS, pageAssetUrl } from "../pages/assets.js";
import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
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
