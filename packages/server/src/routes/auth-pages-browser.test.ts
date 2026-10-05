/**
 * The sign-in, consent and device approval pages, run in a real browser
 * against a listening server.
 *
 * A request made in process shows what the server sent. These show what a
 * person is left with once the page's own script has run, which is where the
 * defects held here lived: a form that kept its "already submitting" mark
 * through Back, a page with no way onward.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import { createTestAccount, createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { launchTestBrowser, listen, reserveOrigin } from "../test-browser.js";

const browser: Browser | null = await launchTestBrowser();
if (browser === null && process.env.CI) {
  throw new Error(
    "No browser to run the page tests in; CI is expected to have one",
  );
}
const inBrowser = browser === null ? describe.skip : describe;

const EMAIL = "pages@example.com";
const PASSWORD = "correct horse battery";

let ctx: TestContext;
let origin: string;
let server: { close: () => Promise<void> };

/** The callback an app would own, answered so a navigation to it settles. */
function callback(request: Request): Response | undefined {
  if (new URL(request.url).pathname !== "/callback") return undefined;
  return new Response(
    "<!doctype html><title>App</title><p>Back in the app</p>",
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

beforeAll(async () => {
  const reserved = await reserveOrigin();
  origin = reserved.origin;
  ctx = await createTestContext({ authBaseUrl: origin });
  await createTestAccount(ctx, EMAIL, PASSWORD, "Pages Tester");
  server = listen(ctx.app, reserved.port, callback);
});

afterAll(async () => {
  await server.close();
  await ctx.cleanup();
  await browser?.close();
});

/** Register an app the way any program can, and say where to send the person. */
async function authorizeUrl(name: string): Promise<string> {
  const res = await ctx.app.request("/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      client_name: name,
      application_type: "native",
      redirect_uris: [`${origin}/callback`],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const registered = (await res.json()) as { client_id: string };
  const challenge = createHash("sha256")
    .update(randomBytes(32).toString("base64url"))
    .digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: `${origin}/callback`,
    state: "pages-state",
    scope: "core.note:read",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${origin}/auth/oauth2/authorize?${params.toString()}`;
}

async function signIn(page: Page): Promise<void> {
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
}

async function newPage(): Promise<Page> {
  if (browser === null) throw new Error("no browser");
  const context = await browser.newContext();
  return await context.newPage();
}

inBrowser("the consent page, in a browser", () => {
  it("still works after Back from Deny", async () => {
    const page = await newPage();
    try {
      await page.goto(await authorizeUrl("Back Test App"));
      await signIn(page);
      await page.waitForURL(/\/auth\/authorize\?/);

      await page.click('button[name="accept"][value="false"]');
      await page.waitForURL(/\/callback/);
      // A page restored from the back-forward cache fires no load event, so
      // waiting for one would wait for ever.
      await page.goBack({ waitUntil: "commit" });
      await page.waitForURL(/\/auth\/authorize\?/, { waitUntil: "commit" });

      const allow = page.locator('button[name="accept"][value="true"]');
      expect(await allow.isDisabled()).toBe(false);
      const deny = page.locator('button[name="accept"][value="false"]');
      expect(await deny.isDisabled()).toBe(false);
      expect(await deny.textContent()).toBe("Deny");

      await allow.click();
      await page.waitForURL(/\/callback\?.*code=/);
    } finally {
      await page.context().close();
    }
  });
});

inBrowser("the sign-in page, in a browser", () => {
  it("keeps the email after a wrong password and names the app", async () => {
    const page = await newPage();
    try {
      await page.goto(await authorizeUrl("Keeps Email App"));
      expect(await page.textContent("main")).toContain(
        "Sign in to continue to Keeps Email App",
      );
      await page.fill('input[name="email"]', EMAIL);
      await page.fill('input[name="password"]', "not the password");
      await page.click('button[type="submit"]');
      await page.waitForURL(/error=invalid_credentials/);

      expect(await page.inputValue('input[name="email"]')).toBe(EMAIL);
      expect(await page.inputValue('input[name="password"]')).toBe("");
      expect(await page.textContent("main")).toContain("Keeps Email App");

      // The retry needs only the password, and ends at the consent page.
      await page.fill('input[name="password"]', PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/auth\/authorize\?/);
    } finally {
      await page.context().close();
    }
  });

  it("ends on a page, not JSON, when no app is waiting", async () => {
    const page = await newPage();
    try {
      await page.goto(`${origin}/auth/sign-in`);
      await signIn(page);
      await page.waitForURL(`${origin}/`);
      expect(await page.textContent("main")).toContain("You're signed in");

      // Opening the sign-in page now says so too, rather than offering the
      // form again.
      await page.goto(`${origin}/auth/sign-in`);
      expect(await page.textContent("main")).toContain("You're signed in");
      expect(await page.locator('input[name="password"]').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  it("shows a page at the server's address and at end-session", async () => {
    const page = await newPage();
    try {
      await page.goto(`${origin}/`);
      expect(await page.textContent("main")).toContain("Marfa is running");

      await page.goto(`${origin}/auth/oauth2/end-session`);
      expect(await page.textContent("main")).toContain("You're signed out");
    } finally {
      await page.context().close();
    }
  });

  it("tells a tampered authorization link it is invalid, not expired", async () => {
    const page = await newPage();
    try {
      const url = new URL(await authorizeUrl("Tampered App"));
      await page.goto(url.toString());
      await page.waitForURL(/\/auth\/sign-in\?/);
      await signIn(page);
      await page.waitForURL(/\/auth\/authorize\?/);
      const tampered = new URL(page.url());
      tampered.searchParams.set(
        "exp",
        String(Math.floor(Date.now() / 1000) - 60),
      );
      await page.goto(tampered.toString());
      const text = await page.textContent("main");
      expect(text).toContain("We could not verify this request");
      expect(text).not.toContain("expired");
    } finally {
      await page.context().close();
    }
  });
});

inBrowser("the device approval page, in a browser", () => {
  it("warns about an app that registered itself", async () => {
    const registered = await ctx.app.request("/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        client_name: "Device Warn App",
        application_type: "native",
        grant_types: [DEVICE_CODE_GRANT_TYPE],
        token_endpoint_auth_method: "none",
        redirect_uris: [`${origin}/callback`],
        response_types: [],
      }),
    });
    const { client_id: clientId } = (await registered.json()) as {
      client_id: string;
    };
    const initiated = await ctx.app.request("/auth/device/code", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      body: new URLSearchParams({
        client_id: clientId,
        scope: "core.note:read",
      }).toString(),
    });
    const { verification_uri_complete: complete } =
      (await initiated.json()) as { verification_uri_complete: string };
    const page = await newPage();
    try {
      await page.goto(complete);
      await page.waitForURL(/\/auth\/sign-in\?/);
      await signIn(page);
      await page.waitForURL(/\/auth\/device\/consent\?/);
      expect(await page.textContent(".callout")).toContain(
        "Marfa hasn't verified this app",
      );

      // Deny, then Back: the page works again, as the consent page does.
      await page.click('button:has-text("Deny")');
      await page.waitForSelector("text=You denied the request");
      await page.goBack({ waitUntil: "commit" });
      await page.waitForURL(/\/auth\/device\/consent\?/, {
        waitUntil: "commit",
      });
      const approve = page.locator('button:has-text("Approve")');
      expect(await approve.isDisabled()).toBe(false);
      expect(await page.locator("text=Working").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });
});
