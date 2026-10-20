/**
 * Home, the way into every console page and Sign out, in a real browser
 * against a real listener under the real policy: the keyboard alone, the
 * command search, a phone's width, light and dark, a name that is markup, and
 * a session that ends under an open page.
 */
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { createConsolePages } from "../../routes/console.js";
import {
  launchTestBrowser,
  listen,
  reserveOrigin,
} from "../../test-browser.js";
import { createTestContext } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { HOME_GROUPS, createPageRegistry } from "../registry.js";
import { HOSTILE, LONG_UNBROKEN } from "../test-fixture.js";

const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const inBrowser = launched instanceof Error ? it.skip : it;

let browser: Browser;
let origin: string;
let ctx: TestContext;
let server: { close: () => Promise<void> };

/** The signed-in page every registered row here leads to, which is a real route. */
const PAGE = "/auth/owner/manage";

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
  const pages = createConsolePages(createPageRegistry(HOME_GROUPS));
  pages.register("keys", {
    href: PAGE,
    value: () => Promise.resolve({ text: "7 keys" }),
    attention: () =>
      Promise.resolve([
        {
          title: "A key has not been used in a year",
          description: "Revoke it if nothing needs it.",
          href: PAGE,
        },
      ]),
  });
  pages.register("trash", { href: PAGE });
  const app = createApp(
    ctx.storage,
    ctx.blobs,
    ctx.housekeeping,
    ctx.config,
    "instance-id-for-home",
    { consolePages: pages },
  );
  server = listen(app, reserved.port);
});

afterAll(async () => {
  if (launched instanceof Error) return;
  await browser.close();
  await server.close();
  await ctx.cleanup();
});

interface Opened {
  page: Page;
  context: BrowserContext;
  violations: () => Promise<string[]>;
  errors: string[];
}

/** A browser signed in as the owner, with every policy violation recorded. */
async function open(
  options: { scheme?: "light" | "dark"; width?: number } = {},
): Promise<Opened> {
  const context = await browser.newContext({
    colorScheme: options.scheme ?? "light",
    viewport: { width: options.width ?? 1280, height: 900 },
    extraHTTPHeaders: newAddress(),
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

let nextAddress = 1;
const newAddress = () => ({
  "x-real-ip": `198.51.100.${String(nextAddress++)}`,
});

const modifier = (page: Page) =>
  page
    .evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform))
    .then((apple) => (apple ? "Meta" : "Control"));

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function rename(name: string): Promise<void> {
  const res = await ctx.ownerRequest("/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

describe("Home", () => {
  inBrowser(
    "lists the pages with their values and what needs attention, under the real policy",
    async () => {
      const { page, context, violations, errors } = await open();
      try {
        await rename("Library");
        await page.goto(origin);
        await page
          .getByRole("heading", { name: "Library", level: 1 })
          .waitFor();
        await page.getByText("Needs attention").waitFor();
        await page.getByText("A key has not been used in a year").waitFor();
        await page.getByText("7 keys").waitFor();
        await page.getByText("Older management page").waitFor();
        // The script ran: it shows the controls the server sent hidden.
        await page.getByRole("button", { name: "Sign out" }).waitFor();
        await page
          .getByRole("button", {
            name: "Open the search for every page and setting",
          })
          .waitFor();
        expect(
          await page.evaluate(() => getComputedStyle(document.body).fontSize),
        ).toBe("13px");
        expect(await violations()).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "opens the command search from the keyboard and from its trigger, finds a page and goes to it",
    async () => {
      const { page, context, violations, errors } = await open();
      try {
        await rename("Library");
        await page.goto(origin);
        const mod = await modifier(page);
        const wrong = mod === "Meta" ? "Control" : "Meta";
        await page.getByRole("button", { name: "Sign out" }).waitFor();

        await page.keyboard.press(`${wrong}+k`);
        expect(
          await page
            .locator("#command-search")
            .evaluate((d) => (d as unknown as { open: boolean }).open),
        ).toBe(false);

        await page.keyboard.press(`${mod}+k`);
        await page.locator("#command-search[open]").waitFor();
        await page.keyboard.type("trash");
        await page.keyboard.press("Enter");
        await page.waitForURL(`${origin}${PAGE}`);

        // The trigger takes focus by Tab and opens the same search on Enter.
        await page.goto(origin);
        await page.getByRole("button", { name: "Sign out" }).waitFor();
        const trigger = page.locator("[data-command-search-open]");
        await trigger.focus();
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-command-search-open"),
          ),
        ).toBe(true);
        await page.keyboard.press("Enter");
        await page.locator("#command-search[open]").waitFor();
        await page.keyboard.press("Escape");
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-command-search-open"),
          ),
        ).toBe(true);

        expect(await violations()).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "searches by form with the keyboard alone, and a search that finds nothing says so",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(origin);
        await page.getByRole("searchbox", { name: "Search settings" }).focus();
        await page.keyboard.type("keys");
        await page.keyboard.press("Enter");
        await page.waitForURL(`${origin}/?q=keys`);
        await page.getByText("Results for “keys”").waitFor();
        await page
          .getByRole("link", { name: /API keys/ })
          .first()
          .waitFor();

        await page.goto(`${origin}/?q=zzzzzz`);
        await page.getByText("No results").waitFor();
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "signs out from Home and lands on the Signed out page, after which no console page opens",
    async () => {
      const { page, context, violations } = await open();
      try {
        await page.goto(origin);
        await page.getByRole("button", { name: "Sign out" }).click();
        await page.waitForURL(/\/auth\/oauth2\/end-session/);
        await page
          .getByRole("heading", { name: "You're signed out" })
          .waitFor();
        expect(await violations()).toEqual([]);

        await page.goto(`${origin}${PAGE}`);
        await page.waitForURL(
          `${origin}/auth/sign-in?return_to=${encodeURIComponent(PAGE)}`,
        );
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "sends a page open when the session ended to sign in, and back to that page after",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}${PAGE}?tab=keys`);
        await page.waitForLoadState();
        await context.clearCookies();
        await page.reload();
        await page.waitForURL(
          `${origin}/auth/sign-in?return_to=${encodeURIComponent(`${PAGE}?tab=keys`)}`,
        );
        await page.getByLabel("Email").fill(ctx.owner.email);
        await page
          .getByLabel("Password", { exact: true })
          .fill(ctx.owner.password);
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await page.waitForURL(`${origin}${PAGE}?tab=keys`);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "lands on Home, not off the instance, when the address to return to is not a safe one",
    async () => {
      const { context, page } = await open();
      try {
        await context.clearCookies();
        for (const bad of [
          "https://evil.example/",
          "//evil.example/x",
          "/\\evil.example",
          "/\t/evil.example",
          "/\n/evil.example",
        ]) {
          await page.goto(
            `${origin}/auth/sign-in?return_to=${encodeURIComponent(bad)}`,
          );
          await page.getByLabel("Email").fill(ctx.owner.email);
          await page
            .getByLabel("Password", { exact: true })
            .fill(ctx.owner.password);
          await page
            .getByRole("button", { name: "Sign in", exact: true })
            .click();
          await page.waitForURL(`${origin}/`);
          await page.getByRole("button", { name: "Sign out" }).waitFor();
          await context.clearCookies();
          await context.setExtraHTTPHeaders(newAddress());
        }
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "shows a name that is markup, and one with no place to break, as text that fits",
    async () => {
      const { page, context, violations } = await open({ width: 375 });
      try {
        for (const name of [HOSTILE, LONG_UNBROKEN, "W".repeat(60)]) {
          await rename(name);
          await page.goto(origin);
          await page.getByRole("button", { name: "Sign out" }).waitFor();
          expect(await page.locator("h1").textContent()).toBe(name);
          expect(await page.locator("body b").count()).toBe(0);
          expect(
            await page.evaluate(
              () => (window as unknown as { __injected?: number }).__injected,
            ),
          ).toBeUndefined();
          expect(await overflow(page), name.slice(0, 20)).toBeLessThanOrEqual(
            0,
          );
        }
        expect(await violations()).toEqual([]);
      } finally {
        await rename("Marfa");
        await context.close();
      }
    },
  );

  for (const scheme of ["light", "dark"] as const) {
    for (const width of [1280, 375]) {
      inBrowser(
        `fits with no sideways scroll in ${scheme} at ${String(width)}px, with the search open too`,
        async () => {
          const { page, context, violations } = await open({ scheme, width });
          try {
            await rename("Marfa");
            await page.goto(origin);
            await page.getByRole("button", { name: "Sign out" }).waitFor();
            expect(await overflow(page)).toBeLessThanOrEqual(0);
            expect(
              await page.evaluate(
                () => getComputedStyle(document.documentElement).colorScheme,
              ),
            ).toBe(scheme);
            await page.keyboard.press(`${await modifier(page)}+k`);
            await page.locator("#command-search[open]").waitFor();
            expect(await overflow(page)).toBeLessThanOrEqual(0);
            await page.keyboard.press("Escape");
            await page.goto(`${origin}/?q=zz`);
            expect(await overflow(page)).toBeLessThanOrEqual(0);
            expect(await violations()).toEqual([]);
          } finally {
            await context.close();
          }
        },
      );
    }
  }
});
