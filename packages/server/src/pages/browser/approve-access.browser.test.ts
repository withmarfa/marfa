/**
 * Approve access and Connect a device in a real browser, on the real app:
 * both pages in light and dark, by keyboard alone, on a phone, with scripting
 * off, and through approve, deny and nothing chosen to the grant that results.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as clock from "../../clock.js";
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

/** Where the app listens for its code, found when the listeners start. */
let CALLBACK = "";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MINUTE = 60_000;

let browser: Browser;
let origin: string;
let ctx: TestContext;
let real: { close: () => Promise<void> };
let appListener: { close: () => Promise<void> };
/** Every address the app was sent to. */
const arrivals: string[] = [];

/**
 * A real app on a real listener, and a place for the app to be sent. Each
 * group of tests below starts its own, because looking a device code up is
 * limited to ten a window for the owner.
 */
async function startWorld(): Promise<void> {
  if (launched instanceof Error) return;
  browser = launched;
  const reserved = await reserveOrigin();
  origin = reserved.origin;
  ctx = await createTestContext({ authBaseUrl: origin });
  real = listen(ctx.app, reserved.port);
  const app = await reserveOrigin();
  CALLBACK = `${app.origin}/callback`;
  arrivals.length = 0;
  appListener = listen(ctx.app, app.port, (request) => {
    if (new URL(request.url).pathname === "/callback")
      arrivals.push(request.url);
    return new Response("the app", {
      headers: { "content-type": "text/plain" },
    });
  });
}

async function stopWorld(): Promise<void> {
  if (launched instanceof Error) return;
  await real.close();
  await appListener.close();
  await ctx.cleanup();
}

afterAll(async () => {
  if (launched instanceof Error) return;
  await browser.close();
});

function inWorld(): void {
  beforeAll(startWorld);
  afterAll(stopWorld);
}

interface Proof {
  verifier: string;
  challenge: string;
}

function pkce(): Proof {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

interface Registered {
  clientId: string;
}

/** An app that can ask in a browser or on a device, as it registers itself. */
async function registerApp(scope: string, name: string): Promise<Registered> {
  const response = await fetch(`${origin}/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      application_type: "native",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return {
    clientId: ((await response.json()) as { client_id: string }).client_id,
  };
}

interface Browsing {
  page: Page;
  context: BrowserContext;
  /** Every address the app was sent to, newest last. */
  callbacks: string[];
}

/** A signed-in browser, and the addresses the app was sent to. */
async function openSignedIn(
  options: {
    scheme?: "light" | "dark";
    width?: number;
    height?: number;
    js?: boolean;
  } = {},
): Promise<Browsing> {
  const context = await browser.newContext({
    colorScheme: options.scheme ?? "light",
    viewport: { width: options.width ?? 1280, height: options.height ?? 900 },
    javaScriptEnabled: options.js ?? true,
  });
  const signedIn = await context.request.post(`${origin}/auth/sign-in/email`, {
    data: { email: ctx.owner.email, password: ctx.owner.password },
    headers: { origin },
  });
  expect(signedIn.status()).toBe(200);
  return { page: await context.newPage(), context, callbacks: arrivals };
}

/** Where a browser is sent to ask for `scope`: the authorization request. */
function authorizeUrl(
  app: Registered,
  scope: string,
  proof: Proof,
  extra: Record<string, string> = {},
): string {
  return `${origin}/auth/oauth2/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: CALLBACK,
    state: "browser-test",
    scope,
    code_challenge: proof.challenge,
    code_challenge_method: "S256",
    ...extra,
  }).toString()}`;
}

/** The scopes a code exchanges for. */
async function scopesOf(
  app: Registered,
  callback: string,
  proof: Proof,
): Promise<string[]> {
  const code = new URL(callback).searchParams.get("code") ?? "";
  const response = await fetch(`${origin}/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    }),
  });
  const body = (await response.json()) as { scope?: string };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return (body.scope ?? "").split(" ").sort();
}

/** What the app was sent to by `act`: waits for a new arrival, never reads an old one. */
async function arrival(b: Browsing, act: () => Promise<void>): Promise<string> {
  const before = b.callbacks.length;
  await act();
  await expect.poll(() => b.callbacks.length).toBeGreaterThan(before);
  return b.callbacks.at(-1) ?? "";
}

const REQUEST =
  "openid offline_access core.note:read core.note:write core.task:read";

/** The consent screen for `REQUEST`, opened as a person's browser gets there. */
async function openConsent(
  b: Browsing,
  name: string,
  scope = REQUEST,
  extra: Record<string, string> = {},
): Promise<{ app: Registered; proof: Proof }> {
  const app = await registerApp(scope, name);
  const proof = pkce();
  await b.page.goto(authorizeUrl(app, scope, proof, extra));
  return { app, proof };
}

/** Contrast failures: text under 4.5 to 1 against its background. */
async function illegible(page: Page): Promise<string[]> {
  return page.evaluate(() => {
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
    const backdrop = (el: BrowserElement): [number, number, number, number] => {
      for (let n: BrowserElement | null = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c[3] > 0.5) return c;
      }
      return [255, 255, 255, 1];
    };
    const bad: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!el.checkVisibility()) continue;
      if (el.closest(".sr, .skip, [disabled]")) continue;
      const own = [...el.childNodes].some(
        (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
      );
      if (!own) continue;
      const fg = parse(getComputedStyle(el).color);
      const [hi, lo] = [lum(fg), lum(backdrop(el))].sort((a, b) => b - a);
      const ratio = (hi! + 0.05) / (lo! + 0.05);
      if (ratio < 4.5)
        bad.push(`${el.tagName} "${el.textContent.trim().slice(0, 20)}"`);
    }
    return bad;
  });
}

describe("Approve access in a browser", () => {
  inWorld();

  for (const scheme of ["light", "dark"] as const) {
    inBrowser(
      `reads well in ${scheme}, with the card one step off the page in dark`,
      async () => {
        const b = await openSignedIn({ scheme });
        try {
          await openConsent(b, `Legible ${scheme}`);
          await b.page
            .getByRole("heading", {
              name: "Legible " + scheme + " wants access to Marfa",
            })
            .waitFor();
          expect(await illegible(b.page)).toEqual([]);
          const colors = await b.page.evaluate(() => ({
            body: getComputedStyle(document.body).backgroundColor,
            card: getComputedStyle(document.querySelector(".card")!)
              .backgroundColor,
            scheme: getComputedStyle(document.documentElement).colorScheme,
          }));
          expect(colors.scheme).toBe(scheme);
          if (scheme === "dark") expect(colors.card).not.toBe(colors.body);
          else expect(colors.card).toBe(colors.body);

          // And when the app already holds some, with its section opened.
          const returning = await registerApp(REQUEST, `Returning ${scheme}`);
          await b.page.goto(
            authorizeUrl(returning, "openid core.note:read", pkce()),
          );
          await arrival(b, () =>
            b.page.getByRole("button", { name: "Approve" }).click(),
          );
          await b.page.goto(authorizeUrl(returning, REQUEST, pkce()));
          await b.page
            .getByRole("heading", {
              name: `Returning ${scheme} wants more access`,
            })
            .waitFor();
          await b.page.getByText("Already allowed").click();
          await b.page
            .getByText("Read only", { exact: true })
            .first()
            .waitFor();
          expect(await illegible(b.page)).toEqual([]);
        } finally {
          await b.context.close();
        }
      },
    );
  }

  inBrowser(
    "fits a phone with no sideways scroll, with every control reachable",
    async () => {
      const b = await openSignedIn({ width: 375, height: 812 });
      try {
        await openConsent(
          b,
          "A Phone App With A Rather Long Name That Must Wrap Somewhere Sensible",
          `${REQUEST} keys.mint items.purge profile:read`,
        );
        await b.page.getByRole("button", { name: "Approve" }).waitFor();
        const widths = await b.page.evaluate(() => ({
          page: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
        }));
        expect(widths.page).toBeLessThanOrEqual(widths.viewport);
        expect(await illegible(b.page)).toEqual([]);
        for (const name of ["Notes", "Tasks"])
          await b.page.getByRole("combobox", { name }).scrollIntoViewIfNeeded();
        await b.page
          .getByRole("switch", { name: /Make, see, edit and revoke keys/ })
          .check();
      } finally {
        await b.context.close();
      }
    },
  );

  inBrowser("is chosen and approved by keyboard alone", async () => {
    const b = await openSignedIn();
    try {
      const { app, proof } = await openConsent(b, "Keyboard App");
      const notes = b.page.getByRole("combobox", { name: "Notes" });
      await notes.waitFor();
      // Tab to it: nothing before it needs a mouse.
      for (let i = 0; i < 12; i++) {
        await b.page.keyboard.press("Tab");
        if (await notes.evaluate((el) => el === document.activeElement)) break;
      }
      expect(await notes.evaluate((el) => el === document.activeElement)).toBe(
        true,
      );
      // Typing the name of a choice picks it, the way a select does on every
      // platform; the arrow keys open the list on some.
      await b.page.keyboard.type("Read o");
      expect(await notes.inputValue()).toBe("core.note:read");
      await b.page.keyboard.press("Tab");
      const tasks = b.page.getByRole("combobox", { name: "Tasks" });
      expect(await tasks.evaluate((el) => el === document.activeElement)).toBe(
        true,
      );
      await b.page.keyboard.type("No");
      expect(await tasks.inputValue()).toBe("");
      // The primary action is reachable and the Enter key presses it.
      await b.page.getByRole("button", { name: "Approve" }).focus();
      const sent = await arrival(b, () => b.page.keyboard.press("Enter"));
      expect(await scopesOf(app, sent, proof)).toEqual([
        "core.note:read",
        "offline_access",
        "openid",
      ]);
    } finally {
      await b.context.close();
    }
  });

  inBrowser(
    "approves what the page offered, chosen by mouse, and denies on Deny",
    async () => {
      const b = await openSignedIn();
      try {
        const approving = await openConsent(b, "Mouse App");
        await b.page
          .getByRole("combobox", { name: "Notes" })
          .selectOption({ label: "Read only" });
        const sent = new URL(
          await arrival(b, () =>
            b.page.getByRole("button", { name: "Approve" }).click(),
          ),
        );
        expect(sent.searchParams.get("state")).toBe("browser-test");
        expect(
          await scopesOf(approving.app, sent.href, approving.proof),
        ).toEqual([
          "core.note:read",
          "core.task:read",
          "offline_access",
          "openid",
        ]);

        await openConsent(b, "Denied App");
        const denied = new URL(
          await arrival(b, () =>
            b.page.getByRole("button", { name: "Deny" }).click(),
          ),
        );
        expect(denied.searchParams.get("error")).toBe("access_denied");
        expect(denied.searchParams.get("code")).toBeNull();
      } finally {
        await b.context.close();
      }
    },
  );

  inBrowser(
    "denies the request when everything is turned off and Approve is pressed",
    async () => {
      const b = await openSignedIn();
      try {
        await openConsent(b, "Nothing App");
        for (const name of ["Notes", "Tasks"])
          await b.page
            .getByRole("combobox", { name })
            .selectOption({ label: "No access" });
        const sent = new URL(
          await arrival(b, () =>
            b.page.getByRole("button", { name: "Approve" }).click(),
          ),
        );
        expect(sent.searchParams.get("error")).toBe("access_denied");
        expect(sent.searchParams.get("state")).toBe("browser-test");
        expect(sent.searchParams.get("code")).toBeNull();
      } finally {
        await b.context.close();
      }
    },
  );

  inBrowser(
    "works with scripting off: the form posts and the grant is what was chosen",
    async () => {
      const b = await openSignedIn({ js: false });
      try {
        const { app, proof } = await openConsent(b, "No Script App");
        expect(await b.page.locator("script").count()).toBe(0);
        await b.page
          .getByRole("combobox", { name: "Tasks" })
          .selectOption({ label: "No access" });
        const sent = await arrival(b, () =>
          b.page.getByRole("button", { name: "Approve" }).click(),
        );
        expect(await scopesOf(app, sent, proof)).toEqual([
          "core.note:read",
          "core.note:write",
          "offline_access",
          "openid",
        ]);
      } finally {
        await b.context.close();
      }
    },
  );

  inBrowser(
    "sends a screen left open past five minutes to sign in again when Approve is pressed on a write, and grants nothing",
    async () => {
      const b = await openSignedIn();
      try {
        const { app } = await openConsent(b, "Left Open App");
        await b.page.getByRole("button", { name: "Approve" }).waitFor();
        clock.advanceClock(6 * MINUTE);
        const before = b.callbacks.length;
        await b.page.getByRole("button", { name: "Approve" }).click();
        await b.page.waitForURL(/\/auth\/sign-in/);
        expect(new URL(b.page.url()).searchParams.get("prompt")).toBe("login");
        expect(new URL(b.page.url()).searchParams.get("return_to")).toContain(
          "/auth/authorize",
        );
        expect(b.callbacks.length).toBe(before);
        // The app holds nothing: asked again, it is not answered with a code.
        const asked = await fetch(authorizeUrl(app, REQUEST, pkce()), {
          redirect: "manual",
          headers: {
            cookie: (await b.context.cookies())
              .map((c) => `${c.name}=${c.value}`)
              .join("; "),
          },
        });
        expect(asked.headers.get("location") ?? "").not.toContain("code=");
      } finally {
        clock.resetClockForTests();
        await b.context.close();
      }
    },
  );

  inBrowser(
    "sends a session older than five minutes to sign in again for a write, and shows it a request that only reads",
    async () => {
      const b = await openSignedIn();
      try {
        clock.advanceClock(6 * MINUTE);
        const writing = await registerApp(REQUEST, "Older Write App");
        await b.page.goto(authorizeUrl(writing, REQUEST, pkce()));
        expect(new URL(b.page.url()).pathname).toBe("/auth/sign-in");
        expect(new URL(b.page.url()).searchParams.get("prompt")).toBe("login");
        expect(new URL(b.page.url()).searchParams.get("return_to")).toContain(
          "/auth/authorize",
        );

        const reading = "openid core.note:read";
        const app = await registerApp(reading, "Older Read App");
        await b.page.goto(authorizeUrl(app, reading, pkce()));
        await b.page.getByRole("button", { name: "Approve" }).waitFor();
        expect(new URL(b.page.url()).pathname).toBe("/auth/authorize");
      } finally {
        clock.resetClockForTests();
        await b.context.close();
      }
    },
  );
});

interface DeviceAsk {
  app: Registered;
  userCode: string;
  deviceCode: string;
  interval: number;
}

/** A device asking for a code: the person types or follows it on the page. */
async function askAsDevice(scope: string, name: string): Promise<DeviceAsk> {
  const app = await registerApp(scope, name);
  const issued = await fetch(`${origin}/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: app.clientId, scope }),
  });
  expect(issued.status).toBe(200);
  const code = (await issued.json()) as {
    user_code: string;
    device_code: string;
    interval: number;
  };
  return {
    app,
    userCode: code.user_code,
    deviceCode: code.device_code,
    interval: code.interval,
  };
}

/** The device's next poll, after the interval it was told to leave. */
async function pollDevice(
  ask: DeviceAsk,
): Promise<{ status: number; error?: string; scope?: string }> {
  await new Promise((resolve) =>
    setTimeout(resolve, ask.interval * 1000 + 250),
  );
  const response = await fetch(`${origin}/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: DEVICE_GRANT,
      device_code: ask.deviceCode,
      client_id: ask.app.clientId,
    }),
  });
  const body = (await response.json()) as { error?: string; scope?: string };
  return { status: response.status, error: body.error, scope: body.scope };
}

describe("Connect a device in a browser", () => {
  inWorld();

  for (const scheme of ["light", "dark"] as const) {
    inBrowser(`reads well in ${scheme}`, async () => {
      const b = await openSignedIn({ scheme });
      try {
        const ask = await askAsDevice(REQUEST, `Device ${scheme}`);
        await b.page.goto(
          `${origin}/auth/device/consent?user_code=${ask.userCode}`,
        );
        await b.page
          .getByRole("heading", {
            name: `Device ${scheme} wants access to Marfa`,
          })
          .waitFor();
        expect(await b.page.getByText(ask.userCode).count()).toBe(1);
        expect(await illegible(b.page)).toEqual([]);
      } finally {
        await b.context.close();
      }
    });
  }

  inBrowser("fits a phone with no sideways scroll", async () => {
    const b = await openSignedIn({ width: 375, height: 812 });
    try {
      const ask = await askAsDevice(
        `${REQUEST} keys.mint`,
        "A Device With A Rather Long Name That Must Wrap Somewhere Sensible",
      );
      await b.page.goto(
        `${origin}/auth/device/consent?user_code=${ask.userCode}`,
      );
      await b.page.getByRole("button", { name: "Approve" }).waitFor();
      const widths = await b.page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(widths.page).toBeLessThanOrEqual(widths.viewport);
    } finally {
      await b.context.close();
    }
  });

  inBrowser(
    "approves what was chosen, by keyboard, and the device's next poll is a token for it",
    async () => {
      const b = await openSignedIn();
      try {
        const ask = await askAsDevice(REQUEST, "Keyboard Device");
        await b.page.goto(
          `${origin}/auth/device/consent?user_code=${ask.userCode}`,
        );
        const notes = b.page.getByRole("combobox", { name: "Notes" });
        await notes.focus();
        await b.page.keyboard.type("Read o");
        expect(await notes.inputValue()).toBe("core.note:read");
        await b.page.getByRole("button", { name: "Approve" }).focus();
        await b.page.keyboard.press("Enter");
        await b.page
          .getByRole("heading", { name: "Access approved" })
          .waitFor();
        const polled = await pollDevice(ask);
        expect(polled.status).toBe(200);
        expect((polled.scope ?? "").split(" ").sort()).toEqual([
          "core.note:read",
          "core.task:read",
          "offline_access",
          "openid",
        ]);
      } finally {
        await b.context.close();
      }
    },
  );
});

describe("Connect a device in a browser, deciding", () => {
  inWorld();

  inBrowser(
    "denies on Deny, and when everything is turned off and Approve is pressed",
    async () => {
      const b = await openSignedIn();
      try {
        const denied = await askAsDevice(REQUEST, "Denied Device");
        await b.page.goto(
          `${origin}/auth/device/consent?user_code=${denied.userCode}`,
        );
        await b.page.getByRole("button", { name: "Deny" }).click();
        await b.page
          .getByRole("heading", { name: "You didn't approve access" })
          .waitFor();
        expect((await pollDevice(denied)).error).toBe("access_denied");

        const nothing = await askAsDevice(REQUEST, "Nothing Device");
        await b.page.goto(
          `${origin}/auth/device/consent?user_code=${nothing.userCode}`,
        );
        for (const name of ["Notes", "Tasks"])
          await b.page
            .getByRole("combobox", { name })
            .selectOption({ label: "No access" });
        await b.page.getByRole("button", { name: "Approve" }).click();
        await b.page
          .getByRole("heading", { name: "You didn't approve access" })
          .waitFor();
        expect((await pollDevice(nothing)).error).toBe("access_denied");
      } finally {
        await b.context.close();
      }
    },
  );

  inBrowser("works with scripting off", async () => {
    const b = await openSignedIn({ js: false });
    try {
      const ask = await askAsDevice(REQUEST, "No Script Device");
      await b.page.goto(
        `${origin}/auth/device/consent?user_code=${ask.userCode}`,
      );
      expect(await b.page.locator("script").count()).toBe(0);
      await b.page.getByRole("button", { name: "Approve" }).click();
      await b.page.getByRole("heading", { name: "Access approved" }).waitFor();
      expect((await pollDevice(ask)).status).toBe(200);
    } finally {
      await b.context.close();
    }
  });

  inBrowser(
    "sends a session older than five minutes to sign in again for a write, and the screen left open past five minutes too",
    async () => {
      const b = await openSignedIn();
      try {
        const open = await askAsDevice(REQUEST, "Left Open Device");
        await b.page.goto(
          `${origin}/auth/device/consent?user_code=${open.userCode}`,
        );
        await b.page.getByRole("button", { name: "Approve" }).waitFor();
        clock.advanceClock(6 * MINUTE);
        // The screen was fresh when it opened; approving a write now asks again.
        await b.page.getByRole("button", { name: "Approve" }).click();
        await b.page.waitForURL(/\/auth\/sign-in/);
        expect(new URL(b.page.url()).searchParams.get("prompt")).toBe("login");
        expect(new URL(b.page.url()).searchParams.get("return_to")).toContain(
          "/auth/device/consent",
        );
        // The code is still pending: nothing was granted by the refusal.
        expect((await pollDevice(open)).error).toBe("authorization_pending");

        const stale = await askAsDevice(REQUEST, "Older Device");
        await b.page.goto(
          `${origin}/auth/device/consent?user_code=${stale.userCode}`,
        );
        expect(new URL(b.page.url()).pathname).toBe("/auth/sign-in");
      } finally {
        clock.resetClockForTests();
        await b.context.close();
      }
    },
  );
});
