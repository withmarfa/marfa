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
        "Making a key lets something new reach your data. Changes like this need a sign-in from the last 5 minutes.",
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
      // Past the window a sign-in address is counted over, so the next case starts clear.
      clock.advanceClock(16 * MINUTE);
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
      // Focus is back on the button that was pressed, inside the page's own markup.
      await expect
        .poll(() =>
          page.evaluate(
            "document.activeElement === document.querySelector('#mint button')",
          ),
        )
        .toBe(true);
      expect(await keySources()).not.toContain("cancelled-key");
    } finally {
      // Past the window a sign-in address is counted over, so the next case starts clear.
      clock.advanceClock(16 * MINUTE);
      await context.close();
    }
  });

  it("asks to confirm it's you to revoke a key, and revokes it once", async () => {
    const { context, page } = await signedIn();
    try {
      const made = await context.request.post(`${origin}/keys`, {
        headers: { origin },
        data: {
          label: "To revoke",
          source: "to-revoke",
          permissions: ["instance.read"],
        },
      });
      expect(made.status()).toBe(201);
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
      // Past the window a sign-in address is counted over, so the next case starts clear.
      clock.advanceClock(16 * MINUTE);
      await context.close();
    }
  });
});

inBrowser(
  "Manage, signing out this browser with a sign-in older than five minutes",
  () => {
    it("signs this browser out in one request, with no question", async () => {
      const { context, page } = await signedIn();
      try {
        await page.goto(`${origin}/auth/owner/manage`);
        await page.locator("#health").filter({ hasText: "Status:" }).waitFor();
        clock.advanceClock(6 * MINUTE);
        page.on("dialog", (alert) => void alert.accept());
        let deletes = 0;
        page.on("request", (request) => {
          if (
            request.method() === "DELETE" &&
            request.url().includes("/owner/sign-ins/")
          )
            deletes += 1;
        });
        await page
          .locator("#browsers li")
          .filter({ hasText: "(this browser)" })
          .getByRole("button", { name: "Sign out" })
          .click();
        await page.waitForURL(/\/auth\/sign-in/);
        expect(deletes).toBe(1);
        expect(await dialogOf(page).count()).toBe(0);
        const after = await context.request.get(`${origin}/owner/sign-ins`);
        expect(after.status()).toBe(401);
      } finally {
        clock.advanceClock(16 * MINUTE);
        await context.close();
      }
    });
  },
);

inBrowser("The confirmation's password field", () => {
  it("has the show-password button on a page with a stylesheet of its own", async () => {
    const { context, page } = await signedIn();
    try {
      await page.goto(`${origin}/auth/owner/manage`);
      await page.locator("#health").filter({ hasText: "Status:" }).waitFor();
      clock.advanceClock(6 * MINUTE);
      await page.locator("summary").click();
      await page.fill("#label", "Toggle key");
      await page.fill("#source", "toggle-key");
      await page.click("#mint button");
      const dialog = dialogOf(page);
      await dialog.waitFor();
      const field = dialog.getByLabel("Or your password");
      const toggle = dialog.getByRole("button", { name: "Show password" });
      expect(await toggle.isVisible()).toBe(false);
      await field.fill("typed");
      await toggle.click();
      expect(await field.getAttribute("type")).toBe("text");
      await dialog.getByRole("button", { name: "Hide password" }).click();
      expect(await field.getAttribute("type")).toBe("password");
    } finally {
      clock.advanceClock(16 * MINUTE);
      await context.close();
    }
  });
});

inBrowser("Restore, with a sign-in older than five minutes", () => {
  async function archiveFile() {
    const exported = await ctx.ownerRequest("/export?format=archive");
    expect(exported.status).toBe(200);
    return {
      name: "marfa.tgz",
      mimeType: "application/gzip",
      buffer: Buffer.from(await exported.arrayBuffer()),
    };
  }

  /** The uploads a page has sent, counted as the browser sends them. */
  function countUploads(page: Page): () => number {
    let sent = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url() === `${origin}/restore`)
        sent += 1;
    });
    return () => sent;
  }

  it("asks to confirm it's you before the upload starts, then sends it once", async () => {
    const { context, page } = await signedIn();
    try {
      const archive = await archiveFile();
      clock.advanceClock(6 * MINUTE);
      await page.goto(`${origin}/auth/owner/restore`);
      const uploads = countUploads(page);
      await page.setInputFiles("#archive", archive);
      await page.click("#restore button");
      expect(await dialogOf(page).innerText()).toContain(
        "Restoring adds to your data.",
      );
      expect(uploads()).toBe(0);
      await confirmWithPassword(page);
      await page.locator("#result").filter({ hasText: "Restored" }).waitFor();
      expect(uploads()).toBe(1);
    } finally {
      // Past the window a sign-in address is counted over, so the next case starts clear.
      clock.advanceClock(16 * MINUTE);
      await context.close();
    }
  });

  it("sends nothing when the person cancels the question", async () => {
    const { context, page } = await signedIn();
    try {
      const archive = await archiveFile();
      clock.advanceClock(6 * MINUTE);
      await page.goto(`${origin}/auth/owner/restore`);
      const uploads = countUploads(page);
      await page.setInputFiles("#archive", archive);
      await page.click("#restore button");
      await dialogOf(page).waitFor();
      await page.keyboard.press("Escape");
      await page
        .locator("#result")
        .filter({ hasText: "Nothing was restored" })
        .waitFor();
      expect(uploads()).toBe(0);
    } finally {
      // Past the window a sign-in address is counted over, so the next case starts clear.
      clock.advanceClock(16 * MINUTE);
      await context.close();
    }
  });

  it("still asks when the server refuses an upload the page thought was in time", async () => {
    const { context, page } = await signedIn();
    try {
      const archive = await archiveFile();
      await page.goto(`${origin}/auth/owner/restore`);
      const uploads = countUploads(page);
      // Only the server's clock moves, so the page has no way to know.
      clock.advanceClock(6 * MINUTE);
      await page.setInputFiles("#archive", archive);
      await page.click("#restore button");
      await confirmWithPassword(page);
      await page.locator("#result").filter({ hasText: "Restored" }).waitFor();
      expect(uploads()).toBe(2);
    } finally {
      // Past the window a sign-in address is counted over, so the next case starts clear.
      clock.advanceClock(16 * MINUTE);
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
      // Past the window a sign-in address is counted over, so the next case starts clear.
      clock.advanceClock(16 * MINUTE);
      await context.close();
    }
  });
});

inBrowser(
  "Passkeys, with the sign-in going stale during the passkey prompt",
  () => {
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

    /** Lets the first registration reach the server only after the five minutes have run out. */
    async function staleOnFirstVerify(page: Page): Promise<() => number> {
      let verifies = 0;
      await page.route("**/auth/passkey/verify-registration", async (route) => {
        verifies += 1;
        if (verifies === 1) clock.advanceClock(6 * MINUTE);
        await route.continue();
      });
      return () => verifies;
    }

    const countPasskeys = async (): Promise<number> =>
      (
        await ctx.auth.listOwnerPasskeys(
          (await ctx.storage.owner?.find())?.id ?? "",
        )
      ).length;

    it("asks to confirm it's you and starts the registration again, answered with the password", async () => {
      const { context, page } = await signedIn();
      try {
        await withAuthenticator(context, page);
        await page.goto(`${origin}/auth/owner/passkeys`);
        const before = await countPasskeys();
        const verifies = await staleOnFirstVerify(page);
        await page.fill('[name="passkey-name"]', "Stale during prompt");
        await page.click("#add-passkey");
        expect(await dialogOf(page).innerText()).toContain(
          "Adding a passkey needs a recent sign-in.",
        );
        await confirmWithPassword(page);
        await page.getByText("Passkey added.", { exact: true }).waitFor();
        expect(verifies()).toBe(2);
        expect(await countPasskeys()).toBe(before + 1);
      } finally {
        clock.advanceClock(16 * MINUTE);
        await context.close();
      }
    });

    it("starts the registration again when a passkey answers the question, which replaces the challenge", async () => {
      const { context, page } = await signedIn();
      try {
        const cdp = await context.newCDPSession(page);
        await cdp.send("WebAuthn.enable");
        const add = async (transport: "internal" | "usb"): Promise<string> =>
          (
            await cdp.send("WebAuthn.addVirtualAuthenticator", {
              options: {
                protocol: "ctap2",
                transport,
                hasResidentKey: true,
                hasUserVerification: true,
                isUserVerified: true,
                automaticPresenceSimulation: true,
              },
            })
          ).authenticatorId;
        const answering = (id: string, on: boolean) =>
          cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
            authenticatorId: id,
            enabled: on,
          });
        const first = await add("internal");
        await page.goto(`${origin}/auth/owner/passkeys`);
        await page.fill('[name="passkey-name"]', "First");
        await page.click("#add-passkey");
        await page.getByText("Passkey added.", { exact: true }).waitFor();
        const before = await countPasskeys();

        // The second passkey is made on another device. The first answers the
        // question, then the second makes the registration again.
        await answering(first, false);
        const second = await add("usb");
        let verifies = 0;
        let optionsAsked = 0;
        await page.route(
          "**/auth/passkey/verify-registration",
          async (route) => {
            verifies += 1;
            if (verifies === 1) {
              clock.advanceClock(6 * MINUTE);
              await answering(first, true);
              await answering(second, false);
            }
            await route.continue();
          },
        );
        await page.route(
          "**/auth/passkey/generate-register-options",
          async (route) => {
            optionsAsked += 1;
            if (optionsAsked === 2) {
              await answering(first, false);
              await answering(second, true);
            }
            await route.continue();
          },
        );
        await page.fill('[name="passkey-name"]', "Second");
        await page.click("#add-passkey");
        const dialog = dialogOf(page);
        await dialog.waitFor();
        await dialog.getByRole("button", { name: "Use a passkey" }).click();
        await dialog.waitFor({ state: "hidden" });
        await expect.poll(countPasskeys).toBe(before + 1);
        expect(verifies).toBe(2);
        expect(optionsAsked).toBe(2);
      } finally {
        clock.advanceClock(16 * MINUTE);
        await context.close();
      }
    });
  },
);
