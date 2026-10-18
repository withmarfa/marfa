import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { launchTestBrowser, listen, reserveOrigin } from "../test-browser.js";
import {
  createTestContext,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";
const launched = await launchTestBrowser();
const browser: Browser | null = launched instanceof Error ? null : launched;
if (launched instanceof Error && process.env.CI) throw launched;
const inBrowser = browser ? describe : describe.skip;
let ctx: TestContext, origin: string, server: { close: () => Promise<void> };
beforeAll(async () => {
  const reserved = await reserveOrigin();
  origin = reserved.origin;
  ctx = await createTestContext({ authBaseUrl: origin });
  server = listen(ctx.app, reserved.port);
});
afterAll(async () => {
  await server.close();
  await ctx.cleanup();
  await browser?.close();
});
inBrowser("owner and delegated profile flows", () => {
  it("changes the owner through a real browser and reads delegated changes through OAuth", async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin + "/auth/sign-in");
      await page.getByLabel("Email", { exact: true }).fill(ctx.owner.email);
      await page
        .getByLabel("Password", { exact: true })
        .fill(ctx.owner.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL(origin + "/");
      const ownerResponse = await context.request.patch(origin + "/owner", {
        headers: { origin },
        data: { email: "browser@example.com", name: "Browser owner" },
      });
      const owner = {
        status: ownerResponse.status(),
        body: await ownerResponse.json(),
      };
      expect(owner).toMatchObject({
        status: 200,
        body: {
          id: ctx.owner.id,
          email: "browser@example.com",
          name: "Browser owner",
        },
      });
      const grant = await seedOauthBearer(ctx, ["openid", "profile:write"]);
      const changedResponse = await context.request.patch(origin + "/profile", {
        headers: { authorization: `Bearer ${grant.token}` },
        data: { name: "App owner", avatar: "https://example.com/avatar.png" },
      });
      const info = await context.request.get(origin + "/auth/oauth2/userinfo", {
        headers: { authorization: `Bearer ${grant.token}` },
      });
      const changed = {
        status: changedResponse.status(),
        body: await changedResponse.json(),
        info: await info.json(),
      };
      expect(changed).toMatchObject({
        status: 200,
        body: { ok: true },
        info: {
          name: "App owner",
          email: "browser@example.com",
          picture: "https://example.com/avatar.png",
          email_verified: false,
        },
      });
      const refusedResponse = await context.request.patch(origin + "/owner", {
        headers: { origin, authorization: `Bearer ${grant.token}` },
        data: { name: "No" },
      });
      const refused = refusedResponse.status();
      expect(refused).toBe(403);
      const registered = await context.request.post(
        origin + "/auth/oauth2/register",
        {
          data: {
            client_name: "Profile browser app",
            application_type: "native",
            redirect_uris: ["http://localhost:5173/callback"],
            grant_types: [
              "authorization_code",
              "urn:ietf:params:oauth:grant-type:device_code",
            ],
            token_endpoint_auth_method: "none",
            response_types: ["code"],
          },
        },
      );
      const client = (await registered.json()) as { client_id: string };
      const query = new URLSearchParams({
        client_id: client.client_id,
        scope: "content:write profile:write",
        prompt: "consent",
        response_type: "code",
        redirect_uri: "http://localhost:5173/callback",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      });
      await page.goto(origin + "/auth/oauth2/authorize?" + query.toString());
      expect(
        (await page.locator(".gdesc").allTextContents()).some(
          (text) => /content/i.test(text) && /name.*avatar/i.test(text),
        ),
      ).toBe(true);

      await page.locator("details").evaluateAll((nodes) => {
        for (const node of nodes) node.setAttribute("open", "");
      });
      expect(await page.locator("body").innerText()).toContain(
        "Read your name, email address and avatar; change only your name and avatar.",
      );
      expect(await page.locator("body").innerText()).not.toMatch(
        /username|bio|timezone/,
      );
      const issued = await context.request.post(origin + "/auth/device/code", {
        headers: { origin },
        form: {
          client_id: client.client_id,
          scope: "content:write profile:write",
        },
      });
      expect(issued.status()).toBe(200);
      const device = (await issued.json()) as { user_code: string };
      await page.goto(
        origin +
          "/auth/device/consent?user_code=" +
          encodeURIComponent(device.user_code),
      );
      await page.locator("details").evaluateAll((nodes) => {
        for (const node of nodes) node.setAttribute("open", "");
      });
      expect(await page.locator("body").innerText()).toContain(
        "Read your name, email address and avatar; change only your name and avatar.",
      );
      expect(await page.locator("body").innerText()).toMatch(/content/i);
    } finally {
      await context.close();
    }
  });
});
