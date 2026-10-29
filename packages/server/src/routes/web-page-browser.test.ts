/**
 * A web page on its own origin connecting in a real browser: it finds the
 * endpoints, registers itself, opens the approval window, and once the owner
 * approves, reads from the instance.
 *
 * A web client's redirect URI must be `https` off the loopback, so the page's
 * origin cannot be a local listener without a certificate and a hostname.
 * The browser asks for it like any other address and Playwright answers it
 * in place of the network, so the page runs on that origin and every request
 * it makes to the instance is a real cross-origin request the browser itself
 * checks.
 *
 * The instance listens on the loopback, so each context grants the page
 * Chrome's Local Network Access permission, as a person would on the prompt.
 */
import type { Browser, BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchTestBrowser, listen, reserveOrigin } from "../test-browser.js";
import {
  createTestContext,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";

const launched = await launchTestBrowser();
const browser: Browser | null = launched instanceof Error ? null : launched;
if (launched instanceof Error && process.env.CI) {
  throw new Error(
    "No browser to run the page tests in; CI is expected to have one",
    { cause: launched },
  );
}
const inBrowser = browser === null ? describe.skip : describe;

const PAGE = "https://page.example";
/** A page no test approves. */
const UNAPPROVED = "https://unapproved-page.example";
const EMAIL = "web-page@example.com";
const PASSWORD = "correct horse battery";

let ctx: TestContext;
let origin: string;
let server: { close: () => Promise<void> };

beforeAll(async () => {
  const reserved = await reserveOrigin();
  origin = reserved.origin;
  ctx = await createTestContext(
    { authBaseUrl: origin },
    { email: EMAIL, password: PASSWORD, name: "Web Page Tester" },
  );
  server = listen(ctx.app, reserved.port);
});

afterAll(async () => {
  await server.close();
  await cleanupTestContext(ctx);
  await browser?.close();
});

/** The page's own script: discover, register, ask for approval, read. */
function pageHtml(instance: string): string {
  return `<!doctype html><title>Web page</title>
<button id="connect">Connect</button><p id="state">idle</p>
<script>
const instance = ${JSON.stringify(instance)};
const state = document.getElementById('state');
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
document.getElementById('connect').addEventListener('click', async () => {
  try {
    const meta = await (await fetch(instance + '/.well-known/oauth-authorization-server/auth')).json();
    const redirect = location.origin + '/callback';
    const registered = await (await fetch(meta.registration_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Browser Page', redirect_uris: [redirect], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'core.note:read' }),
    })).json();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: redirect, scope: 'core.note:read', state: 'page', code_challenge: challenge, code_challenge_method: 'S256' });
    const code = await new Promise((resolve) => {
      const channel = new BroadcastChannel('marfa-approval');
      channel.onmessage = (event) => { channel.close(); resolve(event.data); };
      open(url, 'marfa', 'popup,width=480,height=640');
    });
    const token = await (await fetch(meta.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: registered.client_id }),
    })).json();
    const read = await fetch(instance + '/items?limit=1', { headers: { Authorization: 'Bearer ' + token.access_token } });
    state.textContent = 'read ' + read.status;
  } catch (error) {
    state.textContent = 'failed: ' + error.message;
  }
});
</script>`;
}

// The approval pages send `Cross-Origin-Opener-Policy: same-origin`, which
// cuts the window off from the page that opened it, so the code comes back
// over a channel of the page's own origin rather than through `opener`.
const CALLBACK_HTML = `<!doctype html><title>Callback</title><script>
new BroadcastChannel('marfa-approval').postMessage(new URLSearchParams(location.search).get('code'));
close();
</script>`;

async function pageContext(page = PAGE): Promise<BrowserContext> {
  const context = await browser!.newContext();
  // The instance here listens on the loopback, and Chrome asks the person
  // before a page from elsewhere may reach a loopback or private address
  // (Local Network Access). Granting it is the person answering yes; an
  // instance on a public address raises no such question.
  await context.grantPermissions(["local-network-access"], { origin: page });
  await context.route(`${page}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: path === "/callback" ? CALLBACK_HTML : pageHtml(origin),
    });
  });
  return context;
}

inBrowser("a web page in a browser", () => {
  it("registers itself, is approved in a popup, and reads with one approval and no key", async () => {
    const context = await pageContext();
    try {
      const page = await context.newPage();
      await page.goto(`${PAGE}/`);
      const opened = context.waitForEvent("page");
      await page.click("#connect");
      const popup = await opened;
      await popup.waitForURL(/\/auth\/sign-in\?/);
      await popup.fill('input[name="email"]', EMAIL);
      await popup.fill('input[name="password"]', PASSWORD);
      await popup.click('button[type="submit"]');
      await popup.waitForURL(/\/auth\/authorize\?/);
      // The origin is written without its secure scheme.
      expect(await popup.textContent("body")).toContain(
        PAGE.replace("https://", ""),
      );
      await popup.click('button[name="accept"][value="true"]');
      await expect
        .poll(() => page.textContent("#state"), { timeout: 15_000 })
        .toBe("read 200");
    } finally {
      await context.close();
    }
  });

  it("is refused a read before the owner approves it, though it can register", async () => {
    const context = await pageContext(UNAPPROVED);
    try {
      const page = await context.newPage();
      await page.goto(`${UNAPPROVED}/`);
      const outcome = await page.evaluate(
        async ({ instance, pageOrigin }) => {
          const meta = (await (
            await fetch(
              `${instance}/.well-known/oauth-authorization-server/auth`,
            )
          ).json()) as { registration_endpoint: string };
          const registered = await fetch(meta.registration_endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_name: "Unapproved Page",
              redirect_uris: [`${pageOrigin}/callback`],
              grant_types: ["authorization_code"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            }),
          });
          let read: string;
          try {
            const answer = await fetch(`${instance}/items?limit=1`, {
              headers: { Authorization: "Bearer not-a-token" },
            });
            read = String(answer.status);
          } catch {
            read = "blocked";
          }
          return { registered: registered.status, read };
        },
        { instance: origin, pageOrigin: UNAPPROVED },
      );
      expect(outcome).toEqual({ registered: 201, read: "blocked" });
    } finally {
      await context.close();
    }
  });
});
