/**
 * A browser navigation that fails gets a page; everything else gets JSON.
 *
 * Every error this server produced was JSON, including the ones a person
 * reaches by hand. A mistyped path answered with a raw `{"error":…}` blob in
 * the viewport, which reads as the site being broken rather than the address
 * being wrong, and offers nothing to do next. An unmatched route was worse:
 * it never throws, so it never reached the error handler at all and came back
 * as Hono's bare `404 Not Found` in plain text.
 *
 * **The load-bearing property is that the API contract did not move.** These
 * tests spend as much effort proving JSON clients are unaffected as they do
 * proving the page exists, because the failure mode of content negotiation is
 * silently changing what an API returns.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { prefersHtml, renderHttpErrorPage } from "./http-error-page.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

describe("prefersHtml", () => {
  it("says yes to a browser navigation", () => {
    expect(
      prefersHtml(
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
      ),
    ).toBe(true);
  });

  it("says no to the default fetch and curl header", () => {
    // `*/*` is what every non-browser sends. Treating it as a request for
    // HTML would turn the entire API into a page renderer, which is the one
    // way this change could do real damage.
    expect(prefersHtml("*/*")).toBe(false);
    expect(prefersHtml(undefined)).toBe(false);
  });

  it("says no when the client asks for JSON", () => {
    expect(prefersHtml("application/json")).toBe(false);
  });

  it("resolves a client naming both by which it puts first", () => {
    expect(prefersHtml("application/json, text/html")).toBe(false);
    expect(prefersHtml("text/html, application/json")).toBe(true);
  });
});

describe("the rendered page", () => {
  it("uses the shared layout and carries no request-supplied text", () => {
    const html = renderHttpErrorPage(404);
    expect(html).toContain('href="/auth/static/auth.css"');
    expect(html).toContain("<title>Page not found</title>");
    // Parameterless beyond the status, deliberately: an error page is
    // reachable on any path with any query, so every value from the request
    // is a value an attacker chose. Fixed copy is what makes it safe.
    expect(renderHttpErrorPage(404)).toBe(html);
  });

  it("says something different for the classes a person can act on", () => {
    // A person does not need to know which of forty codes fired. They need
    // to know whether the thing exists, whether they may have it, and
    // whether waiting helps — so the copy keys on the status class.
    const notFound = renderHttpErrorPage(404);
    const forbidden = renderHttpErrorPage(403);
    const rateLimited = renderHttpErrorPage(429);
    const server = renderHttpErrorPage(500);
    const all = [notFound, forbidden, rateLimited, server];
    expect(new Set(all).size).toBe(4);
    expect(server).toContain("ours, not yours");
  });
});

describe("content negotiation end to end", () => {
  it("an unmatched path gives a browser a page", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/definitely-not-a-route", {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('href="/auth/static/auth.css"');
  });

  it("an unmatched path gives an API client the documented JSON", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/definitely-not-a-route", {});
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("not_found");
  });

  it("an unauthorized API call is untouched", async () => {
    // The contract every SDK and CLI depends on. If this ever returns HTML,
    // every client that parses an error breaks at once.
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/items", {});
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBeTruthy();
  });

  it("the same unauthorized path gives a browser a page", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/items", {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("keeps the headers middleware prepared before the throw", async () => {
    // `X-Request-ID` is set by middleware that cannot know a later handler
    // will throw, and it is documented on every response. The HTML branch
    // builds its own Response, so it has to carry them too.
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/items", {
      headers: { accept: "text/html" },
    });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});
