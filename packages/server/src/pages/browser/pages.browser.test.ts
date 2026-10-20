/**
 * The page system in a real browser, served with the real policy middleware:
 * a fixture page that uses every part, and the two witness pages.
 */
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../../middleware/auth.js";
import {
  launchTestBrowser,
  listen,
  reserveOrigin,
} from "../../test-browser.js";
import { authStaticRoutes } from "../../routes/auth-static.js";
import { pageSecurityPolicy } from "../../routes/content-security-policy.js";
import { renderHttpErrorPage } from "../../routes/http-error-page.js";
import { renderSignedOutPage } from "../../routes/signed-out-page.js";
import { createTestContext } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { parsePageSize } from "../navigation.js";
import { MomentFixture, renderFixturePage } from "../test-fixture.js";
import { renderDocument } from "../render.js";

const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const inBrowser = launched instanceof Error ? it.skip : it;

let browser: Browser;
let origin: string;
let server: Server;
let real: { close: () => Promise<void> };
let realOrigin: string;
let ctx: TestContext;

const LONG = "a".repeat(400);

beforeAll(async () => {
  if (launched instanceof Error) return;
  browser = launched;

  const app = new Hono<AppEnv>();
  app.use("*", pageSecurityPolicy);
  app.route("/auth/static", authStaticRoutes());
  app.get("/fixture", (c) =>
    c.html(
      renderFixturePage({
        nonce: c.var.cspNonce,
        page: Number(c.req.query("page") ?? "1"),
        size: parsePageSize(c.req.query("size")),
      }),
    ),
  );
  // What an injection into a page would look like: an inline script and an
  // inline style attribute, neither carrying the nonce.
  app.get("/injected", (c) =>
    c.html(
      renderFixturePage({ nonce: c.var.cspNonce }).replace(
        "</body>",
        '<script>window.__injected = 1</script><p id="styled" style="color: rgb(255, 0, 0)">x</p></body>',
      ),
    ),
  );
  app.get("/moment", (c) =>
    c.html(renderDocument(MomentFixture({ nonce: c.var.cspNonce }))),
  );
  app.get("/signed-out", (c) => c.html(renderSignedOutPage(c.var.cspNonce)));
  app.get("/problem/:status", (c) =>
    c.html(
      renderHttpErrorPage(Number(c.req.param("status")), c.var.cspNonce, {
        retry: true,
      }),
    ),
  );
  app.post("/fixture/form", (c) => c.html("<p>posted</p>"));
  // A page with no stylesheet: the witness that the overflow check can fail.
  app.get("/unstyled", (c) =>
    c.html(
      `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><p>${LONG}</p></body></html>`,
    ),
  );
  const reserved = await reserveOrigin();
  origin = reserved.origin;
  server = serve({
    fetch: app.fetch,
    port: reserved.port,
    hostname: "127.0.0.1",
  }) as Server;

  const realReserved = await reserveOrigin();
  realOrigin = realReserved.origin;
  ctx = await createTestContext({ authBaseUrl: realOrigin });
  real = listen(ctx.app, realReserved.port);
});

afterAll(async () => {
  if (launched instanceof Error) return;
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  await real.close();
  await ctx.cleanup();
});

/** Records every policy violation the page reports, from before its first script. */
async function open(
  options: { scheme?: "light" | "dark"; width?: number; js?: boolean } = {},
): Promise<{
  page: Page;
  context: BrowserContext;
  violations: () => Promise<string[]>;
  errors: string[];
}> {
  const context = await browser.newContext({
    colorScheme: options.scheme ?? "light",
    viewport: { width: options.width ?? 1280, height: 900 },
    javaScriptEnabled: options.js ?? true,
  });
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
      options.js === false
        ? Promise.resolve([])
        : page.evaluate(
            () =>
              (window as unknown as { __violations: string[] }).__violations,
          ),
  };
}

const modifier = (page: Page) =>
  page
    .evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform))
    .then((apple) => (apple ? "Meta" : "Control"));

const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el
      ? (el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 40))
      : "";
  });

describe("under the real policy", () => {
  inBrowser(
    "applies the stylesheet, runs the script and is reported no violation",
    async () => {
      const { page, context, violations, errors } = await open();
      try {
        const response = await page.goto(`${origin}/fixture`);
        expect(response?.headers()["content-security-policy"]).toMatch(
          /script-src 'nonce-/,
        );
        // The stylesheet applied: a styled body and a built-in heading differ.
        expect(
          await page.evaluate(() => getComputedStyle(document.body).fontSize),
        ).toBe("13px");
        // The script ran: it shows the picker button the server sent hidden.
        await page
          .locator("[data-picker-button]")
          .waitFor({ state: "visible" });
        // Exercise what sets styles and opens things, then ask what was reported.
        await page.locator("[data-picker-button]").click();
        await page.keyboard.press("Escape");
        await page.locator('[data-dialog-open="confirm"]').first().click();
        await page.keyboard.press("Escape");
        await page.keyboard.press(`${await modifier(page)}+k`);
        await page.keyboard.type("key");
        await page.keyboard.press("Escape");
        expect(await violations()).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "still blocks a script and a style attribute that carry no nonce",
    async () => {
      const { page, context, violations } = await open();
      try {
        await page.goto(`${origin}/injected`);
        await page
          .locator("[data-picker-button]")
          .waitFor({ state: "visible" });
        expect(
          await page.evaluate(
            () =>
              "__injected" in window &&
              (window as unknown as Record<string, unknown>).__injected,
          ),
        ).toBe(false);
        expect(
          await page.evaluate(
            () => getComputedStyle(document.getElementById("styled")!).color,
          ),
        ).not.toBe("rgb(255, 0, 0)");
        const reported = await violations();
        // Witness that the listener hears what the policy blocks.
        expect(reported.some((v) => v.startsWith("script-src"))).toBe(true);
        expect(reported.some((v) => v.startsWith("style-src"))).toBe(true);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser("shows untrusted text as text", async () => {
    const { page, context } = await open();
    try {
      await page.goto(`${origin}/fixture`);
      expect(
        await page.evaluate(
          () => (window as unknown as Record<string, unknown>).__injected,
        ),
      ).toBeUndefined();
      expect(await page.locator("main b").count()).toBe(0);
      expect(await page.locator("main .lede").first().textContent()).toContain(
        "<script>window.__injected = 1</script>",
      );
    } finally {
      await context.close();
    }
  });
});

describe("the real app's own pages", () => {
  inBrowser(
    "serves a problem page a browser can use, with no violation",
    async () => {
      const { page, context, violations, errors } = await open();
      try {
        const response = await page.goto(
          `${realOrigin}/definitely-not-a-route`,
        );
        expect(response?.status()).toBe(404);
        expect(response?.headers()["x-error-code"]).toBe("not_found");
        await page
          .getByRole("heading", { name: "That page isn't here" })
          .waitFor();
        await page.getByRole("link", { name: "Go to Home" }).waitFor();
        expect(await violations()).toEqual([]);
        expect(errors.filter((e) => !e.includes("404"))).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );
});

describe("light and dark", () => {
  for (const scheme of ["light", "dark"] as const) {
    inBrowser(
      `keep every part legible in ${scheme}, with boxes one step off the page in dark`,
      async () => {
        const { page, context } = await open({ scheme });
        try {
          await page.goto(`${origin}/fixture`);
          await page
            .locator("[data-picker-button]")
            .waitFor({ state: "visible" });
          const colors = await page.evaluate(() => {
            const body = getComputedStyle(document.body).backgroundColor;
            const group = getComputedStyle(
              document.querySelector(".group")!,
            ).backgroundColor;
            return {
              body,
              group,
              scheme: getComputedStyle(document.documentElement).colorScheme,
            };
          });
          expect(colors.scheme).toBe(scheme);
          if (scheme === "light") expect(colors.group).toBe(colors.body);
          else expect(colors.group).not.toBe(colors.body);

          const failures = await page.evaluate(() => {
            const parse = (c: string): [number, number, number, number] => {
              const m = /rgba?\(([^)]+)\)/.exec(c);
              const p = (m?.[1] ?? "0,0,0").split(/[ ,/]+/).map(Number);
              return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
            };
            const lum = ([r, g, b]: number[]) => {
              const f = (v: number) => {
                const s = v / 255;
                return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
              };
              return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
            };
            const backdrop = (
              el: BrowserElement,
            ): [number, number, number, number] => {
              for (let n: BrowserElement | null = el; n; n = n.parentElement) {
                const c = parse(getComputedStyle(n).backgroundColor);
                if (c[3] > 0.5) return c;
              }
              return [255, 255, 255, 1];
            };
            const bad: string[] = [];
            for (const el of document.querySelectorAll("body *")) {
              if (!el.checkVisibility()) continue;
              if (
                el.closest(
                  "[disabled], [aria-disabled=true], dialog:not([open]), .sr, .skip",
                )
              )
                continue;
              const own = [...el.childNodes].some(
                (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
              );
              if (!own) continue;
              const fg = parse(getComputedStyle(el).color);
              const bg = backdrop(el);
              const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
              const ratio = (hi! + 0.05) / (lo! + 0.05);
              if (ratio < 4.5)
                bad.push(
                  `${el.tagName}.${el.className} "${el.textContent.trim().slice(0, 20)}" ${ratio.toFixed(2)}`,
                );
            }
            return bad;
          });
          expect(failures).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );
  }
});

describe("keyboard", () => {
  inBrowser(
    "reaches every control, with a visible focus ring on each",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}/fixture`);
        await page
          .locator("[data-picker-button]")
          .waitFor({ state: "visible" });
        const count = await page.evaluate(
          () =>
            [
              ...document.querySelectorAll(
                "a[href], button, input, select, textarea",
              ),
            ].filter(
              (el) =>
                el.checkVisibility() &&
                !el.disabled &&
                el.tabIndex >= 0 &&
                !el.closest("[aria-disabled=true]"),
            ).length,
        );
        const seen = new Set<string>();
        const noRing: string[] = [];
        for (let i = 0; i < count; i++) {
          await page.keyboard.press("Tab");
          const info = await page.evaluate(() => {
            const el = document.activeElement!;
            const own = getComputedStyle(el);
            const holder = el.closest(".search");
            const ring = (s: BrowserStyle) =>
              (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) ||
              s.boxShadow !== "none";
            const id = `${el.tagName}:${el.getAttribute("href") ?? el.getAttribute("name") ?? el.textContent.trim().slice(0, 20)}:${String(Math.round(el.getBoundingClientRect().top))}`;
            return {
              id,
              ring:
                ring(own) ||
                (holder !== null && ring(getComputedStyle(holder))),
              skip: el.classList.contains("skip"),
            };
          });
          seen.add(info.id);
          if (!info.ring) noRing.push(info.id);
        }
        expect(seen.size).toBe(count);
        expect(noRing).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "moves through the page picker and its side panel by key, and returns to its button",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}/fixture`);
        const button = page.locator("[data-picker-button]");
        await button.waitFor({ state: "visible" });
        await button.focus();
        await page.keyboard.press("Enter");
        expect(await button.getAttribute("aria-expanded")).toBe("true");
        // One level down, it opens with the page you are in beside it, on your item.
        await page.locator("#page-picker-keys").waitFor({ state: "visible" });
        expect(await active(page)).toBe("Key number 3");
        await page.keyboard.press("ArrowDown");
        expect(await active(page)).toBe("Key number 4");
        await page.keyboard.press("ArrowLeft");
        await page.locator("#page-picker-keys").waitFor({ state: "hidden" });
        expect(await active(page)).toBe("API keys");
        await page.keyboard.press("ArrowDown");
        expect(await active(page)).toBe("Connected apps");
        await page.keyboard.press("ArrowRight");
        await page.locator("#page-picker-apps").waitFor({ state: "visible" });
        expect(await active(page)).toBe("Loop");
        await page.keyboard.press("Escape");
        await page.locator("#page-picker").waitFor({ state: "hidden" });
        expect(await button.getAttribute("aria-expanded")).toBe("false");
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-picker-button"),
          ),
        ).toBe(true);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "opens a page's items on hover and closes the picker when focus leaves it",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}/fixture`);
        await page.locator("[data-picker-button]").click();
        await page
          .locator('#page-picker [data-panel="page-picker-apps"]')
          .hover();
        await page.locator("#page-picker-apps").waitFor({ state: "visible" });
        await page.locator("[data-picker-button]").focus();
        await page.keyboard.press("Tab");
        await page.locator("#page-picker").waitFor({ state: "hidden" });
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "traps focus in a dialog, closes it on Escape and gives focus back",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}/fixture`);
        const opener = page.locator('.group [data-dialog-open="confirm"]');
        await opener.focus();
        await page.keyboard.press("Enter");
        await page.locator("dialog#confirm[open]").waitFor();
        const inside = () =>
          page.evaluate(() =>
            document
              .getElementById("confirm")!
              .contains(document.activeElement),
          );
        expect(await inside()).toBe(true);
        for (let i = 0; i < 8; i++) {
          await page.keyboard.press("Tab");
          expect(
            await page.evaluate(() => {
              const el = document.activeElement;
              return (
                document.getElementById("confirm")!.contains(el) ||
                el === document.body
              );
            }),
          ).toBe(true);
        }
        // The page behind cannot take focus.
        await page.evaluate(() => {
          document.querySelector("main a")!.focus();
        });
        expect(
          (await inside()) ||
            (await page.evaluate(
              () => document.activeElement === document.body,
            )),
        ).toBe(true);
        await page.keyboard.press("Escape");
        await page
          .locator("dialog#confirm[open]")
          .waitFor({ state: "detached" })
          .catch(() => undefined);
        expect(
          await page
            .locator("dialog#confirm")
            .evaluate((d) => (d as BrowserElement).open),
        ).toBe(false);
        expect(
          await opener.evaluate((el) => el === document.activeElement),
        ).toBe(true);

        // Cancel closes and returns focus the same way; so does a click on the backdrop.
        await opener.click();
        await page.getByRole("button", { name: "Cancel" }).last().click();
        expect(
          await opener.evaluate((el) => el === document.activeElement),
        ).toBe(true);
        await opener.click();
        await page.mouse.click(4, 4);
        expect(
          await page
            .locator("dialog#confirm")
            .evaluate((d) => (d as BrowserElement).open),
        ).toBe(false);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "keeps a dialog open, and what was typed, when a drag from inside it ends on the backdrop",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}/fixture`);
        await page
          .locator("[data-picker-button]")
          .waitFor({ state: "visible" });
        await page.locator('.group [data-dialog-open="confirm"]').click();
        const field = page.locator("#confirm-note");
        await field.fill("a note worth keeping");
        const box = (await field.boundingBox())!;
        await page.mouse.move(box.x + 20, box.y + 10);
        await page.mouse.down();
        await page.mouse.move(4, 4);
        await page.mouse.up();
        expect(
          await page
            .locator("dialog#confirm")
            .evaluate((d) => (d as BrowserElement).open),
        ).toBe(true);
        expect(await field.inputValue()).toBe("a note worth keeping");
        // The reverse drag, from the backdrop into the card, keeps it open too.
        await page.mouse.move(4, 4);
        await page.mouse.down();
        await page.mouse.move(box.x + 20, box.y + 10);
        await page.mouse.up();
        expect(
          await page
            .locator("dialog#confirm")
            .evaluate((d) => (d as BrowserElement).open),
        ).toBe(true);
        // Witness: a press and release that both land on the backdrop still close it.
        await page.mouse.click(4, 4);
        expect(
          await page
            .locator("dialog#confirm")
            .evaluate((d) => (d as BrowserElement).open),
        ).toBe(false);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "filters the command search as you type, moves with the arrow keys, goes on Enter and closes on Escape",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}/fixture`);
        const mod = await modifier(page);
        const wrong = mod === "Meta" ? "Control" : "Meta";
        await page
          .locator("[data-picker-button]")
          .waitFor({ state: "visible" });
        await page.keyboard.press(`${wrong}+k`);
        expect(
          await page
            .locator("#command-search")
            .evaluate((d) => (d as BrowserElement).open),
        ).toBe(false);

        await page.getByRole("searchbox", { name: "Search settings" }).focus();
        await page.keyboard.press(`${mod}+k`);
        await page.locator("#command-search[open]").waitFor();
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-search-input"),
          ),
        ).toBe(true);
        // Empty, it suggests pages.
        expect(
          await page
            .locator("#command-search [role=option]:visible [data-title-text]")
            .allTextContents(),
        ).toContain("API keys");

        await page.keyboard.type("trash");
        const options = page.locator("#command-search [role=option]:visible");
        expect(await options.count()).toBe(2);
        expect(await options.first().getAttribute("aria-selected")).toBe(
          "true",
        );
        await page.keyboard.press("ArrowDown");
        expect(await options.nth(1).getAttribute("aria-selected")).toBe("true");
        expect(
          await page
            .locator("[data-search-input]")
            .getAttribute("aria-activedescendant"),
        ).toBe(await options.nth(1).getAttribute("id"));
        await page.keyboard.press("ArrowUp");
        expect(await options.first().getAttribute("aria-selected")).toBe(
          "true",
        );

        await page.keyboard.press("Control+a");
        await page.keyboard.type("zzzz");
        await page.locator("[data-search-none]").waitFor({ state: "visible" });

        await page.keyboard.press("Escape");
        expect(
          await page
            .locator("#command-search")
            .evaluate((d) => (d as BrowserElement).open),
        ).toBe(false);
        expect(
          await page.evaluate(() =>
            document.activeElement?.getAttribute("aria-label"),
          ),
        ).toBe("Search settings");

        await page.keyboard.press(`${mod}+k`);
        await page.keyboard.type("settings");
        await page.keyboard.press("Enter");
        await page.waitForURL(/\/fixture\/settings/);
        expect(await page.locator("dialog#command-search").count()).toBe(0);
      } finally {
        await context.close();
      }
    },
  );
});

describe("forms", () => {
  inBrowser(
    "reveals a password, shows inline errors, then the submitting state",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}/fixture`);
        await page
          .locator("[data-picker-button]")
          .waitFor({ state: "visible" });
        const toggle = page.locator("[data-password-toggle]");
        expect(await toggle.isVisible()).toBe(false);
        await page.locator("#password").fill("hunter2");
        await toggle.waitFor({ state: "visible" });
        await toggle.click();
        expect(await page.locator("#password").getAttribute("type")).toBe(
          "text",
        );
        expect(await toggle.getAttribute("aria-pressed")).toBe("true");
        await toggle.click();
        expect(await page.locator("#password").getAttribute("type")).toBe(
          "password",
        );

        await page.locator("#name").fill("");
        await page.getByRole("button", { name: "Save" }).click();
        await page.locator("#name-js-err").waitFor();
        expect(await page.locator("#name").getAttribute("aria-invalid")).toBe(
          "true",
        );
        expect(await page.evaluate(() => document.activeElement?.id)).toBe(
          "name",
        );
        await page.locator("#name").fill("Ada");
        await page.locator("#name-js-err").waitFor({ state: "detached" });

        await page.locator("#email").fill("ada@example.com");
        await Promise.all([
          page.waitForURL(/\/fixture\/form/),
          page.getByRole("button", { name: "Save" }).click(),
        ]);
        await page.goBack({ waitUntil: "commit" });
        const save = page.getByRole("button", { name: "Save" });
        await save.waitFor();
        expect(await save.isDisabled()).toBe(false);
      } finally {
        await context.close();
      }
    },
  );
});

describe("rows per page", () => {
  inBrowser(
    "changes the list on choosing a size, and keeps the size across pages",
    async () => {
      const { page, context, violations } = await open();
      try {
        await page.goto(`${origin}/fixture`);
        const rows = page.locator(".row", { hasText: /^Key / });
        expect(await rows.count()).toBe(10);
        const select = page.getByLabel("Rows per page");
        expect(await select.inputValue()).toBe("10");
        await page.getByRole("link", { name: "Next page" }).click();
        await page.waitForURL(/page=2/);
        expect(page.url()).toContain("size=10");
        // A new size starts again from the first page.
        await page.getByLabel("Rows per page").selectOption("25");
        await page.waitForURL(/size=25/);
        expect(page.url()).not.toContain("page=2");
        expect(await page.getByLabel("Rows per page").inputValue()).toBe("25");
        // The fixture holds 23 keys, so 25 rows show them all.
        expect(await rows.count()).toBe(23);
        expect(await violations()).toEqual([]);

        // Untidy sizes fall back to ten rows rather than failing.
        for (const bad of ["-5", "0", "999999999", "abc", "", "10.5"]) {
          await page.goto(`${origin}/fixture?size=${bad}`);
          expect(await rows.count(), bad).toBe(10);
        }
        for (const bad of ["-1", "0", "abc", "99999"]) {
          const res = await page.goto(`${origin}/fixture?page=${bad}`);
          expect(res?.status(), bad).toBe(200);
        }
      } finally {
        await context.close();
      }
    },
  );
});

describe("without the script", () => {
  inBrowser(
    "says the page needs JavaScript and leaves no control that does nothing",
    async () => {
      const { page, context } = await open({ js: false });
      try {
        await page.goto(`${origin}/fixture`);
        expect(await page.locator("noscript p").textContent()).toContain(
          "needs JavaScript",
        );
        expect(await page.locator("[data-picker-button]").isVisible()).toBe(
          false,
        );
        expect(await page.locator(".pw-toggle").isVisible()).toBe(false);
        // The page is longer than ten rows, so its pager is there to be seen
        // without the script, and the select that needs one is not.
        expect(
          await page.getByRole("link", { name: "Next page" }).count(),
        ).toBe(1);
        expect(await page.getByLabel("Rows per page").isVisible()).toBe(false);
        expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser("still renders when the script fails to load", async () => {
    const { page, context, errors } = await open();
    try {
      await page.route("**/auth/static/pages.js*", (route) => route.abort());
      await page.goto(`${origin}/fixture`);
      expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
      expect(await page.locator("[data-picker-button]").isVisible()).toBe(
        false,
      );
      expect(errors.filter((e) => !e.includes("ERR_FAILED"))).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe("at 375 pixels", () => {
  const overflow = (page: Page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );

  inBrowser(
    "shows no sideways scroll on any page, long unbroken text included",
    async () => {
      const { page, context } = await open({ width: 375 });
      try {
        for (const path of [
          "/fixture",
          "/fixture?page=3",
          "/fixture?size=50",
          "/moment",
          "/signed-out",
          "/problem/404",
          "/problem/403",
          "/problem/429",
          "/problem/500",
        ]) {
          await page.goto(`${origin}${path}`);
          expect(await overflow(page), path).toBeLessThanOrEqual(0);
        }
        await page.goto(`${realOrigin}/definitely-not-a-route`);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "keeps a page header's action beside its title, at the trailing edge, however long the title",
    async () => {
      for (const width of [375, 320]) {
        const { page, context } = await open({ width });
        try {
          await page.goto(`${origin}/fixture`);
          const g = await page.evaluate(() => {
            const head = document.querySelector(".head");
            const rect = (el: Element | null | undefined) => {
              if (!el) throw new Error("missing header part");
              const r = el.getBoundingClientRect();
              return {
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
              };
            };
            return {
              title: rect(head?.querySelector("h1")),
              action: rect(head?.querySelector(".actions .btn")),
              head: rect(head),
            };
          });
          const label = `${String(width)}px`;
          expect(g.action.top, label).toBeGreaterThanOrEqual(g.title.top - 0.5);
          expect(g.action.top, label).toBeLessThan(g.title.bottom);
          expect(g.action.right, label).toBeCloseTo(g.head.right, 0);
          expect(g.title.right, label).toBeLessThanOrEqual(g.action.left + 0.5);
          expect(await overflow(page), label).toBeLessThanOrEqual(0);
        } finally {
          await context.close();
        }
      }
    },
  );

  inBrowser(
    "shows none with the picker, a dialog or the command search open",
    async () => {
      const { page, context } = await open({ width: 375 });
      try {
        await page.goto(`${origin}/fixture`);
        await page.locator("[data-picker-button]").click();
        await page.locator("#page-picker").waitFor({ state: "visible" });
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        const box = await page.locator("#page-picker").boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(375);
        await page.keyboard.press("Escape");
        await page.locator('.group [data-dialog-open="confirm"]').click();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await page.keyboard.press("Escape");
        await page.keyboard.press(`${await modifier(page)}+k`);
        await page.locator("#command-search[open]").waitFor();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser("would report overflow on a page with no stylesheet", async () => {
    const { page, context } = await open({ width: 375 });
    try {
      await page.goto(`${origin}/unstyled`);
      expect(await overflow(page)).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});

describe("the witness pages", () => {
  inBrowser(
    "show the signed-out and problem screens with a way back",
    async () => {
      const { page, context, violations } = await open();
      try {
        await page.goto(`${origin}/signed-out`);
        await page
          .getByRole("heading", { name: "You're signed out" })
          .waitFor();
        expect(
          await page
            .getByRole("link", { name: "Sign in to Marfa" })
            .getAttribute("href"),
        ).toBe("/auth/sign-in");
        for (const [status, title] of [
          [404, "That page isn't here"],
          [403, "You can't open this page"],
          [429, "Too many attempts"],
          [500, "Something went wrong"],
        ] as const) {
          await page.goto(`${origin}/problem/${String(status)}`);
          await page.getByRole("heading", { name: title }).waitFor();
          expect(
            await page
              .getByRole("link", { name: "Go to Home" })
              .getAttribute("href"),
          ).toBe("/");
          expect(await page.getByText(`Error ${String(status)}`).count()).toBe(
            1,
          );
        }
        expect(
          await page.getByRole("link", { name: "Try again" }).count(),
        ).toBe(1);
        expect(await violations()).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );
});
