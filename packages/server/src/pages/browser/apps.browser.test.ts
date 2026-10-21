/**
 * The Connected apps and Browsers pages in a real browser against a real
 * listener under the real policy: disconnecting an app with and without the
 * keys it made, signing one browser out and all the others, the keyboard alone,
 * and no refusal by the content security policy. How the pages look is checked
 * by eye, not here.
 */
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashApiKey } from "../../middleware/auth.js";
import {
  launchTestBrowser,
  listen,
  reserveOrigin,
} from "../../test-browser.js";
import {
  createTestContext,
  seedOauthBearer,
  TEST_API_KEY_SALT,
} from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";

const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const inBrowser = launched instanceof Error ? it.skip : it;

let browser: Browser;
let origin: string;
let ctx: TestContext;
let server: { close: () => Promise<void> };

beforeAll(async () => {
  if (launched instanceof Error) return;
  browser = launched;
  const reserved = await reserveOrigin();
  origin = reserved.origin.replace("127.0.0.1", "localhost");
  // Sign-in limits count per address, so each browser context names its own.
  ctx = await createTestContext({
    authBaseUrl: origin,
    trustedProxyHeader: "x-real-ip",
  });
  server = listen(ctx.app, reserved.port);
});

afterAll(async () => {
  if (launched instanceof Error) return;
  await browser.close();
  await server.close();
  await ctx.cleanup();
});

let nextAddress = 1;

interface Opened {
  page: Page;
  context: BrowserContext;
  errors: string[];
  violations: () => Promise<string[]>;
}

async function open(userAgent?: string): Promise<Opened> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent,
    extraHTTPHeaders: { "x-real-ip": `198.51.100.${String(nextAddress++)}` },
  });
  const signedIn = await context.request.post(`${origin}/auth/sign-in/email`, {
    headers: { origin },
    data: { email: ctx.owner.email, password: ctx.owner.password },
  });
  expect(signedIn.status()).toBe(200);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__violations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return {
    page,
    context,
    errors,
    violations: () =>
      page.evaluate(
        () => (window as unknown as { __violations: string[] }).__violations,
      ),
  };
}

let keyCount = 0;

/** A key the app made, which the pages tell from the owner's own by its client. */
async function appKey(clientId: string): Promise<string> {
  keyCount += 1;
  const key = await ctx.storage.keys.create(
    {
      label: `app key ${String(keyCount)}`,
      source: `apps-browser-${String(keyCount)}`,
      permissions: [],
      type_permissions: { "core.note": "read" },
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
      default_tier: "library",
      oauth_client_id: clientId,
    },
    hashApiKey(`marfa_k1_apps_browser_${String(keyCount)}`, TEST_API_KEY_SALT),
  );
  return key.id;
}

/** Opens the Disconnect dialog from the app's page with the keyboard alone. */
async function openDisconnect(page: Page, name: string) {
  await page.locator('[data-dialog-open="app-disconnect-dialog"]').focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: `Disconnect ${name}?` });
  await dialog.waitFor();
  return dialog;
}

describe("Connected apps", () => {
  for (const [broad, narrow, effective] of [
    ["*:read", "core.note:read", "Read only"],
    ["*:write", "core.note:read", "Read only"],
    ["core.*:read", "core.media.article:read", "Read only"],
    ["content:write", "core.note:read", "Read only"],
    ["edge.*:write", "edge.parent-of:read", "Read only"],
    ["metadata:write", "metadata.types:read", "Read and edit"],
    ["profile:write", "profile.name:read", "Read and edit"],
  ] as const) {
    inBrowser(`keeps ${narrow} truthful while ${broad} covers it`, async () => {
      const { page, context, errors, violations } = await open();
      try {
        const app = await seedOauthBearer(ctx, [broad, narrow]);
        await page.goto(`${origin}/auth/owner/apps/${app.grantId}`);
        const group = broad.startsWith("profile")
          ? "Your profile"
          : "Your data";
        await page.locator("#access").getByText(group, { exact: true }).click();
        const dependent = page.locator("select[name=scopes]").filter({
          has: page.locator(`option[value="${narrow}"]`),
        });
        const wider = page.locator("select[name=scopes]").filter({
          has: page.locator(`option[value="${broad}"]`),
        });
        expect(await dependent.isDisabled()).toBe(true);
        expect(await dependent.locator("option:checked").innerText()).toBe(
          effective,
        );
        expect(await dependent.locator('option[value=""]').count()).toBe(0);
        expect(await wider.isEnabled()).toBe(true);
        await wider.selectOption("");
        expect(await dependent.isDisabled()).toBe(true);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByText("Saved", { exact: true }).waitFor();
        const response = await page.request.get(`${origin}/auth/grants`);
        const grants = (await response.json()) as {
          data: { id: string; scopes: string[] }[];
        };
        expect(
          grants.data.find((grant) => grant.id === app.grantId)?.scopes,
        ).toEqual([narrow]);
        await page.locator("#access").getByText(group, { exact: true }).click();
        expect(await dependent.isEnabled()).toBe(true);
        expect(await dependent.locator('option[value=""]').innerText()).toBe(
          "No access",
        );
        await dependent.selectOption("");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByText("Saved", { exact: true }).waitFor();
        const cleared = await page.request.get(`${origin}/auth/grants`);
        const remaining = (await cleared.json()) as {
          data: { id: string; scopes: string[] }[];
        };
        expect(
          remaining.data.find((grant) => grant.id === app.grantId)?.scopes,
        ).toEqual([]);
        expect(await violations()).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  inBrowser(
    "keeps changes retryable after cancellation, refusal and network failure",
    async () => {
      const { page, context } = await open();
      try {
        const app = await seedOauthBearer(ctx, ["core.note:read"]);
        await page.goto(`${origin}/auth/owner/apps/${app.grantId}`);
        await page
          .locator("#access")
          .getByText("Your data", { exact: true })
          .click();
        const note = page.locator("select[name=scopes]").first();
        await note.selectOption("");
        const save = page.getByRole("button", { name: "Save", exact: true });
        const target = `**/auth/grants/${app.grantId}`;
        for (const failure of ["cancel", "refuse", "network"]) {
          await page.route(target, async (route) => {
            if (failure === "network") return route.abort();
            await route.fulfill({
              status: 403,
              contentType: "application/json",
              body: JSON.stringify({
                error: {
                  code: "forbidden",
                  message:
                    failure === "cancel"
                      ? "Sign in again to perform this operation"
                      : "Access changed. Reload before saving.",
                },
              }),
            });
          });
          await save.click();
          if (failure === "cancel") {
            const confirm = page.locator("dialog[data-confirm-dialog]");
            await confirm.waitFor();
            await confirm
              .getByRole("button", { name: "Cancel", exact: true })
              .click();
            await confirm.waitFor({ state: "hidden" });
          } else {
            await page
              .locator('[data-notice="problem"]')
              .waitFor({ state: "visible" });
          }
          await page.waitForFunction(
            () =>
              !document
                .querySelector("form[data-app-access]")
                ?.getAttribute("data-sending"),
          );
          expect(await note.inputValue()).toBe("");
          expect(await save.isEnabled()).toBe(true);
          await page.unroute(target);
        }
        await page
          .getByRole("button", { name: "Discard", exact: true })
          .click();
        expect(await note.inputValue()).toBe("core.note:read");
        await note.selectOption("");
        await save.click();
        await page.getByText("Saved", { exact: true }).waitFor();
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "disconnects an app and the keys it made, by default, with the keyboard alone",
    async () => {
      const { page, context, errors, violations } = await open();
      try {
        const app = await seedOauthBearer(ctx, ["core.note:read"], {
          clientName: "Reader",
        });
        const keys = [await appKey(app.clientId), await appKey(app.clientId)];
        await page.goto(`${origin}/auth/owner/apps`);
        await page.getByRole("link", { name: /Reader/ }).focus();
        await page.keyboard.press("Enter");
        await page.waitForURL(`${origin}/auth/owner/apps/${app.grantId}`);
        for (const id of keys)
          await page.locator(`a[href="/auth/owner/keys/${id}"]`).waitFor();

        const dialog = await openDisconnect(page, "Reader");
        const revoke = dialog.getByRole("switch", {
          name: "Also revoke the keys it made",
        });
        expect(await revoke.isChecked()).toBe(true);
        expect(await dialog.innerText()).toContain("2 keys would stop working");
        await dialog.getByRole("button", { name: "Disconnect" }).focus();
        await page.keyboard.press("Enter");
        await page.waitForURL(`${origin}/auth/owner/apps`);
        await page.getByText("Disconnected Reader").waitFor();
        expect(await page.getByRole("link", { name: /Reader/ }).count()).toBe(
          0,
        );
        for (const id of keys)
          expect(await ctx.storage.keys.get(id)).toBeNull();
        expect(await violations()).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "leaves the keys working when the switch is turned off",
    async () => {
      const { page, context, errors } = await open();
      try {
        const app = await seedOauthBearer(ctx, ["core.note:read"], {
          clientName: "Keeper",
        });
        const id = await appKey(app.clientId);
        await page.goto(`${origin}/auth/owner/apps/${app.grantId}`);
        const dialog = await openDisconnect(page, "Keeper");
        await dialog
          .getByRole("switch", { name: "Also revoke the keys it made" })
          .focus();
        await page.keyboard.press("Space");
        expect(
          await dialog
            .getByRole("switch", { name: "Also revoke the keys it made" })
            .isChecked(),
        ).toBe(false);
        await dialog.getByRole("button", { name: "Disconnect" }).focus();
        await page.keyboard.press("Enter");
        await page.waitForURL(`${origin}/auth/owner/apps`);
        await page.getByText("Disconnected Keeper").waitFor();
        expect(await ctx.storage.keys.get(id)).not.toBeNull();
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser("sends nothing when the person cancels", async () => {
    const { page, context } = await open();
    try {
      const app = await seedOauthBearer(ctx, ["core.note:read"], {
        clientName: "Stays",
      });
      const id = await appKey(app.clientId);
      await page.goto(`${origin}/auth/owner/apps/${app.grantId}`);
      let deletes = 0;
      page.on("request", (request) => {
        if (request.method() === "DELETE") deletes += 1;
      });
      const dialog = await openDisconnect(page, "Stays");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(deletes).toBe(0);
      expect(
        (await page.request.get(`${origin}/owner/sign-ins`)).status(),
      ).toBe(200);
      expect(await ctx.storage.keys.get(id)).not.toBeNull();
      const listed = (await (
        await page.request.get(`${origin}/owner/sign-ins`)
      ).json()) as { data: { id: string }[] };
      expect(listed.data.some((row) => row.id === app.grantId)).toBe(true);
    } finally {
      await context.close();
    }
  });

  inBrowser(
    "says the keys were not revoked when the app was already disconnected, and is done when they were not asked for",
    async () => {
      const { page, context } = await open();
      try {
        const app = await seedOauthBearer(ctx, ["core.note:read"], {
          clientName: "Gone already",
        });
        const id = await appKey(app.clientId);
        await page.goto(`${origin}/auth/owner/apps/${app.grantId}`);
        // Disconnected from another window while this page was open.
        const elsewhere = await ctx.ownerRequest(
          `/owner/sign-ins/${app.grantId}`,
          { method: "DELETE" },
        );
        expect(elsewhere.status).toBe(200);
        const dialog = await openDisconnect(page, "Gone already");
        await dialog.getByRole("button", { name: "Disconnect" }).focus();
        await page.keyboard.press("Enter");
        const notice = dialog.getByText("was already disconnected");
        await notice.waitFor();
        expect(await dialog.innerText()).toContain("its keys were not revoked");
        await dialog.getByRole("link", { name: "API keys" }).waitFor();
        expect(page.url()).toBe(`${origin}/auth/owner/apps/${app.grantId}`);
        expect(await ctx.storage.keys.get(id)).not.toBeNull();
        // The witness: with the switch off the same 404 is the state asked for.
        await dialog
          .getByRole("switch", { name: "Also revoke the keys it made" })
          .focus();
        await page.keyboard.press("Space");
        await dialog.getByRole("button", { name: "Disconnect" }).focus();
        await page.keyboard.press("Enter");
        await page.waitForURL(`${origin}/auth/owner/apps`);
        await page.getByText("Disconnected Gone already").waitFor();
      } finally {
        await context.close();
      }
    },
  );

  inBrowser("finds an app by name with the keyboard alone", async () => {
    const { page, context } = await open();
    try {
      await seedOauthBearer(ctx, ["core.note:read"], {
        clientName: "Findable zebra",
      });
      await page.goto(`${origin}/auth/owner/apps`);
      await page.getByRole("searchbox", { name: "Search apps" }).focus();
      await page.keyboard.type("zebra");
      await page.keyboard.press("Enter");
      await page.waitForURL(/[?&]q=zebra/);
      expect(
        await page.getByRole("link", { name: /Findable zebra/ }).count(),
      ).toBe(1);
    } finally {
      await context.close();
    }
  });
});

describe("Browsers", () => {
  inBrowser(
    "does not offer to sign this browser out, and signs another out with the keyboard alone",
    async () => {
      const here = await open();
      const there = await open("curl/8.4.0");
      try {
        await here.page.goto(`${origin}/auth/owner/browsers`);
        await here.page.getByText("This browser").waitFor();
        // Earlier cases left browsers signed in; this one has no button of its own.
        const all = here.page.locator('[data-hook="browser-sign-out"]');
        expect(await all.count()).toBeGreaterThan(1);
        const buttons = here.page.locator('[aria-label="Sign out curl"]');
        expect(await buttons.count()).toBe(1);
        const own = here.page.locator(".row", { hasText: "This browser" });
        // The witness: the same lookup finds the button on another browser's row.
        expect(await own.count()).toBe(1);
        expect(
          await here.page
            .locator(".row", { hasText: "curl" })
            .locator('[data-hook="browser-sign-out"]')
            .count(),
        ).toBe(1);
        expect(
          await here.page
            .locator(".row", { hasText: "This browser" })
            .locator('[data-hook="browser-sign-out"]')
            .count(),
        ).toBe(0);
        await buttons.first().focus();
        await here.page.keyboard.press("Enter");
        await here.page.getByText("Signed out curl").waitFor();
        expect(await buttons.count()).toBe(0);
        expect(
          (
            await there.context.request.get(`${origin}/owner/sign-ins`)
          ).status(),
        ).toBe(401);
        expect(
          (await here.context.request.get(`${origin}/owner/sign-ins`)).status(),
        ).toBe(200);
        expect(await here.violations()).toEqual([]);
        expect(here.errors).toEqual([]);
      } finally {
        await there.context.close();
        await here.context.close();
      }
    },
  );

  // Last: ending the other browsers ends the session `ctx.ownerRequest` holds.
  inBrowser(
    "signs out all the other browsers at once, with the keyboard alone, and stays signed in here",
    async () => {
      const here = await open();
      const first = await open("curl/8.4.0");
      const second = await open("wget/1.21");
      try {
        await here.page.goto(`${origin}/auth/owner/browsers`);
        const dialogOpen = here.page.locator(
          '[data-dialog-open="browsers-others-dialog"]',
        );
        await dialogOpen.focus();
        await here.page.keyboard.press("Enter");
        const dialog = here.page.getByRole("dialog", {
          name: "Sign out of all other browsers?",
        });
        await dialog.waitFor();
        await dialog.getByRole("button", { name: "Sign out others" }).focus();
        await here.page.keyboard.press("Enter");
        await here.page.getByText("Signed out the other browsers").waitFor();
        for (const other of [first, second])
          expect(
            (
              await other.context.request.get(`${origin}/owner/sign-ins`)
            ).status(),
          ).toBe(401);
        expect(
          (await here.context.request.get(`${origin}/owner/sign-ins`)).status(),
        ).toBe(200);
        // Nothing else is signed in, so there is nothing left to sign out.
        expect(await dialogOpen.count()).toBe(0);
        expect(await here.violations()).toEqual([]);
        expect(here.errors).toEqual([]);
      } finally {
        await second.context.close();
        await first.context.close();
        await here.context.close();
      }
    },
  );
});
