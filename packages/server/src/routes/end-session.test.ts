import { describe, it, expect, afterEach } from "vitest";
import { createTestAccount, createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { renderSignedOutPage } from "./signed-out-page.js";

/**
 * The wrapper over the plugin's RP-initiated logout.
 *
 * It adds exactly one behavior: when the plugin ends the session and then has
 * nowhere to send the person, it answers with an empty 200, and this route
 * turns that blank document into a page. Everything else has to pass through
 * untouched, which is what these tests hold it to.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

describe("GET /auth/oauth2/end-session", () => {
  it("passes a real plugin response through rather than swallowing it", async () => {
    ctx = await createTestContext({});
    // No id_token_hint, so the plugin refuses before it reaches a session.
    // The point is that the refusal survives: a wrapper that rendered its own
    // page on anything non-redirecting would report a completed sign-out for
    // a request that did nothing.
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/oauth2/end-session`, {
        headers: { origin: ORIGIN },
      }),
    );

    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("You&#39;re signed out");
  });

  it("shows a browser with no session a page, and never JSON", async () => {
    ctx = await createTestContext({});
    const navigate = {
      origin: ORIGIN,
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-mode": "navigate",
    };
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/oauth2/end-session`, { headers: navigate }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("You&#39;re signed out");

    // Witness: a program asking the same door still gets the provider's JSON
    // refusal, so the page above is the doing of what the browser sent.
    const program = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/oauth2/end-session`, {
        headers: { origin: ORIGIN, accept: "application/json" },
      }),
    );
    expect(program.status).toBe(400);
    expect(program.headers.get("content-type")).toContain("application/json");
  });

  it("shows a signed-in browser the provider's confirmation page, not its JSON", async () => {
    ctx = await createTestContext({});
    await createTestAccount(ctx, "hana@example.com", "correct horse", "Hana");
    const signIn = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          email: "hana@example.com",
          password: "correct horse",
        }),
      }),
    );
    const cookie =
      /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
        signIn.headers.get("set-cookie") ?? "",
      )?.[1] ?? "";
    expect(cookie).not.toBe("");
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/oauth2/end-session`, {
        headers: {
          origin: ORIGIN,
          cookie,
          accept: "text/html",
          "sec-fetch-mode": "navigate",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Confirm logout");
  });

  it("says the session ended rather than showing a blank document", () => {
    // The page itself, pinned here because the state that produces it needs a
    // client whose registered return URI does not match the one it sends, and
    // an operator who hits that should still get words on the screen.
    const html = renderSignedOutPage();
    expect(html).toContain("You&#39;re signed out");
    expect(html).toContain("Your session on this device has ended");
    expect(html).not.toContain("—");
  });
});
