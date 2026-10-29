import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { visibleText } from "../pages/reading.js";
import {
  mintWorkingKey,
  request,
  createTestContext,
  cleanupTestContext,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

vi.setConfig({ testTimeout: 60_000 });

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({});
});

afterAll(async () => {
  await cleanupTestContext(ctx);
});

async function page(path: string): Promise<{ status: number; html: string }> {
  const res = await ctx.ownerRequest(path, {
    headers: { accept: "text/html" },
  });
  return { status: res.status, html: await res.text() };
}

/** Signs the owner in again from another client, which makes one more browser session. */
async function signInFrom(userAgent: string): Promise<string> {
  const response = await request(ctx.app, "POST", "/auth/sign-in/email", {
    body: { email: ctx.owner.email, password: ctx.owner.password },
    headers: { origin: "http://localhost:0", "user-agent": userAgent },
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

/** The accessible names of the Sign out buttons of a Browsers page, one for each browser but this one. */
function signOutButtons(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes('data-hook="browser-sign-out"'))
    .map((tag) => /aria-label="([^"]*)"/.exec(tag)?.[1] ?? "");
}

describe("the Browsers page", () => {
  it("marks this browser and offers no Sign out for it, nor a way to sign out the others when there are none", async () => {
    const { status, html } = await page("/auth/owner/browsers");
    expect(status).toBe(200);
    const text = visibleText(html);
    expect(text).toContain("This browser");
    expect(signOutButtons(html)).toEqual([]);
    expect(text).not.toContain("Sign out of all other browsers");
    expect(text).not.toContain("Each one has to sign in again");
  });

  it("offers Sign out for each other browser, and one row to sign out all of them with the count", async () => {
    await signInFrom("curl/8.4.0");
    await signInFrom("curl/8.4.0");
    const { html } = await page("/auth/owner/browsers");
    const text = visibleText(html);
    expect(text.match(/This browser/g)).toHaveLength(1);
    expect(signOutButtons(html)).toEqual(["Sign out curl", "Sign out curl"]);
    expect(text).toContain("Sign out of all other browsers");
    expect(text).toContain("Ends 2 sign-ins. You stay signed in here.");
    // This browser comes first.
    expect(text.indexOf("This browser")).toBeLessThan(text.indexOf("curl"));
  });

  it("signs the other browsers out through the door the page uses, and keeps this one", async () => {
    const other = await signInFrom("curl/8.4.0");
    const before = visibleText((await page("/auth/owner/browsers")).html);
    expect(before).toContain("curl");
    const ended = await ctx.ownerRequest("/auth/revoke-other-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(ended.status).toBe(200);
    const after = await page("/auth/owner/browsers");
    expect(after.status).toBe(200);
    expect(signOutButtons(after.html)).toEqual([]);
    const gone = await request(ctx.app, "GET", "/auth/get-session", {
      headers: { cookie: other },
    });
    expect(await gone.json()).toBeNull();
  });

  it("is the owner's alone: a key is refused, and a browser without a sign-in is sent to sign in", async () => {
    const manager = await mintWorkingKey(ctx, {
      permissions: ["grants.manage"],
    });
    const res = await ctx.app.request("/auth/owner/browsers", {
      headers: { authorization: `Bearer ${manager}` },
    });
    expect(res.status).toBe(403);
    const anon = await ctx.app.request("/auth/owner/browsers", {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toContain("/auth/sign-in");
  });

  it("refuses a query key it does not know", async () => {
    const res = await ctx.ownerRequest("/auth/owner/browsers?surprise=1");
    expect(res.status).toBe(400);
  });
});

describe("Home, for the browsers", () => {
  it("counts the browsers that are signed in", async () => {
    await ctx.ownerRequest("/auth/revoke-other-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(visibleText((await page("/")).html)).toContain("1 signed in");
    await signInFrom("curl/8.4.0");
    expect(visibleText((await page("/")).html)).toContain("2 signed in");
  });
});
