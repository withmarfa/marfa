import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { launchTestBrowser, listen, reserveOrigin } from "../test-browser.js";
import { createTestContext } from "../test-utils.js";

const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const inBrowser = launched instanceof Error ? it.skip : it;

inBrowser(
  "fetches the new passkey script after an upgrade with a fresh old script in browser cache",
  async () => {
    if (launched instanceof Error) throw launched;
    const browser = launched;
    const reserved = await reserveOrigin();
    const origin = reserved.origin.replace("127.0.0.1", "localhost");
    const owner = {
      email: "owner@example.com",
      password: "correct horse battery",
    };
    const ctx = await createTestContext({ authBaseUrl: origin }, owner);
    const context = await browser.newContext();
    let legacy = true,
      oldRequests = 0,
      newRequests = 0;
    const scriptRequests: string[] = [];
    const oldScript =
      "fetch('/auth/passkey/list-user-passkeys').then(() => { document.getElementById('passkey-status').textContent = 'Old client loaded'; });";
    const original = ctx.app.fetch.bind(ctx.app);
    ctx.app.fetch = async (...args: Parameters<typeof original>) => {
      const url = new URL(args[0].url);
      if (url.pathname === "/auth/passkey/list-user-passkeys") {
        oldRequests++;
        if (legacy) return Response.json([]);
      }
      if (url.pathname === "/owner/passkeys") newRequests++;
      if (url.pathname === "/auth/static/passkeys.js") {
        scriptRequests.push(url.pathname + url.search);
        if (legacy)
          return new Response(oldScript, {
            headers: {
              "content-type": "application/javascript; charset=utf-8",
              "cache-control": "public, max-age=3600",
              etag: `"${createHash("sha1").update(oldScript).digest("hex")}"`,
            },
          });
      }
      const response = await original(...args);
      if (legacy && url.pathname === "/auth/owner/passkeys")
        return new Response(
          (await response.text()).replace(
            /\/auth\/static\/passkeys\.js\?[^"\s]+/g,
            "/auth/static/passkeys.js",
          ),
          response,
        );
      return response;
    };
    const server = listen(ctx.app, reserved.port);
    try {
      expect(
        (
          await context.request.post(origin + "/auth/sign-in/email", {
            data: owner,
            headers: { origin },
          })
        ).status(),
      ).toBe(200);
      const page = await context.newPage();
      await page.goto(origin + "/auth/owner/passkeys");
      await page.getByText("Old client loaded", { exact: true }).waitFor();
      expect(oldRequests).toBe(1);
      expect(scriptRequests).toEqual(["/auth/static/passkeys.js"]);
      legacy = false;
      await page.goto(origin + "/health");
      await page.goto(origin + "/auth/owner/passkeys");
      await page.waitForLoadState("networkidle");
      expect(newRequests).toBe(1);
      expect(oldRequests).toBe(1);
      expect(scriptRequests).toHaveLength(2);
      expect(scriptRequests[1]).toMatch(
        /^\/auth\/static\/passkeys\.js\?v=[a-f0-9]{40}$/,
      );
      await page.getByText("No passkeys yet.", { exact: true }).waitFor();
    } finally {
      await context.close();
      await browser.close();
      await server.close();
      await ctx.cleanup();
    }
  },
);
