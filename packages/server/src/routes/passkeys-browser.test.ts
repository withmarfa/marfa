import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { launchTestBrowser, listen, reserveOrigin } from "../test-browser.js";
import { createTestContext, type TestContext } from "../test-utils.js";

const launched = await launchTestBrowser();
const browser: Browser | null = launched instanceof Error ? null : launched;
if (launched instanceof Error && process.env.CI) throw launched;
const inBrowser = browser ? describe : describe.skip;
let ctx: TestContext, origin: string, server: { close(): Promise<void> };
const owner = { email: "owner@example.com", password: "correct horse battery" };
beforeAll(async () => {
  const reserved = await reserveOrigin();
  origin = reserved.origin.replace("127.0.0.1", "localhost");
  ctx = await createTestContext({ authBaseUrl: origin }, owner);
  server = listen(ctx.app, reserved.port, (request) =>
    new URL(request.url).pathname === "/callback"
      ? new Response("Back in the app")
      : undefined,
  );
});
afterAll(async () => {
  await server.close();
  await ctx.cleanup();
  await browser?.close();
});

inBrowser("passkey pages with a virtual authenticator", () => {
  it("registers, lists, signs in, and removes a passkey without an OS credential store", async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    );
    const csp: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("Content Security Policy"))
        csp.push(message.text());
    });
    try {
      await page.goto(origin + "/auth/sign-in?return_to=/auth/owner/passkeys");
      await page.fill('[name="email"]', owner.email);
      await page.fill('[name="password"]', owner.password);
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/auth\/owner\/passkeys$/);
      await page.fill('[name="passkey-name"]', "Browser passkey");
      await page.click("#add-passkey");
      await page.getByText("Browser passkey", { exact: true }).waitFor();
      const firstCredentials = await cdp.send("WebAuthn.getCredentials", {
        authenticatorId,
      });
      const firstCredential = firstCredentials.credentials[0];
      if (!firstCredential) throw new Error("Missing first virtual credential");
      await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId,
        enabled: false,
      });
      const { authenticatorId: otherAuthenticatorId } = await cdp.send(
        "WebAuthn.addVirtualAuthenticator",
        {
          options: {
            protocol: "ctap2",
            transport: "usb",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        },
      );
      await page.fill('[name="passkey-name"]', "Other browser passkey");
      await page.click("#add-passkey");
      await page.getByText("Other browser passkey", { exact: true }).waitFor();
      const allCredentials = await cdp.send("WebAuthn.getCredentials", {
        authenticatorId: otherAuthenticatorId,
      });
      const otherCredential = allCredentials.credentials.find(
        (row) => row.credentialId !== firstCredential.credentialId,
      );
      if (!otherCredential)
        throw new Error("Missing second virtual credential");
      await context.clearCookies();
      const registration = await ctx.app.request(
        origin + "/auth/oauth2/register",
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "Passkey App",
            application_type: "native",
            redirect_uris: [origin + "/callback"],
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        },
      );
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as { client_id: string };
      const query = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: origin + "/callback",
        state: "passkey-state",
        scope: "core.note:read",
        code_challenge: createHash("sha256")
          .update(randomBytes(32).toString("base64url"))
          .digest("base64url"),
        code_challenge_method: "S256",
      });
      await page.goto(origin + "/auth/oauth2/authorize?" + query.toString());
      await page.click("#sign-in-passkey");
      await page.waitForURL(/\/auth\/authorize\?/);
      await page.click('button[name="accept"][value="true"]');
      await page.waitForURL(/\/callback\?.*code=/);
      await page.goto(origin + "/auth/owner/passkeys");
      await page.getByText("Browser passkey", { exact: true }).waitFor();
      await page
        .locator("li")
        .filter({ has: page.getByText("Browser passkey", { exact: true }) })
        .getByRole("button", { name: "Remove" })
        .click();
      await page.getByText("Passkey removed.", { exact: true }).waitFor();
      await page.getByText("Other browser passkey", { exact: true }).waitFor();
      await context.clearCookies();
      const authenticate = async (credentialId: string) => {
        await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
          authenticatorId,
          enabled: credentialId === firstCredential.credentialId,
        });
        await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
          authenticatorId: otherAuthenticatorId,
          enabled: credentialId !== firstCredential.credentialId,
        });
        return page.evaluate(`(async () => {
          const options = await (await fetch('/auth/passkey/generate-authenticate-options')).json();
          options.allowCredentials = [{type:'public-key',id:${JSON.stringify(Buffer.from(credentialId, "base64").toString("base64url"))}}];
          options.userVerification = 'required';
          const credential = await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON(options)});
          const response = await fetch('/auth/passkey/verify-authentication',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({response:credential.toJSON()})});
          return response.status;
        })()`);
      };
      expect(await authenticate(firstCredential.credentialId)).toBe(401);
      expect(await authenticate(otherCredential.credentialId)).toBe(200);
      expect(csp).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
