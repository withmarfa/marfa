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

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** Where the page header's parts are, in CSS pixels from the top left of the page. */
function headerGeometry(page: Page): Promise<{
  title: Box;
  lede: Box;
  signOut: Box;
  content: Box;
}> {
  return page.evaluate(() => {
    const box = (el: Element | null): Box => {
      if (!el) throw new Error("missing header part");
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const head = document.querySelector(".head");
    return {
      title: box(head?.querySelector("h1") ?? null),
      lede: box(head?.querySelector(".lede") ?? null),
      signOut: box(head?.querySelector("[data-sign-out]") ?? null),
      content: box(head),
    };
  });
}

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
    "focuses the search field when its icon or its padding is clicked",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(origin);
        const field = page.locator(".search");
        const input = field.locator("input");
        const focused = () =>
          page.evaluate(
            () => document.activeElement?.getAttribute("type") === "search",
          );
        await page.getByRole("button", { name: "Sign out" }).waitFor();
        expect(await focused()).toBe(false);
        await field.locator(".icon").click();
        expect(await focused()).toBe(true);
        await input.blur();
        expect(await focused()).toBe(false);
        const box = await field.boundingBox();
        await field.click({ position: { x: 3, y: (box?.height ?? 2) / 2 } });
        expect(await focused()).toBe(true);
        // The shortcut button keeps its own job: it opens the search, and the
        // field stays unfocused.
        await input.blur();
        await page.locator("[data-command-search-open]").click();
        await page.locator("#command-search[open]").waitFor();
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
    for (const width of [1280, 375, 320]) {
      inBrowser(
        `keeps Sign out at the trailing edge, level with the title, in ${scheme} at ${String(width)}px`,
        async () => {
          const { page, context } = await open({ scheme, width });
          try {
            await rename("Marfa");
            await page.goto(origin);
            const signOut = page.getByRole("button", { name: "Sign out" });
            await signOut.waitFor();
            const g = await headerGeometry(page);
            // Level with the title: its top is inside the title's line box.
            expect(g.signOut.top).toBeGreaterThanOrEqual(g.title.top - 0.5);
            expect(g.signOut.top).toBeLessThan(g.title.bottom);
            // Trailing edge of the content, inside the 16 px gutter.
            expect(g.signOut.right).toBeCloseTo(g.content.right, 0);
            expect(g.signOut.left).toBeGreaterThan(g.title.right - 0.5);
            // The address stays under the title.
            expect(g.lede.top).toBeGreaterThanOrEqual(g.title.bottom - 0.5);
            if (width < 640) {
              expect(g.content.left).toBeCloseTo(16, 0);
              expect(g.content.right).toBeCloseTo(width - 16, 0);
            }
            expect(await overflow(page)).toBeLessThanOrEqual(0);
          } finally {
            await context.close();
          }
        },
      );
    }
  }

  inBrowser(
    "lets a long name shrink inside its column while Sign out keeps its size, at 320 and 375px",
    async () => {
      const { page, context } = await open({ width: 375 });
      try {
        await rename("Marfa");
        await page.goto(origin);
        await page.getByRole("button", { name: "Sign out" }).waitFor();
        const short = (await headerGeometry(page)).signOut;
        for (const width of [375, 320]) {
          await page.setViewportSize({ width, height: 900 });
          for (const name of ["W".repeat(60), LONG_UNBROKEN]) {
            await rename(name);
            await page.goto(origin);
            await page.getByRole("button", { name: "Sign out" }).waitFor();
            const g = await headerGeometry(page);
            const label = `${String(width)}px ${name.slice(0, 12)}`;
            expect(await overflow(page), label).toBeLessThanOrEqual(0);
            expect(g.signOut.width, label).toBeCloseTo(short.width, 0);
            expect(g.signOut.height, label).toBeCloseTo(short.height, 0);
            expect(g.signOut.right, label).toBeCloseTo(g.content.right, 0);
            expect(g.signOut.top, label).toBeGreaterThanOrEqual(
              g.title.top - 0.5,
            );
            expect(g.signOut.top, label).toBeLessThan(g.title.bottom);
            expect(g.title.right, label).toBeLessThanOrEqual(
              g.signOut.left + 0.5,
            );
            expect(g.lede.right, label).toBeLessThanOrEqual(
              g.signOut.left + 0.5,
            );
            expect(g.content.left, label).toBeCloseTo(16, 0);
          }
        }
      } finally {
        await rename("Marfa");
        await context.close();
      }
    },
  );

  inBrowser(
    "tabs from the title area to Sign out and then to the search",
    async () => {
      const { page, context } = await open({ width: 375 });
      try {
        await rename("Marfa");
        await page.goto(origin);
        await page.getByRole("button", { name: "Sign out" }).waitFor();
        const active = () =>
          page.evaluate(() => {
            const el = document.activeElement;
            if (el?.hasAttribute("data-sign-out")) return "sign-out";
            return el?.getAttribute("type") ?? el?.id ?? "";
          });
        // The title and address hold nothing to focus, so the first stop
        // after the page's start is Sign out, and the search comes next.
        await page.locator("#main").focus();
        await page.keyboard.press("Tab");
        expect(await active()).toBe("sign-out");
        await page.keyboard.press("Tab");
        expect(await active()).toBe("search");
      } finally {
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
