/**
 * The owner's pages that keep a stylesheet of their own (Manage, Restore and
 * Passkeys) asking "Confirm it's you" in a real browser when a change is
 * refused for a sign-in older than five minutes, and carrying the change out
 * once after it. Each case sends its change from a session that is six minutes
 * old on the server's clock.
 */
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as clock from "../clock.js";
import { launchTestBrowser, listen, reserveOrigin } from "../test-browser.js";
import { createTestContext, type TestContext } from "../test-utils.js";

const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const browser: Browser | null = launched instanceof Error ? null : launched;
const inBrowser = browser ? describe : describe.skip;

const MINUTE = 60_000;
const owner = { email: "owner@example.com", password: "correct horse battery" };

let ctx: TestContext;
let origin: string;
let server: { close(): Promise<void> };

beforeAll(async () => {
  // A passkey needs a name for an address, which a number is not.
  const reserved = await reserveOrigin();
  origin = reserved.origin.replace("127.0.0.1", "localhost");
  ctx = await createTestContext({ authBaseUrl: origin }, owner);
  server = listen(ctx.app, reserved.port);
});

afterAll(async () => {
  await server.close();
  await ctx.cleanup();
  await browser?.close();
});

beforeEach(() => {
  clock.installDateShim();
});

async function signedIn(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser!.newContext();
  const response = await context.request.post(`${origin}/auth/sign-in/email`, {
    headers: { origin },
    data: owner,
  });
  expect(response.status()).toBe(200);
  const page = await context.newPage();
  return { context, page };
}

const dialogOf = (page: Page) =>
  page.getByRole("dialog", { name: "Confirm it's you" });

async function confirmWithPassword(page: Page): Promise<void> {
  const dialog = dialogOf(page);
  await dialog.waitFor();
  await dialog.getByLabel("Or your password").fill(owner.password);
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.waitFor({ state: "hidden" });
}

async function keySources(): Promise<string[]> {
  const listed = await ctx.ownerRequest("/keys");
  return ((await listed.json()) as { data: { source: string }[] }).data.map(
    (key) => key.source,
  );
}

inBrowser("Manage, with a sign-in older than five minutes", () => {
  it("asks to confirm it's you to create a key, says a wrong password in place, and makes the key once", async () => {
    const { context, page } = await signedIn();
    try {
      await page.goto(`${origin}/auth/owner/manage`);
      await page.locator("#health").filter({ hasText: "Status:" }).waitFor();
      clock.advanceClock(6 * MINUTE);
      await page.locator("summary").click();
      await page.fill("#label", "Confirmed key");
      await page.fill("#source", "confirmed-key");
      await page.click("#mint button");

      const dialog = dialogOf(page);
      await dialog.waitFor();
      expect(await dialog.innerText()).toContain(
        "Making a key lets something new reach your data. You last signed in more than 5 minutes ago.",
      );
      expect(await keySources()).not.toContain("confirmed-key");
      await dialog.getByLabel("Or your password").fill("not the password");
      await dialog.getByRole("button", { name: "Continue" }).click();
      await dialog.getByText("That password is wrong. Try again.").waitFor();
      expect(await keySources()).not.toContain("confirmed-key");

      await dialog.getByLabel("Or your password").fill(owner.password);
      await dialog.getByRole("button", { name: "Continue" }).click();
      await page.locator("#new-key").filter({ hasText: "marfa_k1_" }).waitFor();
      expect(
        (await keySources()).filter((source) => source === "confirmed-key"),
      ).toHaveLength(1);
    } finally {
      clock.resetClockForTests();
      await context.close();
    }
  });

  it("makes no key when the person cancels, and says nothing went wrong", async () => {
    const { context, page } = await signedIn();
    try {
      await page.goto(`${origin}/auth/owner/manage`);
      await page.locator("#health").filter({ hasText: "Status:" }).waitFor();
      clock.advanceClock(6 * MINUTE);
      await page.locator("summary").click();
      await page.fill("#label", "Cancelled key");
      await page.fill("#source", "cancelled-key");
      await page.click("#mint button");
      await dialogOf(page).waitFor();
      await page.keyboard.press("Escape");
      await dialogOf(page).waitFor({ state: "hidden" });
      expect(await page.textContent("#status")).toBe("");
      await expect
        .poll(() => page.locator("#mint button").isEnabled())
        .toBe(true);
      expect(await keySources()).not.toContain("cancelled-key");
    } finally {
      clock.resetClockForTests();
      await context.close();
    }
  });

  it("asks to confirm it's you to revoke a key, and revokes it once", async () => {
    const { context, page } = await signedIn();
    try {
      const made = await ctx.ownerRequest("/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "To revoke",
          source: "to-revoke",
          permissions: ["instance.read"],
        }),
      });
      expect(made.status).toBe(201);
      page.on("dialog", (alert) => void alert.accept());
      await page.goto(`${origin}/auth/owner/manage`);
      await page.locator("#keys li").filter({ hasText: "To revoke" }).waitFor();
      clock.advanceClock(6 * MINUTE);
      await page
        .locator("#keys li")
        .filter({ hasText: "To revoke" })
        .getByRole("button", { name: "Revoke" })
        .click();
      expect(await dialogOf(page).innerText()).toContain(
        "Revoking a key needs a recent sign-in.",
      );
      await confirmWithPassword(page);
      await page
        .locator("#keys li")
        .filter({ hasText: "To revoke" })
        .waitFor({ state: "detached" });
      expect(await keySources()).not.toContain("to-revoke");
    } finally {
      clock.resetClockForTests();
      await context.close();
    }
  });
});

inBrowser("Restore, with a sign-in older than five minutes", () => {
  it("asks to confirm it's you, then restores the archive once", async () => {
    const { context, page } = await signedIn();
    try {
      const exported = await ctx.ownerRequest("/export?format=archive");
      expect(exported.status).toBe(200);
      const archive = Buffer.from(await exported.arrayBuffer());
      await page.goto(`${origin}/auth/owner/restore`);
      clock.advanceClock(6 * MINUTE);
      await page.setInputFiles("#archive", {
        name: "marfa.tgz",
        mimeType: "application/gzip",
        buffer: archive,
      });
      await page.click("#restore button");
      expect(await dialogOf(page).innerText()).toContain(
        "Restoring adds to your data.",
      );
      await confirmWithPassword(page);
      await page.locator("#result").filter({ hasText: "Restored" }).waitFor();
    } finally {
      clock.resetClockForTests();
      await context.close();
    }
  });
});

inBrowser("Passkeys, with a sign-in older than five minutes", () => {
  it("asks to confirm it's you to add a passkey and to remove one, and a passkey can answer", async () => {
    const { context, page } = await signedIn();
    try {
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
      await page.goto(`${origin}/auth/owner/passkeys`);
      const ownerId = (await ctx.storage.owner?.find())?.id ?? "";

      // Adding, answered with the password.
      clock.advanceClock(6 * MINUTE);
      await page.fill('[name="passkey-name"]', "First");
      await page.click("#add-passkey");
      expect(await dialogOf(page).innerText()).toContain(
        "Adding a passkey needs a recent sign-in.",
      );
      await confirmWithPassword(page);
      await page.getByText("First", { exact: true }).waitFor();
      expect(await ctx.auth.listOwnerPasskeys(ownerId)).toHaveLength(1);

      // Removing, answered with the passkey itself.
      clock.advanceClock(6 * MINUTE);
      await page
        .locator("li")
        .filter({ has: page.getByText("First", { exact: true }) })
        .getByRole("button", { name: "Remove" })
        .click();
      const dialog = dialogOf(page);
      await dialog.waitFor();
      expect(await dialog.innerText()).toContain(
        "Removing a passkey needs a recent sign-in.",
      );
      await dialog.getByRole("button", { name: "Use a passkey" }).click();
      await page.getByText("Passkey removed.", { exact: true }).waitFor();
      expect(await ctx.auth.listOwnerPasskeys(ownerId)).toHaveLength(0);
    } finally {
      clock.resetClockForTests();
      await context.close();
    }
  });
});
