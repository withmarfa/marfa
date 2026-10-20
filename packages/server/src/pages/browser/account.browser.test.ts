/**
 * Profile, and Password and passkeys, in a real browser against a real
 * listener under the real policy: each change made and refused, a sign-in
 * older than five minutes, two browsers when the password changes, a browser
 * with no passkey support, the keyboard alone, a phone's width, light and dark.
 */
import type { Browser, BrowserContext, Page, Route } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGN_IN_ADDRESS_LIMIT } from "../../auth/sign-in-throttle.js";
import {
  launchTestBrowser,
  listen,
  reserveOrigin,
} from "../../test-browser.js";
import { createTestContext } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { HOSTILE, LONG_UNBROKEN } from "../test-fixture.js";

const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const inBrowser = launched instanceof Error ? it.skip : it;

let browser: Browser;
let origin: string;
let ctx: TestContext;
let server: { close: () => Promise<void> };

const PROFILE = "/auth/owner/profile";
const PASSKEYS = "/auth/owner/passkeys";
const ORIGINAL_PASSWORD = "correct horse battery";
const owner = { email: "owner@example.com", password: ORIGINAL_PASSWORD };
/** The password the owner has now, which a case that changes it puts back. */
let password = ORIGINAL_PASSWORD;
let ownerName = "";

beforeAll(async () => {
  if (launched instanceof Error) return;
  browser = launched;
  const reserved = await reserveOrigin();
  // A passkey needs a name for an address, which a number is not.
  origin = reserved.origin.replace("127.0.0.1", "localhost");
  // Sign-in limits count per address, so each browser context names its own.
  ctx = await createTestContext(
    { authBaseUrl: origin, trustedProxyHeader: "x-real-ip" },
    owner,
  );
  server = listen(ctx.app, reserved.port);
  ownerName = (await theOwner()).name;
});

afterAll(async () => {
  if (launched instanceof Error) return;
  await browser.close();
  await server.close();
  await ctx.cleanup();
});

let nextAddress = 1;
const newAddress = () => ({
  "x-real-ip": `198.51.100.${String(nextAddress++)}`,
});

interface Opened {
  page: Page;
  context: BrowserContext;
  violations: () => Promise<string[]>;
  errors: string[];
  requests: { method: string; path: string; status: number }[];
}

/** A browser signed in as the owner, with every policy violation recorded. */
async function open(
  options: {
    scheme?: "light" | "dark";
    width?: number;
    passkeys?: boolean;
    withoutWebAuthn?: boolean;
    timezoneId?: string;
  } = {},
): Promise<Opened> {
  const context = await browser.newContext({
    colorScheme: options.scheme ?? "light",
    viewport: { width: options.width ?? 1280, height: 900 },
    extraHTTPHeaders: newAddress(),
    ...(options.timezoneId === undefined
      ? {}
      : { timezoneId: options.timezoneId }),
  });
  const signedIn = await context.request.post(`${origin}/auth/sign-in/email`, {
    headers: { origin },
    data: { email: owner.email, password },
  });
  expect(signedIn.status()).toBe(200);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const requests: Opened["requests"] = [];
  page.on("response", (response) => {
    const request = response.request();
    if (request.method() === "GET") return;
    requests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      status: response.status(),
    });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__violations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  if (options.withoutWebAuthn)
    await page.addInitScript(() => {
      Object.defineProperty(window, "PublicKeyCredential", {
        value: undefined,
        configurable: true,
      });
    });
  if (options.passkeys) {
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
  return {
    page,
    context,
    errors,
    requests,
    violations: () =>
      page.evaluate(
        () => (window as unknown as { __violations: string[] }).__violations,
      ),
  };
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** Makes the signed-in session six minutes old on the server. */
async function ageSessions(): Promise<void> {
  await (
    ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun("UPDATE auth_session SET created_at = created_at - 360", []);
}

async function theOwner() {
  const found = await ctx.storage.owner?.find();
  if (!found) throw new Error("no owner");
  return found;
}

/**
 * Changes the owner through the server's own door with a sign-in made now, so
 * a case that aged the sessions can still put things back.
 */
async function setOwner(fields: { name?: string; email?: string }) {
  const signIn = await fetch(`${origin}/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...newAddress(),
    },
    body: JSON.stringify({ email: (await theOwner()).email, password }),
  });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const res = await fetch(`${origin}/owner`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify(fields),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** Past the sign-in windows a wrong guess or a sign-in counted against. */
async function clearSignInWindows(): Promise<void> {
  await ctx.storage.rateLimits.clearSignIn(owner.email);
}

const dialogOf = (page: Page, name: string) =>
  page.getByRole("dialog", { name, exact: true });

const done = (page: Page) => page.locator('[data-notice="done"]');

const restore = async () => {
  await setOwner({ name: ownerName, email: owner.email });
};

describe("Profile", () => {
  inBrowser(
    "shows the name and email and changes the name from the keyboard alone, under the real policy",
    async () => {
      const { page, context, violations, errors, requests } = await open();
      try {
        await page.goto(origin + PROFILE);
        await page
          .getByRole("heading", { name: "Profile", level: 1 })
          .waitFor();
        const before = await theOwner();
        await page.getByText(before.name, { exact: true }).waitFor();
        await page.getByText(`${before.email}. You sign in with it.`).waitFor();
        expect(await page.getByText("Picture", { exact: true }).count()).toBe(
          0,
        );

        await page.locator('[data-hook="change-name"]').focus();
        await page.keyboard.press("Enter");
        const dialog = dialogOf(page, "Change name");
        await dialog.waitFor();
        expect(
          await dialog
            .getByLabel("Name")
            .evaluate((e) => e === document.activeElement),
        ).toBe(true);
        await dialog.getByLabel("Name").fill("");
        await page.keyboard.type("Ada Lovelace");
        await page.keyboard.press("Enter");
        await done(page).getByText("Name changed").waitFor();
        await dialog.waitFor({ state: "hidden" });
        await page.getByText("Ada Lovelace", { exact: true }).waitFor();
        expect((await theOwner()).name).toBe("Ada Lovelace");
        expect(requests.filter((r) => r.method === "PATCH")).toEqual([
          { method: "PATCH", path: "/owner", status: 200 },
        ]);
        // Focus goes back to where the person was.
        expect(
          await page
            .locator('[data-hook="change-name"]')
            .evaluate((e) => e === document.activeElement),
        ).toBe(true);
        // The dialog opens again with the new name, not what was typed before.
        await page.keyboard.press("Enter");
        expect(await dialog.getByLabel("Name").inputValue()).toBe(
          "Ada Lovelace",
        );
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        expect(await violations()).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await restore();
      }
    },
  );

  inBrowser(
    "refuses an empty name, spaces, a hidden character and 201 characters before sending anything, and takes 200",
    async () => {
      const { page, context, requests } = await open();
      try {
        await page.goto(origin + PROFILE);
        await page.locator('[data-hook="change-name"]').click();
        const dialog = dialogOf(page, "Change name");
        const field = dialog.getByLabel("Name");
        const save = dialog.getByRole("button", { name: "Save" });
        for (const [value, text] of [
          ["", "Enter a name."],
          ["   ", "Enter a name."],
          ["x".repeat(201), "Use 200 characters or fewer."],
          ["\u{1F600}".repeat(201), "Use 200 characters or fewer."],
          [
            "Ada\u202eLovelace",
            "Remove hidden characters, such as line breaks.",
          ],
        ] as const) {
          await field.fill(value);
          await save.click();
          await dialog.getByText(text).waitFor();
          expect(await field.getAttribute("aria-invalid")).toBe("true");
          expect(
            await field.evaluate((e) => e === document.activeElement),
          ).toBe(true);
        }
        expect(requests.filter((r) => r.method === "PATCH")).toEqual([]);

        // 200 astral characters are 200 characters, not 400.
        await field.fill("\u{1F600}".repeat(200));
        await save.click();
        await done(page).getByText("Name changed").waitFor();
        expect((await theOwner()).name).toBe("\u{1F600}".repeat(200));
        expect(await overflow(page)).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
        await restore();
      }
    },
  );

  inBrowser(
    "keeps a name that is markup as text, on the page and in the dialog",
    async () => {
      const { page, context, violations, errors } = await open();
      try {
        await page.goto(origin + PROFILE);
        await page.locator('[data-hook="change-name"]').click();
        const dialog = dialogOf(page, "Change name");
        await dialog.getByLabel("Name").fill(HOSTILE);
        await dialog.getByRole("button", { name: "Save" }).click();
        await done(page).getByText("Name changed").waitFor();
        expect((await theOwner()).name).toBe(HOSTILE);
        await page.reload();
        await page.getByText(HOSTILE, { exact: true }).waitFor();
        expect(
          await page.evaluate(
            () => (window as unknown as { __injected?: number }).__injected,
          ),
        ).toBeUndefined();
        expect(await page.locator("b", { hasText: "bold" }).count()).toBe(0);
        await page.locator('[data-hook="change-name"]').click();
        expect(await dialog.getByLabel("Name").inputValue()).toBe(HOSTILE);
        expect(await violations()).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await restore();
      }
    },
  );

  inBrowser(
    "changes the email, stores it in lower case and stays signed in",
    async () => {
      const { page, context, requests } = await open();
      try {
        await page.goto(origin + PROFILE);
        await page.locator('[data-hook="change-email"]').click();
        const dialog = dialogOf(page, "Change email");
        const field = dialog.getByLabel("Email");
        expect(await field.inputValue()).toBe(owner.email);
        const save = dialog.getByRole("button", { name: "Save" });
        for (const [value, text] of [
          ["", "Enter your email address."],
          ["ada", "Enter an email like name@example.com."],
          ["ada@", "Enter an email like name@example.com."],
          [`${"a".repeat(243)}@example.com`, "Use 254 characters or fewer."],
        ] as const) {
          await field.fill(value);
          await save.click();
          await dialog.getByText(text).waitFor();
        }
        expect(requests.filter((r) => r.method === "PATCH")).toEqual([]);

        await field.fill("Ada.Lovelace@Example.COM");
        await save.click();
        await done(page).getByText("Email changed").waitFor();
        await page
          .getByText("ada.lovelace@example.com. You sign in with it.")
          .waitFor();
        expect((await theOwner()).email).toBe("ada.lovelace@example.com");
        // The same browser is still signed in.
        const again = await page.goto(origin + PROFILE);
        expect(again?.status()).toBe(200);
        expect(new URL(page.url()).pathname).toBe(PROFILE);
      } finally {
        await context.close();
        await restore();
      }
    },
  );

  inBrowser("takes an address of 254 characters", async () => {
    const { page, context } = await open();
    try {
      const address = `${"a".repeat(242)}@example.com`;
      expect(address).toHaveLength(254);
      await page.goto(origin + PROFILE);
      await page.locator('[data-hook="change-email"]').click();
      const dialog = dialogOf(page, "Change email");
      await dialog.getByLabel("Email").fill(address);
      await dialog.getByRole("button", { name: "Save" }).click();
      await done(page).getByText("Email changed").waitFor();
      expect((await theOwner()).email).toBe(address);
    } finally {
      await context.close();
      await restore();
    }
  });

  inBrowser(
    "says what the server refused in the dialog, and keeps what was typed",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(origin + PROFILE);
        await page.locator('[data-hook="change-email"]').click();
        const dialog = dialogOf(page, "Change email");
        // The browser's check lets this through; the server's does not.
        await dialog.getByLabel("Email").fill("a..b@example.com");
        await dialog.getByRole("button", { name: "Save" }).click();
        await dialog
          .getByText("Enter an email like name@example.com.")
          .waitFor();
        expect(await dialog.getByLabel("Email").inputValue()).toBe(
          "a..b@example.com",
        );
        expect((await theOwner()).email).toBe(owner.email);
        // The dialog is still open and can be cancelled.
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await dialog.waitFor({ state: "hidden" });
        await page.locator('[data-hook="change-email"]').click();
        expect(await dialog.getByLabel("Email").inputValue()).toBe(owner.email);
        await dialog
          .getByText("Enter an email like name@example.com.")
          .waitFor({
            state: "detached",
          });
      } finally {
        await context.close();
        await restore();
      }
    },
  );

  inBrowser(
    "asks to confirm it's you after five minutes, then sends the change once, and sends nothing on Cancel",
    async () => {
      const { page, context, requests } = await open();
      try {
        await page.goto(origin + PROFILE);
        await ageSessions();
        await page.locator('[data-hook="change-name"]').click();
        const dialog = dialogOf(page, "Change name");
        await dialog.getByLabel("Name").fill("After the wait");
        await dialog.getByRole("button", { name: "Save" }).click();
        const confirm = dialogOf(page, "Confirm it's you");
        await confirm.waitFor();
        expect(await confirm.innerText()).toContain(
          "To change your name, confirm it's you.",
        );
        expect((await theOwner()).name).not.toBe("After the wait");

        // Cancel sends nothing more and changes nothing.
        const sent = requests.filter((r) => r.path === "/owner").length;
        await confirm.getByRole("button", { name: "Cancel" }).click();
        await confirm.waitFor({ state: "hidden" });
        expect(requests.filter((r) => r.path === "/owner")).toHaveLength(sent);
        expect((await theOwner()).name).not.toBe("After the wait");

        // Confirming with the password sends it once more, and only once.
        await dialog.getByRole("button", { name: "Save" }).click();
        await confirm.waitFor();
        await confirm.getByLabel("Or your password").fill(password);
        await confirm.getByRole("button", { name: "Continue" }).click();
        await done(page).getByText("Name changed").waitFor();
        expect((await theOwner()).name).toBe("After the wait");
        const sends = requests.filter((r) => r.path === "/owner");
        expect(sends.filter((r) => r.status === 200)).toHaveLength(1);
        expect(sends.filter((r) => r.status === 403)).toHaveLength(2);
      } finally {
        await context.close();
        await restore();
        await clearSignInWindows();
      }
    },
  );
});

describe("Password and passkeys, the password", () => {
  inBrowser(
    "says a wrong current password in place and a bad new one before sending",
    async () => {
      const { page, context, requests, violations, errors } = await open();
      try {
        await page.goto(origin + PASSKEYS);
        await page.locator('[data-hook="change-password"]').click();
        const dialog = dialogOf(page, "Change password");
        await dialog.getByText("8 to 128 characters.").waitFor();
        const submit = dialog.getByRole("button", { name: "Change password" });

        await submit.click();
        await dialog.getByText("Enter your current password.").waitFor();
        await dialog.getByText("Use 8 to 128 characters.").waitFor();

        await dialog.getByLabel("Current password").fill(password);
        await dialog.getByLabel("New password").fill("short");
        await submit.click();
        await dialog.getByText("Use 8 to 128 characters.").waitFor();
        await dialog.getByLabel("New password").fill("x".repeat(129));
        await submit.click();
        await dialog.getByText("Use 8 to 128 characters.").waitFor();
        expect(requests.filter((r) => r.method === "POST")).toEqual([]);

        await dialog.getByLabel("Current password").fill("not the password");
        await dialog.getByLabel("New password").fill("a new password here");
        await submit.click();
        await dialog.getByText("That password is wrong. Try again.").waitFor();
        expect(
          await dialog
            .getByLabel("Current password")
            .evaluate((e) => e === document.activeElement),
        ).toBe(true);
        expect(
          requests.filter((r) => r.path === "/auth/change-password"),
        ).toEqual([
          { method: "POST", path: "/auth/change-password", status: 401 },
        ]);
        expect(await violations()).toEqual([]);
        expect(errors.filter((e) => !e.includes("401"))).toEqual([]);

        // 128 characters is allowed by the browser's own check.
        await dialog.getByLabel("Current password").fill(password);
        await dialog.getByLabel("New password").fill("x".repeat(128));
        await submit.click();
        await done(page)
          .getByText(/^Password changed\./)
          .waitFor();
        password = "x".repeat(128);
      } finally {
        await context.close();
        await clearSignInWindows();
        await putPasswordBack();
      }
    },
  );

  inBrowser(
    "keeps this browser signed in and signs the other one out",
    async () => {
      const mine = await open();
      const other = await open();
      try {
        await other.page.goto(origin + PROFILE);
        await other.page
          .getByRole("heading", { name: "Profile", level: 1 })
          .waitFor();
        await mine.page.goto(origin + PASSKEYS);
        await mine.page.locator('[data-hook="change-password"]').click();
        const dialog = dialogOf(mine.page, "Change password");
        await dialog.getByLabel("Current password").fill(password);
        await dialog.getByLabel("New password").fill("a new password here");
        await dialog.getByRole("button", { name: "Change password" }).click();
        await done(mine.page)
          .getByText("Password changed. Your other browsers are signed out.")
          .waitFor();
        const old = password;
        password = "a new password here";

        const stays = await mine.page.goto(origin + PASSKEYS);
        expect(stays?.status()).toBe(200);
        expect(new URL(mine.page.url()).pathname).toBe(PASSKEYS);

        await other.page.goto(origin + PROFILE);
        expect(new URL(other.page.url()).pathname).toBe("/auth/sign-in");

        // The old password no longer signs in; the new one does.
        const refused = await mine.context.request.post(
          `${origin}/auth/sign-in/email`,
          { headers: { origin }, data: { email: owner.email, password: old } },
        );
        expect(refused.status()).toBe(401);
        const accepted = await mine.context.request.post(
          `${origin}/auth/sign-in/email`,
          { headers: { origin }, data: { email: owner.email, password } },
        );
        expect(accepted.status()).toBe(200);
        expect(mine.errors.filter((e) => !e.includes("401"))).toEqual([]);
      } finally {
        await mine.context.close();
        await other.context.close();
        await clearSignInWindows();
        await putPasswordBack();
      }
    },
  );

  inBrowser(
    "says how long to wait when too many wrong passwords have been tried",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(origin + PASSKEYS);
        // Signing in counted once against the window; start from an empty one.
        await clearSignInWindows();
        for (let i = 0; i < SIGN_IN_ADDRESS_LIMIT; i++) {
          const wrong = await context.request.post(
            `${origin}/auth/change-password`,
            {
              headers: { origin },
              data: {
                currentPassword: `guess ${String(i)}`,
                newPassword: "a new password here",
              },
            },
          );
          expect(wrong.status()).toBe(401);
        }
        await page.locator('[data-hook="change-password"]').click();
        const dialog = dialogOf(page, "Change password");
        await dialog.getByLabel("Current password").fill(password);
        await dialog.getByLabel("New password").fill("a new password here");
        await dialog.getByRole("button", { name: "Change password" }).click();
        await dialog.getByText(/^Too many attempts\. Try again in /).waitFor();
        // Nothing changed: once the window is clear the same password signs in.
        await clearSignInWindows();
        const still = await context.request.post(
          `${origin}/auth/sign-in/email`,
          { headers: { origin }, data: { email: owner.email, password } },
        );
        expect(still.status()).toBe(200);
      } finally {
        await context.close();
        await clearSignInWindows();
      }
    },
  );

  inBrowser(
    "is reachable by keyboard alone, and Escape closes the dialog and returns focus",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(origin + PASSKEYS);
        await page.locator('[data-hook="change-password"]').focus();
        await page.keyboard.press("Enter");
        const dialog = dialogOf(page, "Change password");
        await dialog.waitFor();
        expect(
          await dialog
            .getByLabel("Current password")
            .evaluate((e) => e === document.activeElement),
        ).toBe(true);
        await page.keyboard.type("typed and abandoned");
        // Tab reaches every control in the dialog, and nothing behind it.
        const reached: string[] = [];
        for (let i = 0; i < 12; i++) {
          const here = await page.evaluate(() => {
            const active = document.activeElement;
            if (active?.closest("dialog") == null) return null;
            return (
              [
                active.id,
                active.getAttribute("aria-label") ?? "",
                active.textContent.trim(),
              ].find((name) => name !== "") ?? "unnamed"
            );
          });
          if (here === null) break;
          reached.push(here);
          await page.keyboard.press("Tab");
        }
        expect(reached).toEqual(
          expect.arrayContaining([
            "password-current",
            "password-new",
            "Cancel",
            "Change password",
          ]),
        );
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        expect(
          await page
            .locator('[data-hook="change-password"]')
            .evaluate((e) => e === document.activeElement),
        ).toBe(true);
        // What was typed is gone, whether the dialog is shut or opened again.
        // The browser tells the page that a dialog closed in a task of its own.
        await expect
          .poll(() => page.locator("#password-current").inputValue())
          .toBe("");
        await page.keyboard.press("Enter");
        await dialog.waitFor();
        expect(await dialog.getByLabel("Current password").inputValue()).toBe(
          "",
        );
      } finally {
        await context.close();
      }
    },
  );
});

/** Puts the password back to the one every other case signs in with. */
async function putPasswordBack(): Promise<void> {
  if (password === ORIGINAL_PASSWORD) return;
  const { context } = await open();
  try {
    const res = await context.request.post(`${origin}/auth/change-password`, {
      headers: { origin },
      data: { currentPassword: password, newPassword: ORIGINAL_PASSWORD },
    });
    expect(res.status()).toBe(200);
    password = ORIGINAL_PASSWORD;
  } finally {
    await context.close();
  }
}

const sqlite = () =>
  ctx.storage as unknown as {
    __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
  };

/**
 * A passkey the owner has, made by the database alone: the page only reads its
 * name and date, so a case that is not about registering need not run a
 * ceremony.
 */
async function seedPasskey(
  id: string,
  name: string,
  createdAt: Date,
): Promise<void> {
  await sqlite().__sqliteRun(
    "INSERT INTO auth_passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, created_at) VALUES (?, ?, 'key', ?, ?, 0, 'singleDevice', 0, ?)",
    [
      id,
      name,
      (await theOwner()).id,
      `credential-${id}`,
      createdAt.getTime() / 1000,
    ],
  );
}

async function dropSeededPasskeys(): Promise<void> {
  await sqlite().__sqliteRun(
    "DELETE FROM auth_passkey WHERE credential_id LIKE 'credential-seed-%'",
    [],
  );
}

const storedPasskeys = async () =>
  (await ctx.auth.listOwnerPasskeys((await theOwner()).id)).map(
    (passkey) => passkey.name,
  );

/** Opens the Manage dialog of the passkey with this name. */
async function manage(page: Page, name: string) {
  await page
    .locator(".row", { hasText: name })
    .getByRole("button", { name: "Manage" })
    .click();
  return dialogOf(page, "Manage passkey");
}

describe("Password and passkeys, the passkeys", () => {
  inBrowser(
    "starts empty, adds a passkey with the suggested name, renames it, and removes the last one",
    async () => {
      const { page, context, violations, errors } = await open({
        passkeys: true,
      });
      try {
        await page.goto(origin + PASSKEYS);
        await page.getByText("No passkeys yet").waitFor();

        await page.locator('[data-hook="add-passkey"]').click();
        const add = dialogOf(page, "Add a passkey");
        const suggested = await add.getByLabel("Name").inputValue();
        expect(suggested).not.toBe("");
        await add.getByRole("button", { name: "Add passkey" }).click();
        await done(page).getByText("Passkey added").waitFor();
        await page.getByText(suggested, { exact: true }).first().waitFor();
        await page.getByText(/^Added /).waitFor();
        expect(await page.getByText("No passkeys yet").count()).toBe(0);

        // A second one suggests a different name.
        await page.locator('[data-hook="add-passkey"]').click();
        expect(await add.getByLabel("Name").inputValue()).not.toBe(suggested);
        await add.getByRole("button", { name: "Cancel" }).click();

        await page.getByRole("button", { name: "Manage" }).click();
        const manage = dialogOf(page, "Manage passkey");
        const field = manage.getByLabel("Name");
        const save = manage.getByRole("button", { name: "Save name" });
        await field.fill("   ");
        await save.click();
        await manage.getByText("Give the passkey a name.").waitFor();
        await field.fill("y".repeat(201));
        await save.click();
        await manage.getByText("Use 200 characters or fewer.").waitFor();
        await field.fill("Laptop");
        await save.click();
        await done(page).getByText("Passkey renamed").waitFor();
        await page.getByText("Laptop", { exact: true }).waitFor();

        await page.getByRole("button", { name: "Manage" }).click();
        await manage.getByRole("button", { name: "Remove passkey" }).click();
        const remove = dialogOf(page, "Remove Laptop?");
        await remove
          .getByText("You can still sign in with your password.")
          .waitFor();
        await remove.getByRole("button", { name: "Remove passkey" }).click();
        await done(page).getByText("Passkey removed").waitFor();
        await page.getByText("No passkeys yet").waitFor();
        const ownerId = (await theOwner()).id;
        expect(await ctx.auth.listOwnerPasskeys(ownerId)).toHaveLength(0);

        // Home says what is left.
        await page.goto(origin);
        await page.getByText("Password only").waitFor();
        expect(await violations()).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "is told by Add when the browser cannot make a passkey, and opens no dialog",
    async () => {
      const { page, context } = await open({ withoutWebAuthn: true });
      try {
        await page.goto(origin + PASSKEYS);
        await page.locator('[data-hook="add-passkey"]').click();
        await page.getByText("Passkeys can't be added here.").waitFor();
        expect(await page.locator("dialog[open]").count()).toBe(0);
        // The rest of the page still works.
        await page.locator('[data-hook="change-password"]').click();
        await dialogOf(page, "Change password").waitFor();
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "keeps a long passkey name inside a phone's width, in light and dark",
    async () => {
      const backgrounds: Record<string, string> = {};
      for (const scheme of ["light", "dark"] as const) {
        const { page, context, violations, errors } = await open({
          width: 375,
          scheme,
          passkeys: true,
        });
        try {
          await page.goto(origin + PASSKEYS);
          await page.locator('[data-hook="add-passkey"]').click();
          const add = dialogOf(page, "Add a passkey");
          await add.getByLabel("Name").fill(LONG_UNBROKEN);
          await add.getByRole("button", { name: "Add passkey" }).click();
          await done(page).getByText("Passkey added").waitFor();
          expect(await overflow(page), scheme).toBeLessThanOrEqual(0);
          await page.getByRole("button", { name: "Manage" }).click();
          const manage = dialogOf(page, "Manage passkey");
          expect(await overflow(page), scheme).toBeLessThanOrEqual(0);
          await manage.getByRole("button", { name: "Remove passkey" }).click();
          expect(await overflow(page), scheme).toBeLessThanOrEqual(0);
          backgrounds[scheme] = await page.evaluate(
            () => getComputedStyle(document.body).backgroundColor,
          );
          const remove = dialogOf(page, `Remove ${LONG_UNBROKEN}?`);
          await remove.getByRole("button", { name: "Remove passkey" }).click();
          await page.getByText("No passkeys yet").waitFor();
          await page.goto(origin + PROFILE);
          expect(await overflow(page), scheme).toBeLessThanOrEqual(0);
          expect(await violations()).toEqual([]);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
      expect(backgrounds.light).not.toBe(backgrounds.dark);
    },
  );
});

describe("Password and passkeys, dates, stale sign-ins and refusals", () => {
  inBrowser(
    "writes when a passkey was added in the viewer's own time zone, and again after the list is read again",
    async () => {
      await seedPasskey("seed-a", "Evening", new Date("2026-03-31T20:00:00Z"));
      await seedPasskey("seed-b", "Morning", new Date("2026-04-01T05:00:00Z"));
      try {
        for (const [timezoneId, evening, morning] of [
          ["UTC", "March 31, 2026", "April 1, 2026"],
          ["Pacific/Kiritimati", "April 1, 2026", "April 1, 2026"],
          ["Pacific/Pago_Pago", "March 31, 2026", "March 31, 2026"],
        ] as const) {
          const { page, context } = await open({ timezoneId });
          try {
            await page.goto(origin + PASSKEYS);
            const time = (name: string) =>
              page.locator(".row", { hasText: name }).locator("time");
            expect(await time("Evening").innerText(), timezoneId).toBe(evening);
            expect(await time("Morning").innerText(), timezoneId).toBe(morning);
            // The instant is kept whole for anything that reads it.
            expect(await time("Evening").getAttribute("datetime")).toBe(
              "2026-03-31T20:00:00.000Z",
            );
            if (timezoneId !== "Pacific/Kiritimati") continue;
            // The server draws the list again after a change, in UTC.
            const dialog = await manage(page, "Evening");
            await dialog.getByLabel("Name").fill("Evening again");
            await dialog.getByRole("button", { name: "Save name" }).click();
            await done(page).getByText("Passkey renamed").waitFor();
            expect(await time("Evening again").innerText()).toBe(evening);
            expect(await time("Morning").innerText()).toBe(morning);
          } finally {
            await context.close();
          }
        }
      } finally {
        await dropSeededPasskeys();
      }
    },
  );

  inBrowser(
    "says a passkey that is already gone is removed, and shows any other 404 as the refusal it is",
    async () => {
      await seedPasskey("seed-gone", "Gone", new Date());
      await seedPasskey("seed-kept", "Kept", new Date());
      const { page, context } = await open();
      try {
        await page.goto(origin + PASSKEYS);

        // A 404 that is not "no such passkey" is a refusal: the passkey may still be there.
        const refuseAsOwnerless = async (route: Route) => {
          if (route.request().method() !== "DELETE") return route.continue();
          await route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "owner_not_found",
                message: "The owner's account is unavailable.",
              },
            }),
          });
        };
        await page.route("**/owner/passkeys/*", refuseAsOwnerless);
        const kept = await manage(page, "Kept");
        await kept.getByRole("button", { name: "Remove passkey" }).click();
        const removeKept = dialogOf(page, "Remove Kept?");
        await removeKept
          .getByRole("button", { name: "Remove passkey" })
          .click();
        await removeKept
          .getByText("The owner's account is unavailable.")
          .waitFor();
        expect(await done(page).isHidden()).toBe(true);
        expect(await removeKept.isVisible()).toBe(true);
        expect(await storedPasskeys()).toEqual(["Gone", "Kept"]);
        await page.unroute("**/owner/passkeys/*", refuseAsOwnerless);
        await removeKept.getByRole("button", { name: "Cancel" }).click();
        await kept.getByRole("button", { name: "Cancel" }).click();

        // A passkey gone before the button is pressed: the server answers passkey_not_found.
        const gone = await manage(page, "Gone");
        await gone.getByRole("button", { name: "Remove passkey" }).click();
        const remove = dialogOf(page, "Remove Gone?");
        await sqlite().__sqliteRun(
          "DELETE FROM auth_passkey WHERE id = 'seed-gone'",
          [],
        );
        await remove.getByRole("button", { name: "Remove passkey" }).click();
        await done(page).getByText("Passkey removed").waitFor();
        await page.getByText("Gone", { exact: true }).waitFor({
          state: "detached",
        });
        expect(await storedPasskeys()).toEqual(["Kept"]);
      } finally {
        await context.close();
        await dropSeededPasskeys();
      }
    },
  );

  inBrowser(
    "asks to confirm it's you before renaming a passkey after five minutes, and sends the rename once",
    async () => {
      await seedPasskey("seed-rename", "Before", new Date());
      const { page, context, requests } = await open();
      try {
        await page.goto(origin + PASSKEYS);
        await ageSessions();
        const dialog = await manage(page, "Before");
        await dialog.getByLabel("Name").fill("After");
        await dialog.getByRole("button", { name: "Save name" }).click();
        const confirm = dialogOf(page, "Confirm it's you");
        await confirm.waitFor();
        expect(await confirm.innerText()).toContain(
          "To rename a passkey, confirm it's you.",
        );
        expect(await storedPasskeys()).toEqual(["Before"]);

        // Cancel sends nothing more.
        const sent = () =>
          requests.filter((r) => r.path.startsWith("/owner/passkeys/"));
        const refused = sent().length;
        await confirm.getByRole("button", { name: "Cancel" }).click();
        await confirm.waitFor({ state: "hidden" });
        expect(sent()).toHaveLength(refused);
        expect(await storedPasskeys()).toEqual(["Before"]);

        await dialog.getByRole("button", { name: "Save name" }).click();
        await confirm.waitFor();
        await confirm.getByLabel("Or your password").fill(password);
        await confirm.getByRole("button", { name: "Continue" }).click();
        await done(page).getByText("Passkey renamed").waitFor();
        expect(await storedPasskeys()).toEqual(["After"]);
        expect(sent().filter((r) => r.status === 200)).toEqual([
          { method: "PATCH", path: "/owner/passkeys/seed-rename", status: 200 },
        ]);
        expect(sent().filter((r) => r.status === 403)).toHaveLength(2);
      } finally {
        await context.close();
        await dropSeededPasskeys();
        await clearSignInWindows();
      }
    },
  );

  inBrowser(
    "asks to confirm it's you before removing a passkey after five minutes, and sends the removal once",
    async () => {
      await seedPasskey("seed-remove", "Doomed", new Date());
      const { page, context, requests } = await open();
      try {
        await page.goto(origin + PASSKEYS);
        await ageSessions();
        const dialog = await manage(page, "Doomed");
        await dialog.getByRole("button", { name: "Remove passkey" }).click();
        const remove = dialogOf(page, "Remove Doomed?");
        await remove.getByRole("button", { name: "Remove passkey" }).click();
        const confirm = dialogOf(page, "Confirm it's you");
        await confirm.waitFor();
        expect(await confirm.innerText()).toContain(
          "To remove a passkey, confirm it's you.",
        );
        expect(await storedPasskeys()).toEqual(["Doomed"]);

        const sent = () => requests.filter((r) => r.method === "DELETE");
        const refused = sent().length;
        await confirm.getByRole("button", { name: "Cancel" }).click();
        await confirm.waitFor({ state: "hidden" });
        expect(sent()).toHaveLength(refused);
        expect(await storedPasskeys()).toEqual(["Doomed"]);

        await remove.getByRole("button", { name: "Remove passkey" }).click();
        await confirm.waitFor();
        await confirm.getByLabel("Or your password").fill(password);
        await confirm.getByRole("button", { name: "Continue" }).click();
        await done(page).getByText("Passkey removed").waitFor();
        expect(await storedPasskeys()).toEqual([]);
        expect(sent().filter((r) => r.status === 200)).toHaveLength(1);
        expect(sent().filter((r) => r.status === 403)).toHaveLength(2);
      } finally {
        await context.close();
        await dropSeededPasskeys();
        await clearSignInWindows();
      }
    },
  );

  inBrowser(
    "keeps a dialog open on Escape while its change is being sent",
    async () => {
      await seedPasskey("seed-busy", "Busy", new Date());
      const { page, context } = await open();
      try {
        await page.goto(origin + PASSKEYS);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route("**/owner/passkeys/*", async (route) => {
          if (route.request().method() !== "PATCH") return route.continue();
          await held;
          await route.continue();
        });
        const dialog = await manage(page, "Busy");
        await dialog.getByLabel("Name").fill("Busy again");
        await dialog.getByRole("button", { name: "Save name" }).click();
        await dialog.locator('.card[aria-busy="true"]').waitFor();
        await page.keyboard.press("Escape");
        expect(await dialog.isVisible()).toBe(true);
        release();
        await done(page).getByText("Passkey renamed").waitFor();
        // Witness: once nothing is being sent, the same key closes it.
        await manage(page, "Busy again");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
      } finally {
        await context.close();
        await dropSeededPasskeys();
      }
    },
  );

  inBrowser(
    "keeps Add hidden and the address notice shown where the address is an IP address",
    async () => {
      const reserved = await reserveOrigin();
      const ipCtx = await createTestContext(
        { authBaseUrl: reserved.origin, trustedProxyHeader: "x-real-ip" },
        owner,
      );
      const ipServer = listen(ipCtx.app, reserved.port);
      const context = await browser.newContext({
        extraHTTPHeaders: newAddress(),
      });
      try {
        const signedIn = await context.request.post(
          `${reserved.origin}/auth/sign-in/email`,
          { headers: { origin: reserved.origin }, data: owner },
        );
        expect(signedIn.status()).toBe(200);
        const page = await context.newPage();
        await page.goto(reserved.origin + PASSKEYS);
        const notice = page.getByText("Passkeys can't be added here.");
        await notice.waitFor();
        // Witness: the page's script has run, which unhides Add at a good address.
        await page.getByRole("button", { name: "Change password" }).waitFor();
        await page.locator('[data-hook="change-password"]').click();
        await dialogOf(page, "Change password").waitFor();
        expect(await page.locator('[data-hook="add-passkey"]').isHidden()).toBe(
          true,
        );
        expect(await notice.isVisible()).toBe(true);
      } finally {
        await context.close();
        await ipServer.close();
        await ipCtx.cleanup();
      }
    },
  );
});
