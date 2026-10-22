/**
 * The claim and setup screens in a real browser, against the real routes: the
 * whole sequence, each way it is refused, scripting off, the keyboard alone,
 * both colour schemes and a phone's width.
 */
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Locator,
  Page,
} from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";
import { createClaimTestApp } from "../../auth/claim-test-app.js";
import * as clock from "../../clock.js";
import {
  getClaimStatus,
  issueSetupCode,
  issueSetupTicket,
} from "../../auth/instance-claim.js";
import { launchTestBrowser, reserveOrigin } from "../../test-browser.js";

const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const browser: Browser | null = launched instanceof Error ? null : launched;
const inBrowser = browser ? it : it.skip;
afterAll(async () => {
  await browser?.close();
});

const OWNER = { email: "owner@example.com", password: "correct horse battery" };

/**
 * A fresh unclaimed instance on a localhost address, which a passkey needs
 * because an address of numbers cannot be a relying party.
 */
async function withInstance(
  run: (instance: {
    origin: string;
    ctx: Awaited<ReturnType<typeof createClaimTestApp>>;
  }) => Promise<void>,
): Promise<void> {
  const reserved = await reserveOrigin();
  const origin = reserved.origin.replace("127.0.0.1", "localhost");
  const ctx = await createClaimTestApp(origin);
  const server = serve({
    fetch: ctx.app.fetch,
    hostname: "127.0.0.1",
    port: reserved.port,
  }) as Server;
  try {
    await run({ origin, ctx });
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    await ctx.cleanup();
  }
}

interface Opened {
  context: BrowserContext;
  page: Page;
  violations: () => Promise<string[]>;
  errors: string[];
}

async function open(
  options: { js?: boolean; scheme?: "light" | "dark"; width?: number } = {},
): Promise<Opened> {
  const context = await browser!.newContext({
    javaScriptEnabled: options.js ?? true,
    colorScheme: options.scheme ?? "light",
    viewport: { width: options.width ?? 1280, height: 900 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    // A failed load is reported by address below.
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource")
    )
      errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() === 404)
      errors.push(`404 ${new URL(response.url()).pathname}`);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      w.__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return {
    context,
    page,
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

async function virtualAuthenticator(
  context: BrowserContext,
  page: Page,
): Promise<CDPSession> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

/** Waits for the page to settle on what is asked, as Playwright's own matchers would. */
const textOf = (locator: Locator) =>
  expect.poll(async () => ((await locator.textContent()) ?? "").trim());
const valueOf = (locator: Locator) => expect.poll(() => locator.inputValue());
const attributeOf = (locator: Locator, name: string) =>
  expect.poll(() => locator.getAttribute(name));
const isFocused = (locator: Locator) =>
  expect.poll(() =>
    locator.evaluate((el) => (el as BrowserElement) === document.activeElement),
  );

const sessionCookie = async (context: BrowserContext) =>
  (await context.cookies()).find((cookie) =>
    cookie.name.includes("session_token"),
  );

/** Past step 1 by the typed code, so the page under test is the details form. */
async function toDetails(page: Page, origin: string, code: string) {
  await page.goto(`${origin}/setup`);
  await page.fill("#code", code);
  await page.click("#code-form button[type=submit]");
  await page.locator("#owner-form").waitFor();
}

async function claim(page: Page, email = OWNER.email) {
  await page.fill("#email", email);
  await page.fill("#password", OWNER.password);
  await page.click("#owner-form button[type=submit]");
}

describe("the whole sequence", () => {
  inBrowser(
    "takes a person from the handoff link to the last step, signed in, with a passkey added and no second sign-in",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const { context, page, violations, errors } = await open();
        try {
          await virtualAuthenticator(context, page);
          await issueSetupCode(ctx.storage);
          const { ticket } = await issueSetupTicket(ctx.storage);
          let exchanges = 0;
          page.on("request", (request) => {
            if (request.url().endsWith("/setup/exchange")) exchanges++;
          });
          await page.goto(`${origin}/setup#handoff=${ticket}`);
          await page.locator("#owner-form").waitFor();
          expect(page.url()).toBe(`${origin}/setup`);
          expect(exchanges).toBe(1);
          expect(
            await page.getByRole("img", { name: "Step 2 of 6" }).count(),
          ).toBe(1);
          // The refresh and the way back keep the details form, with no second exchange.
          await page.reload();
          await page.locator("#owner-form").waitFor();
          await page.goto(`${origin}/definitely-not-here`);
          await page.goBack({ waitUntil: "commit" });
          errors.splice(0);
          await page.locator("#owner-form").waitFor();
          expect(exchanges).toBe(1);

          await claim(page);
          await page.waitForURL(`${origin}/setup/passkey`);
          expect((await getClaimStatus(ctx.storage)).claimed).toBe(true);
          expect(await sessionCookie(context)).toBeDefined();
          await page.getByRole("img", { name: "Step 3 of 6" }).waitFor();

          // A passkey needs a sign-in within five minutes, and the claim was one.
          await page.getByRole("button", { name: "Add passkey" }).click();
          await page.getByText("Passkey added", { exact: true }).waitFor();
          await page.getByRole("link", { name: "Continue" }).click();

          await page.waitForURL(`${origin}/setup/name`);
          // Back and Continue share the width, as the pair on every other step does.
          const pair = await Promise.all(
            [
              page.getByRole("link", { name: "Back" }),
              page.getByRole("button", { name: "Continue" }),
            ].map(async (control) => (await control.boundingBox())!.width),
          );
          expect(Math.abs(pair[0]! - pair[1]!)).toBeLessThanOrEqual(1);
          expect(pair[0]).toBeGreaterThan(100);
          await page.fill("#instance-name", "Library");
          await page.getByRole("button", { name: "Continue" }).click();
          await page.waitForURL(`${origin}/setup/connect`);
          await page
            .getByText(`marfa --url ${origin} login`, { exact: true })
            .waitFor();
          await page.getByRole("link", { name: "Continue" }).click();
          await page.waitForURL(`${origin}/setup/backups`);
          expect(errors).toEqual([]);
          await page.getByRole("link", { name: "Done" }).click();
          await page.waitForURL(`${origin}/`);
          // This test app mounts no Home, so the address answers 404 here; the page
          // itself is read by the Home tests.

          expect(await violations()).toEqual([]);
        } finally {
          await context.close();
        }
      });
    },
    60_000,
  );

  inBrowser(
    "goes back from the details to the setup code, and forward again with the code",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const { context, page } = await open();
        try {
          const { code } = await issueSetupCode(ctx.storage);
          await toDetails(page, origin, code);
          const back = page.getByRole("link", { name: "Back" });
          const claimButton = page.getByRole("button", {
            name: "Claim Marfa",
          });
          const widths = async () =>
            Promise.all(
              [back, claimButton].map(async (control) =>
                Math.round((await control.boundingBox())!.width),
              ),
            );
          const [backWidth, claimWidth] = await widths();
          expect(Math.abs(backWidth! - claimWidth!)).toBeLessThanOrEqual(1);
          await back.click();
          await page.locator("#code-form").waitFor();
          await page.getByRole("img", { name: "Step 1 of 6" }).waitFor();
          // Nothing was undone: a refresh goes on to the details, and the claim is still open.
          await page.goto(`${origin}/setup`);
          await page.locator("#owner-form").waitFor();
          await page.getByRole("link", { name: "Back" }).click();
          await page.fill("#code", code);
          await page.click("#code-form button[type=submit]");
          await page.locator("#owner-form").waitFor();
          expect((await getClaimStatus(ctx.storage)).claimed).toBe(false);
        } finally {
          await context.close();
        }
      });
    },
  );

  inBrowser("puts the Copy label back after two quick clicks", async () => {
    await withInstance(async ({ origin }) => {
      const { context, page } = await open();
      try {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin,
        });
        await page.goto(`${origin}/setup`);
        await page.getByText("Where's my setup code?").click();
        const copy = page.getByRole("button", {
          name: "Copy marfa --socket PATH setup code",
        });
        await copy.click();
        await textOf(copy).toBe("Copied");
        await copy.click();
        await textOf(copy).toBe("Copied");
        // Both timers have run by now, and the label is the one it started with.
        await page.waitForTimeout(2500);
        expect(await copy.textContent()).toBe("Copy");
      } finally {
        await context.close();
      }
    });
  });

  inBrowser("accepts a code typed in groups and any case", async () => {
    await withInstance(async ({ origin, ctx }) => {
      const { context, page } = await open();
      try {
        const { code } = await issueSetupCode(ctx.storage);
        await toDetails(page, origin, code.toLowerCase());
        await claim(page);
        await page.waitForURL(`${origin}/setup/passkey`);
      } finally {
        await context.close();
      }
    });
  });
});

describe("when the claim is refused", () => {
  inBrowser(
    "says what is wrong with the code in place, marks the field and puts focus on it",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const { context, page } = await open();
        try {
          await issueSetupCode(ctx.storage);
          await page.goto(`${origin}/setup`);
          const loaded = page.url();
          // Empty first: the browser's own check, in the page's words.
          await page.click("#code-form button[type=submit]");
          await textOf(page.locator("#code-js-err")).toBe(
            "Enter the setup code.",
          );
          await page.fill("#code", "WRONG-CODE-12345");
          await page.click("#code-form button[type=submit]");
          await textOf(page.locator("#code-js-err")).toBe(
            "That setup code isn't right. Check it and try again.",
          );
          await attributeOf(page.locator("#code"), "aria-invalid").toBe("true");
          await isFocused(page.locator("#code")).toBe(true);
          expect(page.url()).toBe(loaded);
          // The same field takes a corrected code.
          await valueOf(page.locator("#code")).toBe("WRONG-CODE-12345");
          // The button is usable again, not left sending.
          await expect
            .poll(() =>
              page.locator("#code-form button[type=submit]").isEnabled(),
            )
            .toBe(true);
        } finally {
          await context.close();
        }
      });
    },
  );

  inBrowser("names the wait once the address has used its tries", async () => {
    await withInstance(async ({ origin, ctx }) => {
      const { context, page } = await open();
      try {
        await issueSetupCode(ctx.storage);
        for (let attempt = 0; attempt < 10; attempt++) {
          const refused = await fetch(`${origin}/setup/exchange`, {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({ code: "WRONG-CODE" }),
          });
          expect(refused.status).toBe(401);
        }
        await page.goto(`${origin}/setup`);
        await page.fill("#code", "WRONG-CODE-12345");
        await page.click("#code-form button[type=submit]");
        await textOf(page.locator("#code-js-err")).toMatch(
          /^Too many tries\. Try again in \d+ minutes\.$/,
        );
        await isFocused(page.locator("#code")).toBe(true);
      } finally {
        await context.close();
      }
    });
  });

  inBrowser(
    "says a spent link is spent, takes the link out of the address, and leaves the code form to use",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const { context, page } = await open();
        try {
          const { code } = await issueSetupCode(ctx.storage);
          const { ticket } = await issueSetupTicket(ctx.storage);
          const spent = await fetch(`${origin}/setup/exchange`, {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({ ticket }),
          });
          expect(spent.status).toBe(200);
          await page.goto(`${origin}/setup#handoff=${ticket}`);
          await textOf(
            page.locator('[data-notice="error"]:not([hidden])'),
          ).toContain("That setup link has expired or was already used.");
          expect(page.url()).toBe(`${origin}/setup`);
          await page.fill("#code", code);
          await page.click("#code-form button[type=submit]");
          await page.locator("#owner-form").waitFor();
        } finally {
          await context.close();
        }
      });
    },
  );

  inBrowser(
    "keeps what was typed and leaves nothing half done when the network fails mid-claim",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const { context, page } = await open();
        try {
          const { code } = await issueSetupCode(ctx.storage);
          await toDetails(page, origin, code);
          await page.route("**/owner", (route) => route.abort("failed"));
          await claim(page);
          await textOf(
            page.locator('[data-notice="error"]:not([hidden])'),
          ).toContain("Marfa didn't answer.");
          await valueOf(page.locator("#password")).toBe("");
          await valueOf(page.locator("#email")).toBe(OWNER.email);
          await expect
            .poll(() =>
              page.locator("#owner-form button[type=submit]").isEnabled(),
            )
            .toBe(true);
          expect((await getClaimStatus(ctx.storage)).claimed).toBe(false);
          expect(await sessionCookie(context)).toBeUndefined();
          // Nothing was spent: the same form claims once the network is back.
          await page.unroute("**/owner");
          await claim(page);
          await page.waitForURL(`${origin}/setup/passkey`);
          expect(await sessionCookie(context)).toBeDefined();
        } finally {
          await context.close();
        }
      });
    },
  );

  inBrowser(
    "shows each field's refusal at once before sending anything, and signs nobody in",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const { context, page } = await open();
        try {
          const { code } = await issueSetupCode(ctx.storage);
          await toDetails(page, origin, code);
          let sent = 0;
          page.on("request", (request) => {
            if (request.url().endsWith("/owner")) sent++;
          });
          await page.fill("#email", "not an email");
          await page.fill("#password", "short");
          await page.click("#owner-form button[type=submit]");
          await textOf(page.locator("#email-js-err")).toBe(
            "Enter a valid email address.",
          );
          await textOf(page.locator("#password-js-err")).toBe(
            "Use at least 8 characters.",
          );
          // The message stands in for the hint, as a server-rendered one does.
          expect(await page.locator("#password-hint").isVisible()).toBe(false);
          expect(await page.getAttribute("#password", "aria-describedby")).toBe(
            "password-js-err",
          );
          await isFocused(page.locator("#email")).toBe(true);
          expect(sent).toBe(0);
          expect(await sessionCookie(context)).toBeUndefined();
        } finally {
          await context.close();
        }
      });
    },
  );

  inBrowser(
    "shows the server's refusal of an address the browser accepts under its field",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const { context, page } = await open();
        try {
          const { code } = await issueSetupCode(ctx.storage);
          await toDetails(page, origin, code);
          await page.fill("#email", "owner@localhost");
          await page.fill("#password", OWNER.password);
          await page.click("#owner-form button[type=submit]");
          await attributeOf(page.locator("#email"), "aria-invalid").toBe(
            "true",
          );
          await textOf(page.locator("#email-js-err")).toMatch(/email/i);
          await isFocused(page.locator("#email")).toBe(true);
          await valueOf(page.locator("#password")).toBe("");
          expect(await sessionCookie(context)).toBeUndefined();
        } finally {
          await context.close();
        }
      });
    },
  );

  inBrowser(
    "gives a race to one browser, and leaves the other with the claimed page and no session",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const first = await open();
        const second = await open();
        try {
          const { code } = await issueSetupCode(ctx.storage);
          await toDetails(first.page, origin, code);
          await toDetails(second.page, origin, code);
          await claim(first.page);
          await first.page.waitForURL(`${origin}/setup/passkey`);
          await claim(second.page, "other@example.com");
          await second.page
            .getByRole("heading", {
              name: "This Marfa already has an owner",
            })
            .waitFor();
          await second.page.getByRole("link", { name: "Sign in" }).waitFor();
          expect(await sessionCookie(first.context)).toBeDefined();
          expect(await sessionCookie(second.context)).toBeUndefined();
          expect((await getClaimStatus(ctx.storage)).claimed).toBe(true);
        } finally {
          await first.context.close();
          await second.context.close();
        }
      });
    },
  );

  inBrowser("shows the claimed page, with a way to sign in", async () => {
    await withInstance(async ({ origin, ctx }) => {
      const { context, page } = await open();
      try {
        const { code } = await issueSetupCode(ctx.storage);
        await toDetails(page, origin, code);
        await claim(page);
        await page.waitForURL(`${origin}/setup/passkey`);
        const other = await open();
        try {
          await other.page.goto(`${origin}/setup`);
          await other.page
            .getByRole("heading", { name: "This Marfa already has an owner" })
            .waitFor();
          await other.page.getByRole("link", { name: "Sign in" }).click();
          await other.page.waitForURL(`${origin}/auth/sign-in`);
        } finally {
          await other.context.close();
        }
      } finally {
        await context.close();
      }
    });
  });
});

describe("with scripting off", () => {
  inBrowser(
    "claims through the forms, signs the owner in and lands on the passkey step",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const { context, page } = await open({ js: false });
        try {
          const { code } = await issueSetupCode(ctx.storage);
          await page.goto(`${origin}/setup`);
          expect(await page.locator("noscript").count()).toBe(1);
          await page.fill("#code", "WRONG-CODE-12345");
          await page.click("#code-form button[type=submit]");
          await textOf(page.locator("#code-err")).toBe(
            "That setup code isn't right. Check it and try again.",
          );
          await isFocused(page.locator("#code")).toBe(true);
          await page.fill("#code", code);
          await page.click("#code-form button[type=submit]");
          await page.locator("#owner-form").waitFor();
          await page.fill("#email", OWNER.email);
          await page.fill("#password", "short");
          await page.click("#owner-form button[type=submit]");
          await textOf(page.locator("#password-err")).toContain(
            "8 to 128 characters",
          );
          await valueOf(page.locator("#email")).toBe(OWNER.email);
          await page.fill("#password", OWNER.password);
          await page.click("#owner-form button[type=submit]");
          await page.waitForURL(`${origin}/setup/passkey`);
          expect(await sessionCookie(context)).toBeDefined();
          await page.getByRole("heading", { name: "Add a passkey" }).waitFor();
          // Passkeys need the script, and the page says so rather than offering a dead button.
          expect(
            await page.getByRole("button", { name: "Add passkey" }).isVisible(),
          ).toBe(false);
          await page.getByRole("link", { name: "Skip", exact: true }).click();
          await page.waitForURL(`${origin}/setup/name`);
          await page.fill("#instance-name", "No script");
          await page.getByRole("button", { name: "Continue" }).click();
          await page.waitForURL(`${origin}/setup/connect`);
        } finally {
          await context.close();
        }
      });
    },
  );
});

describe("by keyboard alone", () => {
  inBrowser(
    "tabs through each step in reading order, shows where focus is, and submits with Enter",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const { context, page } = await open();
        const focused = () =>
          page.evaluate(() => {
            const el = document.activeElement!;
            const style = getComputedStyle(el);
            return {
              name:
                [
                  el.getAttribute("aria-label"),
                  el.id,
                  el.textContent.trim().slice(0, 30),
                ].find((part) => part !== null && part !== "") ?? "",
              ring:
                (style.outlineStyle !== "none" &&
                  parseFloat(style.outlineWidth) > 0) ||
                style.boxShadow !== "none",
            };
          });
        try {
          const { code } = await issueSetupCode(ctx.storage);
          await page.goto(`${origin}/setup`);
          const order: string[] = [];
          for (let tab = 0; tab < 4; tab++) {
            await page.keyboard.press("Tab");
            const where = await focused();
            expect(where.ring, where.name).toBe(true);
            order.push(where.name);
          }
          expect(order).toEqual([
            "Skip to content",
            "code",
            "Where's my setup code?",
            "Continue",
          ]);
          await page.focus("#code");
          await page.keyboard.type(code);
          await page.keyboard.press("Enter");
          await page.locator("#owner-form").waitFor();

          const details: string[] = [];
          await page.focus("#email");
          await page.keyboard.type(OWNER.email);
          for (let tab = 0; tab < 5; tab++) {
            await page.keyboard.press("Tab");
            const where = await focused();
            expect(where.ring, where.name).toBe(true);
            details.push(where.name);
            if (tab === 0) await page.keyboard.type("Ada");
            if (tab === 1) await page.keyboard.type(OWNER.password);
          }
          expect(details).toEqual([
            "name",
            "password",
            "Show password",
            "Back",
            "Claim Marfa",
          ]);
          await page.focus("#password");
          await page.keyboard.press("Enter");
          await page.waitForURL(`${origin}/setup/passkey`);
        } finally {
          await context.close();
        }
      });
    },
  );
});

describe("light, dark and a phone's width", () => {
  inBrowser(
    "keeps every step legible in both schemes and inside 375 pixels",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const { context, page, violations } = await open();
        const check = async (label: string) => {
          for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            const surface = await page.evaluate(() => {
              const card = document.querySelector(".card");
              return {
                body: getComputedStyle(document.body).backgroundColor,
                card: card ? getComputedStyle(card).backgroundColor : "",
                scheme: getComputedStyle(document.documentElement).colorScheme,
              };
            });
            expect(surface.scheme, `${label} ${scheme}`).toBe(scheme);
            if (scheme === "dark")
              expect(surface.card, label).not.toBe(surface.body);
            const weak = await page.evaluate(() => {
              const parse = (c: string): number[] => {
                const m = /rgba?\(([^)]+)\)/.exec(c);
                return (m?.[1] ?? "0,0,0").split(/[ ,/]+/).map(Number);
              };
              const lum = (rgb: number[]) => {
                const f = (v: number) => {
                  const s = v / 255;
                  return s <= 0.03928
                    ? s / 12.92
                    : ((s + 0.055) / 1.055) ** 2.4;
                };
                return (
                  0.2126 * f(rgb[0]!) +
                  0.7152 * f(rgb[1]!) +
                  0.0722 * f(rgb[2]!)
                );
              };
              const backdrop = (el: BrowserElement): number[] => {
                for (
                  let n: BrowserElement | null = el;
                  n;
                  n = n.parentElement
                ) {
                  const c = parse(getComputedStyle(n).backgroundColor);
                  if ((c[3] ?? 1) > 0.5) return c;
                }
                return [255, 255, 255];
              };
              const bad: string[] = [];
              for (const el of document.querySelectorAll("body *")) {
                if (!el.checkVisibility()) continue;
                if (el.closest("[hidden], .sr, .skip, [disabled]")) continue;
                const own = [...el.childNodes].some(
                  (n) =>
                    n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
                );
                if (!own) continue;
                const [hi, lo] = [
                  lum(parse(getComputedStyle(el).color)),
                  lum(backdrop(el)),
                ].sort((a, b) => b - a);
                const ratio = (hi! + 0.05) / (lo! + 0.05);
                if (ratio < 4.5)
                  bad.push(
                    `${el.tagName}.${el.className} "${el.textContent.trim().slice(0, 20)}" ${ratio.toFixed(2)}`,
                  );
              }
              return bad;
            });
            expect(weak, `${label} ${scheme}`).toEqual([]);
          }
          await page.emulateMedia({ colorScheme: "light" });
          await page.setViewportSize({ width: 375, height: 812 });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
            `${label} at 375 pixels`,
          ).toBe(true);
          await page.setViewportSize({ width: 1280, height: 900 });
        };
        try {
          const { code } = await issueSetupCode(ctx.storage);
          await page.goto(`${origin}/setup`);
          await page.locator("#code-form").waitFor();
          await page.locator("details summary").click();
          await check("step 1");
          await page.fill("#code", code);
          await page.click("#code-form button[type=submit]");
          await page.locator("#owner-form").waitFor();
          await check("step 2");
          await claim(page);
          await page.waitForURL(`${origin}/setup/passkey`);
          await check("step 3");
          for (const step of ["name", "connect", "backups"]) {
            await page.goto(`${origin}/setup/${step}`);
            await check(`step ${step}`);
          }
          await page.goto(`${origin}/setup`);
          await check("claimed");
          expect(await violations()).toEqual([]);
        } finally {
          await context.close();
        }
      });
    },
    60_000,
  );
});

describe("the passkey step with a sign-in older than five minutes", () => {
  inBrowser(
    "asks to confirm it's you, then adds the passkey once, and nothing when the person cancels",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const { context, page } = await open();
        clock.installDateShim();
        try {
          await virtualAuthenticator(context, page);
          await issueSetupCode(ctx.storage);
          const { ticket } = await issueSetupTicket(ctx.storage);
          await page.goto(`${origin}/setup#handoff=${ticket}`);
          await page.locator("#owner-form").waitFor();
          await claim(page);
          await page.waitForURL(`${origin}/setup/passkey`);
          clock.advanceClock(6 * 60_000);

          const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
          const credentials = async (): Promise<number> => {
            const { ownerId } = await getClaimStatus(ctx.storage);
            return ownerId === null
              ? 0
              : (await ctx.auth.listOwnerPasskeys(ownerId)).length;
          };
          const add = page.getByRole("button", { name: "Add passkey" });

          // Cancelling asks for nothing more and makes no passkey.
          await add.click();
          await dialog.waitFor();
          expect(await dialog.innerText()).toContain(
            "To add a passkey, confirm it's you. Changes like this need a sign-in from the last 5 minutes.",
          );
          await dialog.getByRole("button", { name: "Cancel" }).click();
          await dialog.waitFor({ state: "hidden" });
          expect(await credentials()).toBe(0);
          expect(await add.isEnabled()).toBe(true);

          // A wrong password says so in place; the right one carries on.
          await add.click();
          await dialog.waitFor();
          await dialog.getByLabel("Or your password").fill("not the password");
          await dialog.getByRole("button", { name: "Continue" }).click();
          await dialog
            .getByText("That password is wrong. Try again.")
            .waitFor();
          await dialog.getByLabel("Or your password").fill(OWNER.password);
          await dialog.getByRole("button", { name: "Continue" }).click();
          await page.getByText("Passkey added", { exact: true }).waitFor();
          expect(await credentials()).toBe(1);
        } finally {
          clock.resetClockForTests();
          await context.close();
        }
      });
    },
  );

  inBrowser(
    "sends the passkey again after a password when the five minutes run out during the prompt",
    async () => {
      await withInstance(async ({ origin, ctx }) => {
        const { context, page } = await open();
        clock.installDateShim();
        try {
          await virtualAuthenticator(context, page);
          await issueSetupCode(ctx.storage);
          const { ticket } = await issueSetupTicket(ctx.storage);
          await page.goto(`${origin}/setup#handoff=${ticket}`);
          await page.locator("#owner-form").waitFor();
          await claim(page);
          await page.waitForURL(`${origin}/setup/passkey`);
          let verifies = 0;
          let options = 0;
          await page.route(
            "**/auth/passkey/generate-register-options",
            async (route) => {
              options += 1;
              await route.continue();
            },
          );
          await page.route(
            "**/auth/passkey/verify-registration",
            async (route) => {
              verifies += 1;
              // The session ages without the clock moving, which would also
              // end the challenge the prompt is holding.
              if (verifies === 1)
                await (
                  ctx.storage as unknown as {
                    __sqliteRun: (s: string, p: unknown[]) => Promise<unknown>;
                  }
                ).__sqliteRun(
                  "UPDATE auth_session SET created_at = created_at - 360",
                  [],
                );
              await route.continue();
            },
          );
          await page.getByRole("button", { name: "Add passkey" }).click();
          const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
          await dialog.waitFor();
          await dialog.getByLabel("Or your password").fill(OWNER.password);
          await dialog.getByRole("button", { name: "Continue" }).click();
          await page.getByText("Passkey added", { exact: true }).waitFor();
          // The password leaves the first challenge good, so the credential
          // already made is sent again and no second one is made.
          expect(options).toBe(1);
          expect(verifies).toBe(2);
          const { ownerId } = await getClaimStatus(ctx.storage);
          expect((await ctx.auth.listOwnerPasskeys(ownerId ?? "")).length).toBe(
            1,
          );
        } finally {
          clock.resetClockForTests();
          await context.close();
        }
      });
    },
  );
});
