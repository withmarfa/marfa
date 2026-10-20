/**
 * The owner's pages that ask for a change (the API keys pages, Connected apps, Browsers,
 * Manage, Restore, and Password and passkeys) asking "Confirm it's you" in a real browser when a change is
 * refused for a sign-in older than five minutes, and carrying the change out
 * once after it. Each case sends its change from a session that is six minutes
 * old on the server's clock.
 */
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as clock from "../clock.js";
import { launchTestBrowser, listen, reserveOrigin } from "../test-browser.js";
import {
  createTestContext,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";

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

/**
 * Makes the signed-in session six minutes old without moving the clock, which
 * would also end the registration challenge a prompt is still holding.
 */
async function ageSession(): Promise<void> {
  await (
    ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun("UPDATE auth_session SET created_at = created_at - 360", []);
}

/** Opens the Add dialog on Password and passkeys, names the passkey and sends it. */
async function addPasskeyNamed(page: Page, name: string): Promise<void> {
  await page.locator('[data-hook="add-passkey"]').click();
  const dialog = page.getByRole("dialog", { name: "Add a passkey" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Add passkey" }).click();
}

async function keySources(): Promise<string[]> {
  const listed = await ctx.ownerRequest("/keys");
  return ((await listed.json()) as { data: { source: string }[] }).data.map(
    (key) => key.source,
  );
}

/** Opens Create key and fills in a key that needs one power, so the button is ready. */
async function fillCreate(page: Page, name: string): Promise<void> {
  await page.goto(`${origin}/auth/owner/keys/new`);
  await page.getByLabel("Name").fill(name);
  await page.locator("summary", { hasText: "More control over Marfa" }).click();
  await page.locator('input[value="instance.read"]').check();
}

const createButton = (page: Page) =>
  page.getByRole("button", { name: "Create key" });

inBrowser("API keys, with a sign-in older than five minutes", () => {
  it("asks to confirm it's you to create a key, says a wrong password in place, and makes the key once", async () => {
    const { context, page } = await signedIn();
    try {
      await fillCreate(page, "Confirmed key");
      clock.advanceClock(6 * MINUTE);
      let posts = 0;
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url() === `${origin}/keys`)
          posts += 1;
      });
      await createButton(page).click();

      const dialog = dialogOf(page);
      await dialog.waitFor();
      expect(await dialog.innerText()).toContain(
        "Making a key lets something new reach your data. Changes like this need a sign-in from the last 5 minutes.",
      );
      expect(await keySources()).not.toContain("Confirmed key");
      await dialog.getByLabel("Or your password").fill("not the password");
      await dialog.getByRole("button", { name: "Continue" }).click();
      await dialog.getByText("That password is wrong. Try again.").waitFor();
      expect(await keySources()).not.toContain("Confirmed key");

      await dialog.getByLabel("Or your password").fill(owner.password);
      await dialog.getByRole("button", { name: "Continue" }).click();
      await page
        .locator("#key-secret")
        .filter({ hasText: "marfa_k1_" })
        .waitFor();
      expect(
        (await keySources()).filter((source) => source === "Confirmed key"),
      ).toHaveLength(1);
      // The refused send and the one after it; the wrong password sent none.
      expect(posts).toBe(2);
    } finally {
      // Past the window a sign-in address is counted over, so the next case starts clear.
      clock.advanceClock(16 * MINUTE);
      await context.close();
    }
  });

  it("makes no key when the person cancels, and says nothing went wrong", async () => {
    const { context, page } = await signedIn();
    try {
      await fillCreate(page, "Cancelled key");
      clock.advanceClock(6 * MINUTE);
      let posts = 0;
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url() === `${origin}/keys`)
          posts += 1;
      });
      await createButton(page).click();
      await dialogOf(page).waitFor();
      await page.keyboard.press("Escape");
      await dialogOf(page).waitFor({ state: "hidden" });
      expect(await page.locator("[data-notice=problem]").isVisible()).toBe(
        false,
      );
      await expect
        .poll(() =>
          page.evaluate(
            "document.activeElement === document.querySelector('[data-hook=key-submit]')",
          ),
        )
        .toBe(true);
      // Pressing it again asks again.
      await createButton(page).click();
      await dialogOf(page).waitFor();
      await page.keyboard.press("Escape");
      expect(await keySources()).not.toContain("Cancelled key");
      // Both presses were refused for the old sign-in; neither was kept.
      expect(posts).toBe(2);
    } finally {
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
      const { id } = (await made.json()) as { id: string };
      await page.goto(`${origin}/auth/owner/keys/${id}`);
      clock.advanceClock(6 * MINUTE);
      let deletes = 0;
      page.on("request", (request) => {
        if (
          request.method() === "DELETE" &&
          request.url().endsWith(`/keys/${id}`)
        )
          deletes += 1;
      });
      await page.getByRole("button", { name: "Revoke" }).click();
      await page
        .getByRole("dialog", { name: "Revoke To revoke?" })
        .getByRole("button", { name: "Revoke" })
        .click();
      expect(await dialogOf(page).innerText()).toContain(
        "Revoking a key needs a recent sign-in.",
      );
      await confirmWithPassword(page);
      await page.waitForURL(`${origin}/auth/owner/keys`);
      await page.getByText("Revoked To revoke").waitFor();
      expect(await keySources()).not.toContain("to-revoke");
      expect(deletes).toBe(2);
    } finally {
      clock.advanceClock(16 * MINUTE);
      await context.close();
    }
  });

  it("asks to confirm it's you to save a key's changes, and saves them once", async () => {
    const { context, page } = await signedIn();
    try {
      const made = await context.request.post(`${origin}/keys`, {
        headers: { origin },
        data: {
          label: "To narrow",
          source: "to-narrow",
          permissions: ["instance.read"],
        },
      });
      const { id } = (await made.json()) as { id: string };
      await page.goto(`${origin}/auth/owner/keys/${id}`);
      await page
        .locator("summary", { hasText: "More control over Marfa" })
        .click();
      await page.locator('input[value="instance.read"]').uncheck();
      clock.advanceClock(6 * MINUTE);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      expect(await dialogOf(page).innerText()).toContain(
        "Changing a key needs a recent sign-in.",
      );
      await confirmWithPassword(page);
      await page.getByText("Saved").waitFor();
      const stored = await ctx.storage.keys.get(id);
      expect(stored?.permissions).toEqual([]);
    } finally {
      clock.advanceClock(16 * MINUTE);
      await context.close();
    }
  });

  it("looks at the key again after the confirmation, and sends nothing if it changed meanwhile", async () => {
    const { context, page } = await signedIn();
    try {
      const made = await context.request.post(`${origin}/keys`, {
        headers: { origin },
        data: {
          label: "Changed while asking",
          source: "changed-while-asking",
          permissions: ["instance.read"],
        },
      });
      const { id } = (await made.json()) as { id: string };
      await page.goto(`${origin}/auth/owner/keys/${id}`);
      await page
        .locator("summary", { hasText: "More control over Marfa" })
        .click();
      await page.locator('input[value="instance.read"]').uncheck();
      clock.advanceClock(6 * MINUTE);
      let patches = 0;
      page.on("request", (request) => {
        if (
          request.method() === "PATCH" &&
          request.url().endsWith(`/keys/${id}`)
        )
          patches += 1;
      });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await dialogOf(page).waitFor();
      expect(patches).toBe(1);

      // Another window gives the key less while the question is open.
      await ctx.storage.keys.update(id, {
        type_permissions: { "core.note": "read" },
      });
      await confirmWithPassword(page);

      const problem = page.locator("[data-notice=problem]");
      await problem.waitFor({ state: "visible" });
      expect(await problem.innerText()).toContain(
        "This key changed after this page opened. Reload to see it.",
      );
      expect(patches).toBe(1);
      const stored = await ctx.storage.keys.get(id);
      expect(stored?.permissions).toEqual(["instance.read"]);
    } finally {
      clock.advanceClock(16 * MINUTE);
      await context.close();
    }
  });
});

inBrowser("The confirmation's password field", () => {
  it("has the show-password button on the API keys pages", async () => {
    const { context, page } = await signedIn();
    try {
      await fillCreate(page, "Toggle key");
      clock.advanceClock(6 * MINUTE);
      await createButton(page).click();
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
      await addPasskeyNamed(page, "First");
      expect(await dialogOf(page).innerText()).toContain(
        "To add a passkey, confirm it's you.",
      );
      await confirmWithPassword(page);
      await page.getByText("First", { exact: true }).waitFor();
      expect(await ctx.auth.listOwnerPasskeys(ownerId)).toHaveLength(1);

      // Removing, answered with the passkey itself.
      clock.advanceClock(6 * MINUTE);
      await page.getByRole("button", { name: "Manage" }).click();
      await page.getByRole("button", { name: "Remove passkey" }).click();
      await page
        .getByRole("dialog", { name: "Remove First?" })
        .getByRole("button", { name: "Remove passkey" })
        .click();
      const dialog = dialogOf(page);
      await dialog.waitFor();
      expect(await dialog.innerText()).toContain(
        "To remove a passkey, confirm it's you.",
      );
      await dialog.getByRole("button", { name: "Use a passkey" }).click();
      await page.getByText("Passkey removed", { exact: true }).waitFor();
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

    /**
     * Lets the first registration reach the server only after the five minutes
     * have run out, and counts the requests the page makes for it.
     */
    async function staleOnFirstVerify(
      page: Page,
    ): Promise<{ verifies: () => number; options: () => number }> {
      let verifies = 0;
      let options = 0;
      await page.route("**/auth/passkey/verify-registration", async (route) => {
        verifies += 1;
        if (verifies === 1) await ageSession();
        await route.continue();
      });
      await page.route(
        "**/auth/passkey/generate-register-options",
        async (route) => {
          options += 1;
          await route.continue();
        },
      );
      return { verifies: () => verifies, options: () => options };
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
        const requests = await staleOnFirstVerify(page);
        await addPasskeyNamed(page, "Stale during prompt");
        expect(await dialogOf(page).innerText()).toContain(
          "To add a passkey, confirm it's you.",
        );
        await confirmWithPassword(page);
        await page.getByText("Passkey added", { exact: true }).waitFor();
        // The password leaves the first challenge good: the credential already
        // made is sent again, and no second one is made.
        expect(requests.options()).toBe(1);
        expect(requests.verifies()).toBe(2);
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
        await addPasskeyNamed(page, "First");
        await page.getByText("Passkey added", { exact: true }).waitFor();
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
              await ageSession();
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
        await addPasskeyNamed(page, "Second");
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

// Last in the file: signing out the other browsers ends the session `ctx.ownerRequest` holds.
inBrowser(
  "Connected apps and Browsers, with a sign-in older than five minutes",
  () => {
    it("asks to confirm it's you to disconnect an app, and disconnects it once", async () => {
      const { context, page } = await signedIn();
      try {
        const app = await seedOauthBearer(ctx, ["core.note:read"], {
          clientName: "Stale app",
        });
        await page.goto(`${origin}/auth/owner/apps/${app.grantId}`);
        clock.advanceClock(6 * MINUTE);
        let deletes = 0;
        page.on("request", (request) => {
          if (
            request.method() === "DELETE" &&
            request.url().includes("/owner/sign-ins/")
          )
            deletes += 1;
        });
        await page
          .locator('[data-dialog-open="app-disconnect-dialog"]')
          .click();
        await page.locator('[data-hook="app-disconnect"]').click();
        expect(await dialogOf(page).innerText()).toContain(
          "Disconnecting an app needs a recent sign-in.",
        );
        await confirmWithPassword(page);
        await page.waitForURL(`${origin}/auth/owner/apps`);
        // The refused send and the one after it.
        expect(deletes).toBe(2);
        const listed = await ctx.ownerRequest("/owner/sign-ins");
        const rows = ((await listed.json()) as { data: { id: string }[] }).data;
        expect(rows.some((row) => row.id === app.grantId)).toBe(false);
      } finally {
        clock.advanceClock(16 * MINUTE);
        await context.close();
      }
    });

    it("asks to confirm it's you to sign out the other browsers, and signs them out once", async () => {
      const { context, page } = await signedIn();
      const other = await signedIn();
      try {
        await page.goto(`${origin}/auth/owner/browsers`);
        expect(
          (
            await other.context.request.get(`${origin}/owner/sign-ins`)
          ).status(),
        ).toBe(200);
        clock.advanceClock(6 * MINUTE);
        let posts = 0;
        page.on("request", (request) => {
          if (
            request.method() === "POST" &&
            request.url().endsWith("/auth/revoke-other-sessions")
          )
            posts += 1;
        });
        await page
          .locator('[data-dialog-open="browsers-others-dialog"]')
          .click();
        await page.locator('[data-hook="browsers-others"]').click();
        expect(await dialogOf(page).innerText()).toContain(
          "Signing out other browsers needs a recent sign-in.",
        );
        await confirmWithPassword(page);
        await page.getByText("Signed out the other browsers").waitFor();
        expect(posts).toBe(2);
        expect(
          (
            await other.context.request.get(`${origin}/owner/sign-ins`)
          ).status(),
        ).toBe(401);
        // This browser is still signed in.
        expect(
          (await context.request.get(`${origin}/owner/sign-ins`)).status(),
        ).toBe(200);
      } finally {
        clock.advanceClock(16 * MINUTE);
        await other.context.close();
        await context.close();
      }
    });
  },
);
