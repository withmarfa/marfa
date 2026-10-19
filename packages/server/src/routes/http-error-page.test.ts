import { pageAssetUrl } from "../pages/assets.js";
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
import { Hono } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { createErrorHandler } from "../middleware/error-handler.js";
import { visibleText } from "../pages/reading.js";
import { pageSecurityPolicy } from "./content-security-policy.js";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  prefersHtml,
  renderHttpErrorPage as renderWithNonce,
} from "./http-error-page.js";
import { renderHttpErrorPage } from "./test-render.js";

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

/** The `href` and text of every link in a page. */
function links(html: string): { href: string; text: string }[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(([, href, inner]) => ({
      href: href ?? "",
      text: textOf(inner ?? ""),
    }))
    .filter((link) => link.text !== "Skip to content");
}

/** The text of a fragment: every tag removed, repeated until none is left. */
function textOf(fragment: string): string {
  let text = fragment;
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.replace(/<[^>]*>/g, "");
  }
  return text.trim();
}

function heading(html: string): string {
  return /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";
}

describe("the rendered page", () => {
  it("is a full document in the page system, with a way back", () => {
    const html = renderHttpErrorPage(404);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain(
      `<link rel="stylesheet" href="${pageAssetUrl("pages.css")}" nonce="test-nonce"`,
    );
    // It works without a script, so it loads none and does not say it needs one.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("noscript");
    expect(html).toContain("<title>That page isn&#39;t here</title>");
    expect(links(html)).toEqual([{ href: "/", text: "Go to Home" }]);
    expect(html).toContain("Error 404");
  });

  it("carries no request-supplied text", () => {
    // Parameterless beyond the status, deliberately: an error page is
    // reachable on any path with any query, so every value from the request
    // is a value an attacker chose. Fixed copy is what makes it safe.
    expect(renderHttpErrorPage(404)).toBe(renderHttpErrorPage(404));
  });

  it("says something different for the classes a person can act on", () => {
    // A person does not need to know which of forty codes fired. They need
    // to know whether the thing exists, whether they may have it, and
    // whether waiting helps, so the copy keys on the status class.
    const pages = [404, 403, 429, 500].map((status) =>
      renderHttpErrorPage(status),
    );
    expect(new Set(pages.map(heading)).size).toBe(4);
    for (const html of pages) {
      expect(heading(html)).not.toBe("");
      expect(html).toContain('role="alert"');
      expect(links(html).some((link) => link.href === "/")).toBe(true);
    }
    expect(renderHttpErrorPage(401)).toBe(
      renderHttpErrorPage(403).replace("Error 403", "Error 401"),
    );
    expect(heading(renderHttpErrorPage(503))).toBe(heading(pages[3]!));
    expect(heading(renderHttpErrorPage(409))).not.toBe(heading(pages[3]!));
  });

  it("offers Try again on a server fault only when the request can be repeated", () => {
    const retry = renderWithNonce(500, "test-nonce", { retry: true });
    expect(links(retry)).toEqual([
      { href: "", text: "Try again" },
      { href: "/", text: "Go to Home" },
    ]);
    // Witness for the two assertions below: the option does change the page.
    expect(links(renderWithNonce(500, "test-nonce"))).toEqual([
      { href: "/", text: "Go to Home" },
    ]);
    expect(links(renderWithNonce(404, "test-nonce", { retry: true }))).toEqual([
      { href: "/", text: "Go to Home" },
    ]);
  });

  it("says how long to wait on a 429 when it is told, in whole minutes rounded up", () => {
    const said = (seconds: number | undefined) =>
      visibleText(renderWithNonce(429, "test-nonce", { retryAfter: seconds }));
    expect(said(1)).toContain("Try again in 1 minute.");
    expect(said(60)).toContain("Try again in 1 minute.");
    expect(said(61)).toContain("Try again in 2 minutes.");
    expect(said(900)).toContain("Try again in 15 minutes.");
    // Told nothing, it promises no number.
    expect(said(undefined)).toContain("Wait a few minutes, then try again.");
    // Only a 429 has a wait to say.
    expect(
      visibleText(renderWithNonce(500, "test-nonce", { retryAfter: 600 })),
    ).not.toContain("10 minutes");
  });

  it("refuses to render without the response's nonce", () => {
    expect(() => renderWithNonce(404, "")).toThrow(/nonce/);
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
    expect(html).toContain(`href="${pageAssetUrl("pages.css")}"`);
    expect(links(html)).toEqual([{ href: "/", text: "Go to Home" }]);
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
    // The contract every client depends on. If this ever returns HTML,
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
    expect(res.headers.get("x-error-code")).toBe("unauthorized");
    expect(links(await res.text())).toEqual([
      { href: "/", text: "Go to Home" },
    ]);
  });

  it("carries the policy that names the page's nonce", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/items", {
      headers: { accept: "text/html" },
    });
    const nonce = /script-src 'nonce-([^']+)'/.exec(
      res.headers.get("content-security-policy") ?? "",
    )?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(
      `href="${pageAssetUrl("pages.css")}" nonce="${nonce!}"`,
    );
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

  it("tells a browser a limit refused how long to wait, and keeps Retry-After for everyone", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", pageSecurityPolicy);
    app.onError(createErrorHandler({ errorWebhookUrl: "" }));
    app.get("/limited", (c) => {
      c.header("Retry-After", "125");
      throw new MarfaError(ErrorCode.RATE_LIMITED, "Too many requests");
    });
    const page = await app.request("/limited", {
      headers: { accept: "text/html" },
    });
    expect(page.status).toBe(429);
    expect(page.headers.get("retry-after")).toBe("125");
    expect(visibleText(await page.text())).toContain("Try again in 3 minutes.");
    // Witness: an API client still gets the JSON and the header.
    const program = await app.request("/limited");
    expect(program.status).toBe(429);
    expect(program.headers.get("content-type")).toContain("application/json");
    expect(program.headers.get("retry-after")).toBe("125");
  });
});
