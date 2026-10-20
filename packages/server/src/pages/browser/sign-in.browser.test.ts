/**
 * Sign in, the lockout and Forgot password, in a real browser against a real
 * listener under the real policy: the keyboard alone, a phone's width, light
 * and dark, a browser with scripting off, a passkey, and the lock itself.
 */
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advanceClock, resetClockForTests } from "../../clock.js";
import {
  launchTestBrowser,
  listen,
  reserveOrigin,
} from "../../test-browser.js";
import { createTestContext } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";

const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const inBrowser = launched instanceof Error ? it.skip : it;

const OWNER = { email: "owner@example.com", password: "correct horse battery" };
const WRONG = "not the password";
const MINUTE_MS = 60_000;

interface Instance {
  ctx: TestContext;
  origin: string;
  server: { close: () => Promise<void> };
}

let browser: Browser;
/** For the flows that do not lock the owner out. */
let main: Instance;
/** For the flows that do: the lock is per account, so each has its own. */
let locked: Instance;
let passkeys: Instance;

async function start(): Promise<Instance> {
  const reserved = await reserveOrigin();
  // WebAuthn does not accept an IP address as the relying party.
  const origin = reserved.origin.replace("127.0.0.1", "localhost");
  // Each browser context names its own address, so the sign-in limits, which
  // count per address, do not carry from one test into the next.
  const ctx = await createTestContext(
    { authBaseUrl: origin, trustedProxyHeader: "x-real-ip" },
    OWNER,
  );
  return { ctx, origin, server: listen(ctx.app, reserved.port) };
}

beforeAll(async () => {
  if (launched instanceof Error) return;
  browser = launched;
  [main, locked, passkeys] = await Promise.all([start(), start(), start()]);
});

afterAll(async () => {
  resetClockForTests();
  if (launched instanceof Error) return;
  await browser.close();
  for (const instance of [main, locked, passkeys]) {
    await instance.server.close();
    await instance.ctx.cleanup();
  }
});

interface Opened {
  page: Page;
  context: BrowserContext;
  /** What the policy refused or the page threw. */
  problems: string[];
}

let nextAddress = 1;

async function open(
  options: { scheme?: "light" | "dark"; width?: number; js?: boolean } = {},
): Promise<Opened> {
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-real-ip": `198.51.100.${String(nextAddress++)}` },
    colorScheme: options.scheme ?? "light",
    viewport: { width: options.width ?? 1280, height: 900 },
    javaScriptEnabled: options.js ?? true,
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(String(error)));
  page.on("console", (message) => {
    if (
      message.type() === "error" ||
      message.text().includes("Content Security Policy")
    )
      problems.push(message.text());
  });
  return { page, context, problems };
}

/** The name or id of what has keyboard focus. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el ? (el.getAttribute("name") ?? el.id) : "";
  });

/** What has keyboard focus, as a person would name it: a field by its name, anything else by its words. */
const focusedStop = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el ? (el.getAttribute("name") ?? el.textContent.trim()) : "";
  });

/** Presses Tab `count` times and names each place focus lands. */
async function tabStops(page: Page, count: number): Promise<string[]> {
  const stops: string[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press("Tab");
    stops.push(await focusedStop(page));
  }
  return stops;
}

async function signInWith(page: Page, password: string): Promise<void> {
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** A virtual authenticator that holds the owner's passkey once one is added. */
async function withAuthenticator(context: BrowserContext, page: Page) {
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
}

describe("signing in", () => {
  inBrowser(
    "works with the keyboard alone, from the first field to the page it lands on",
    async () => {
      const { page, context, problems } = await open();
      try {
        await page.goto(`${main.origin}/auth/sign-in`);
        // The page puts the cursor in the email field.
        expect(await focused(page)).toBe("email");
        await page.keyboard.type(OWNER.email);
        await page.keyboard.press("Tab");
        expect(await focused(page)).toBe("password");
        await page.keyboard.type(OWNER.password);
        await page.keyboard.press("Enter");
        await page.waitForURL(`${main.origin}/`);
        await page.getByRole("button", { name: "Sign out" }).waitFor();
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "says a wrong password is wrong under the password field, marks both fields, moves focus to the password and keeps the email",
    async () => {
      const { page, context, problems } = await open();
      try {
        await page.goto(`${main.origin}/auth/sign-in`);
        await signInWith(page, WRONG);
        await page.waitForURL(/error=invalid_credentials/);
        const message = page.getByText("That email or password is wrong.");
        await message.waitFor();
        const email = page.getByLabel("Email");
        const password = page.getByLabel("Password", { exact: true });
        // The message describes the password field, and the email field too,
        // since the server does not say which of the two was wrong.
        const describedBy = await message.getAttribute("id");
        expect(describedBy).not.toBeNull();
        for (const field of [email, password]) {
          expect(await field.getAttribute("aria-invalid")).toBe("true");
          expect(await field.getAttribute("aria-describedby")).toBe(
            describedBy,
          );
        }
        expect(await page.locator('[aria-invalid="true"]').count()).toBe(2);
        // The password has to be typed again, so focus is there.
        expect(await focused(page)).toBe("password");
        expect(await email.inputValue()).toBe(OWNER.email);
        expect(await password.inputValue()).toBe("");

        // The retry needs only the password.
        await page.keyboard.type(OWNER.password);
        await page.keyboard.press("Enter");
        await page.waitForURL(`${main.origin}/`);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "puts Forgot password after the Sign in button, so Tab follows the order on the screen",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${main.origin}/auth/sign-in`);
        expect(await focusedStop(page)).toBe("email");
        expect(await tabStops(page, 4)).toEqual([
          "password",
          "Sign in",
          "Forgot password?",
          "Sign in with a passkey",
        ]);
        // The link sits under the button, not on the password label's line.
        const boxes = {
          link: await page
            .getByRole("link", { name: "Forgot password?" })
            .boundingBox(),
          submit: await page
            .getByRole("button", { name: "Sign in", exact: true })
            .boundingBox(),
          password: await page
            .getByLabel("Password", { exact: true })
            .boundingBox(),
        };
        expect(boxes.link?.y).toBeGreaterThan(boxes.submit?.y ?? Infinity);
        expect(boxes.submit?.y).toBeGreaterThan(boxes.password?.y ?? Infinity);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "checks an empty form in the page before it sends anything",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${main.origin}/auth/sign-in`);
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        // No request was made: the page itself says what is missing.
        expect(page.url()).toBe(`${main.origin}/auth/sign-in`);
        expect(await focused(page)).toBe("email");
        await page.getByText("Please fill this in.").first().waitFor();
      } finally {
        await context.close();
      }
    },
  );

  for (const refused of [
    "https://evil.example/landing",
    "//evil.example/landing",
    "/\t/evil.example/landing",
    "javascript:alert(1)",
  ]) {
    inBrowser(
      `sends a sign-in asked to return to ${JSON.stringify(refused)} to the home page`,
      async () => {
        const { page, context } = await open();
        try {
          await page.goto(
            `${main.origin}/auth/sign-in?return_to=${encodeURIComponent(refused)}`,
          );
          await signInWith(page, OWNER.password);
          await page.waitForURL(`${main.origin}/`);
          expect(new URL(page.url()).origin).toBe(main.origin);
        } finally {
          await context.close();
        }
      },
    );
  }

  inBrowser(
    "sends a sign-in to the local path it was asked to return to",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(
          `${main.origin}/auth/sign-in?return_to=${encodeURIComponent("/auth/forgot-password?from=sign-in")}`,
        );
        await signInWith(page, OWNER.password);
        await page.waitForURL(
          `${main.origin}/auth/forgot-password?from=sign-in`,
        );
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "tells a signed-in person so, and shows the form again for prompt=login, then returns them where they were going",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${main.origin}/auth/sign-in`);
        await signInWith(page, OWNER.password);
        await page.waitForURL(`${main.origin}/`);

        await page.goto(`${main.origin}/auth/sign-in`);
        await page.getByText("You're signed in to").waitFor();
        expect(await page.getByLabel("Password", { exact: true }).count()).toBe(
          0,
        );

        await page.goto(
          `${main.origin}/auth/sign-in?prompt=login&return_to=${encodeURIComponent("/auth/forgot-password")}`,
        );
        await signInWith(page, OWNER.password);
        await page.waitForURL(`${main.origin}/auth/forgot-password`);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "signs in by a plain form post with scripting off, and says what went wrong in place",
    async () => {
      const { page, context } = await open({ js: false });
      try {
        await page.goto(`${main.origin}/auth/sign-in`);
        expect(await page.locator("noscript").textContent()).toContain(
          "This page needs JavaScript",
        );
        // Nothing that needs a script is offered.
        expect(await page.locator("[data-passkey-signin]").isVisible()).toBe(
          false,
        );
        expect(
          await page.getByRole("button", { name: "Show password" }).isVisible(),
        ).toBe(false);

        await signInWith(page, WRONG);
        await page.waitForURL(/error=invalid_credentials/);
        await page.getByText("That email or password is wrong.").waitFor();
        // The browser's own autofocus puts the cursor on the password.
        expect(await focused(page)).toBe("password");
        // Without a script, Tab still follows the screen.
        expect(await tabStops(page, 2)).toEqual([
          "Sign in",
          "Forgot password?",
        ]);
        await page.getByLabel("Password", { exact: true }).focus();

        await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await page.waitForURL(`${main.origin}/`);
        await page.getByText("Older management page").waitFor();
      } finally {
        await context.close();
      }
    },
  );

  inBrowser("shows and hides the password on request", async () => {
    const { page, context } = await open();
    try {
      await page.goto(`${main.origin}/auth/sign-in`);
      const password = page.getByLabel("Password", { exact: true });
      await password.fill("secret words");
      await page.getByRole("button", { name: "Show password" }).click();
      expect(await password.getAttribute("type")).toBe("text");
      await page.getByRole("button", { name: "Hide password" }).click();
      expect(await password.getAttribute("type")).toBe("password");
    } finally {
      await context.close();
    }
  });
});

describe("the lock", () => {
  inBrowser(
    "says how long to wait, keeps the passkey open, and lifts when the wait is over",
    async () => {
      const { page, context, problems } = await open();
      try {
        await withAuthenticator(context, page);
        // Add a passkey while signed in.
        await page.goto(
          `${locked.origin}/auth/sign-in?return_to=${encodeURIComponent("/auth/owner/passkeys")}`,
        );
        await signInWith(page, OWNER.password);
        await page.waitForURL(/\/auth\/owner\/passkeys$/);
        await page.fill('[name="passkey-name"]', "Locked-out passkey");
        await page.click("#add-passkey");
        await page.getByText("Locked-out passkey", { exact: true }).waitFor();
        await context.clearCookies();

        // Wrong passwords, as a guesser would send them, until the address
        // is refused. Every attempt counts, the sign-in above included.
        let refused = 0;
        for (let i = 0; i < 12 && refused === 0; i++) {
          const wrong = await context.request.post(
            `${locked.origin}/auth/sign-in/email`,
            {
              data: { email: OWNER.email, password: WRONG },
              headers: { origin: locked.origin },
            },
          );
          if (wrong.status() === 429) refused = i + 1;
          else expect(wrong.status()).toBe(401);
        }
        expect(refused, "the address was never refused").toBeGreaterThan(0);

        await page.goto(`${locked.origin}/auth/sign-in`);
        await signInWith(page, OWNER.password);
        await page.waitForURL(/error=too_many_attempts/);
        const message = page.getByText(/^Too many attempts\./);
        await message.waitFor();
        // The address limit's fifteen minutes, rounded up from what is left.
        expect(await message.textContent()).toMatch(
          /^Too many attempts\. Try again in (14|15) minutes, or sign in with a passkey\.$/,
        );
        // It sits under the password field, and the email is not marked.
        expect(
          await page
            .getByLabel("Password", { exact: true })
            .getAttribute("aria-invalid"),
        ).toBe("true");
        expect(
          await page.getByLabel("Email").getAttribute("aria-invalid"),
        ).toBe(null);
        expect(await focused(page)).toBe("password");
        expect(new URL(page.url()).searchParams.get("retry_after")).toMatch(
          /^\d+$/,
        );

        // The passkey is the way in that the lock does not close.
        await page
          .getByRole("button", { name: "Sign in with a passkey" })
          .click();
        await page.waitForURL(`${locked.origin}/`);
        await page.getByRole("button", { name: "Sign out" }).waitFor();

        // The password is still locked for a new session of the same address.
        await context.clearCookies();
        await page.goto(`${locked.origin}/auth/sign-in`);
        await signInWith(page, OWNER.password);
        await page.waitForURL(/error=too_many_attempts/);

        // When the wait is over, the password signs in again.
        advanceClock(16 * MINUTE_MS);
        await page.goto(`${locked.origin}/auth/sign-in`);
        await signInWith(page, OWNER.password);
        await page.waitForURL(`${locked.origin}/`);
        expect(problems.filter((p) => !p.includes("429"))).toEqual([]);
      } finally {
        resetClockForTests();
        await context.close();
      }
    },
    60_000,
  );
});

describe("a passkey", () => {
  let nextPasskey = 1;
  async function withPasskey(): Promise<Opened> {
    const opened = await open();
    await withAuthenticator(opened.context, opened.page);
    await opened.page.goto(
      `${passkeys.origin}/auth/sign-in?return_to=${encodeURIComponent("/auth/owner/passkeys")}`,
    );
    await signInWith(opened.page, OWNER.password);
    await opened.page.waitForURL(/\/auth\/owner\/passkeys$/);
    // Named afresh each time: the list keeps the passkeys of earlier tests,
    // so a shared name would be seen before this one was added.
    const name = `Test passkey ${String(nextPasskey++)}`;
    await opened.page.fill('[name="passkey-name"]', name);
    await opened.page.click("#add-passkey");
    await opened.page.getByText(name, { exact: true }).waitFor();
    await opened.context.clearCookies();
    return opened;
  }

  inBrowser("signs in and returns to where the person was going", async () => {
    const { page, context, problems } = await withPasskey();
    try {
      await page.goto(
        `${passkeys.origin}/auth/sign-in?return_to=${encodeURIComponent("/auth/forgot-password")}`,
      );
      await page
        .getByRole("button", { name: "Sign in with a passkey" })
        .click();
      await page.waitForURL(`${passkeys.origin}/auth/forgot-password`);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  inBrowser(
    "says it was cancelled when the person cancels, and can be tried again",
    async () => {
      const { page, context } = await withPasskey();
      try {
        await page.addInitScript(`(() => {
          const real = navigator.credentials.get.bind(navigator.credentials);
          window.__cancel = true;
          navigator.credentials.get = (options) => window.__cancel
            ? Promise.reject(new DOMException("cancelled", "NotAllowedError"))
            : real(options);
        })()`);
        await page.goto(`${passkeys.origin}/auth/sign-in`);
        const button = page.getByRole("button", {
          name: "Sign in with a passkey",
        });
        await button.click();
        const message = page.getByRole("alert");
        await message.waitFor();
        expect(await message.textContent()).toContain(
          "The passkey request was cancelled or timed out",
        );
        expect(await page.locator("[data-passkey-error]:focus").count()).toBe(
          1,
        );
        expect(await button.isEnabled()).toBe(true);

        // The next try is allowed through, and signs in.
        await page.evaluate("window.__cancel = false");
        await button.click();
        await page.waitForURL(`${passkeys.origin}/`);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "shows the server's refusal in place when the passkey is not accepted",
    async () => {
      const { page, context } = await withPasskey();
      try {
        await page.route("**/auth/passkey/verify-authentication", (route) =>
          route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({
              error: { message: "That passkey is not registered." },
            }),
          }),
        );
        await page.goto(`${passkeys.origin}/auth/sign-in`);
        await page
          .getByRole("button", { name: "Sign in with a passkey" })
          .click();
        const message = page.getByRole("alert");
        await message.waitFor();
        expect(await message.textContent()).toContain(
          "That passkey is not registered.",
        );
        expect(page.url()).toBe(`${passkeys.origin}/auth/sign-in`);
      } finally {
        await context.close();
      }
    },
  );
});

describe("Forgot password", () => {
  inBrowser(
    "is reached from sign-in, gives the commands for a Mac, Docker and Railway, and goes back",
    async () => {
      const { page, context, problems } = await open();
      try {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: main.origin,
        });
        await page.goto(`${main.origin}/auth/sign-in`);
        await page.getByRole("link", { name: "Forgot password?" }).click();
        await page.waitForURL(`${main.origin}/auth/forgot-password`);
        await page
          .getByRole("heading", { name: "Reset your password" })
          .waitFor();
        await page.getByText("If Marfa runs on your Mac").waitFor();
        await page.getByText("If Marfa runs in Docker").waitFor();
        await page.getByText("If Marfa runs on Railway").waitFor();

        // The Copy buttons need the script, which shows them.
        const copy = page.getByRole("button", {
          name: "Copy marfa --socket PATH owner recover",
        });
        await copy.click();
        expect(await page.evaluate("navigator.clipboard.readText()")).toBe(
          "marfa --socket PATH owner recover",
        );

        await page.getByRole("link", { name: "Back to sign in" }).click();
        await page.waitForURL(`${main.origin}/auth/sign-in`);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser("reads in full, and goes back, with scripting off", async () => {
    const { page, context } = await open({ js: false });
    try {
      await page.goto(`${main.origin}/auth/forgot-password`);
      await page.getByText("marfa --socket PATH owner recover").waitFor();
      await page
        .getByText(
          "docker exec -it marfa marfa --socket /data/control/marfa.sock owner recover",
        )
        .waitFor();
      await page
        .getByText('marfa --socket "$MARFA_CONTROL_SOCKET" owner recover')
        .waitFor();
      await page.getByRole("link", { name: "Back to sign in" }).click();
      await page.waitForURL(`${main.origin}/auth/sign-in`);
    } finally {
      await context.close();
    }
  });
});

describe("the device code page after too many lookups", () => {
  inBrowser("says how long to wait", async () => {
    const { page, context } = await open();
    try {
      let location = "";
      for (let i = 0; i < 11; i++) {
        const posted = await context.request.post(
          `${main.origin}/auth/device`,
          {
            form: { user_code: `ZZ${String(100000 + i)}` },
            headers: { origin: main.origin },
            maxRedirects: 0,
          },
        );
        location = posted.headers().location ?? "";
      }
      expect(location).toContain("error=too_many_attempts");
      await page.goto(`${main.origin}${location}`);
      expect(await page.textContent("main")).toMatch(
        /Too many codes have been tried\. Try again in (14|15) minutes\./,
      );
    } finally {
      await context.close();
    }
  });
});

const PAGES = [
  ["sign-in", "/auth/sign-in"],
  [
    "sign-in with a lockout",
    "/auth/sign-in?error=too_many_attempts&retry_after=840",
  ],
  ["sign-in with a wrong password", "/auth/sign-in?error=invalid_credentials"],
  ["forgot password", "/auth/forgot-password"],
] as const;

describe("every page, at every width and in both schemes", () => {
  for (const [name, path] of PAGES) {
    for (const scheme of ["light", "dark"] as const) {
      inBrowser(
        `${name} in ${scheme}: legible, in the card, with no sideways scroll at 375 px and no policy violation`,
        async () => {
          const { page, context, problems } = await open({
            scheme,
            width: 375,
          });
          try {
            await page.goto(`${main.origin}${path}`);
            await page.locator(".card").waitFor();
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
              ),
              "scrolls sideways",
            ).toBe(true);
            expect(
              await page.evaluate(
                () => getComputedStyle(document.documentElement).colorScheme,
              ),
            ).toBe(scheme);

            const failures = await page.evaluate(() => {
              const parse = (c: string): number[] => {
                const m = /rgba?\(([^)]+)\)/.exec(c);
                const p = (m?.[1] ?? "0,0,0").split(/[ ,/]+/).map(Number);
                return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
              };
              const lum = ([r, g, b]: number[]) => {
                const f = (v: number) => {
                  const s = v / 255;
                  return s <= 0.03928
                    ? s / 12.92
                    : ((s + 0.055) / 1.055) ** 2.4;
                };
                return (
                  0.2126 * f(r ?? 0) + 0.7152 * f(g ?? 0) + 0.0722 * f(b ?? 0)
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
                return [255, 255, 255, 1];
              };
              const bad: string[] = [];
              for (const el of document.querySelectorAll("body *")) {
                if (!el.checkVisibility()) continue;
                const own = [...el.childNodes].some(
                  (n) =>
                    n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
                );
                if (!own) continue;
                const [hi, lo] = [
                  lum(parse(getComputedStyle(el).color)),
                  lum(backdrop(el)),
                ].sort((a, b) => b - a);
                const ratio = ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
                if (ratio < 4.5)
                  bad.push(
                    `${el.tagName} "${el.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}`,
                  );
              }
              return bad;
            });
            expect(failures).toEqual([]);
            expect(problems).toEqual([]);
          } finally {
            await context.close();
          }
        },
      );
    }
  }

  inBrowser(
    "the card sits one step off the page in dark and level with it in light",
    async () => {
      const colors: Record<string, [string, string]> = {};
      for (const scheme of ["light", "dark"] as const) {
        const { page, context } = await open({ scheme });
        try {
          await page.goto(`${main.origin}/auth/sign-in`);
          colors[scheme] = await page.evaluate(
            () =>
              [
                getComputedStyle(document.body).backgroundColor,
                getComputedStyle(document.querySelector(".card")!)
                  .backgroundColor,
              ] as [string, string],
          );
        } finally {
          await context.close();
        }
      }
      expect(colors.light?.[0]).toBe(colors.light?.[1]);
      expect(colors.dark?.[0]).not.toBe(colors.dark?.[1]);
      expect(colors.dark?.[0]).not.toBe(colors.light?.[0]);
    },
  );

  inBrowser(
    "every control on sign-in is reached by Tab, in reading order, with a visible ring",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${main.origin}/auth/sign-in`);
        await page
          .getByRole("button", { name: "Sign in with a passkey" })
          .waitFor();
        await page.getByLabel("Password", { exact: true }).fill("x");
        await page.getByLabel("Email").focus();
        const count = await page.evaluate(
          () =>
            [...document.querySelectorAll("a[href], button, input")].filter(
              (el) =>
                el.checkVisibility() &&
                !el.disabled &&
                el.tabIndex >= 0 &&
                el.getAttribute("type") !== "hidden" &&
                !el.classList.contains("skip"),
            ).length,
        );
        const order: string[] = [];
        const noRing: string[] = [];
        // The focus starts on the email field, which autofocus put it on.
        for (let i = 0; i < count; i++) {
          const info = await page.evaluate(() => {
            const el = document.activeElement!;
            const s = getComputedStyle(el);
            return {
              id:
                el.getAttribute("name") ??
                el.getAttribute("aria-label") ??
                el.textContent.trim().slice(0, 30),
              ring:
                (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) ||
                s.boxShadow !== "none",
            };
          });
          order.push(info.id);
          if (!info.ring) noRing.push(info.id);
          await page.keyboard.press("Tab");
        }
        expect(order).toEqual([
          "email",
          "password",
          "Show password",
          "Sign in",
          "Forgot password?",
          "Sign in with a passkey",
        ]);
        expect(noRing).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );
});
