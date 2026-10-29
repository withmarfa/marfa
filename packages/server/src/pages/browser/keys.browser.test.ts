/**
 * The API keys pages in a real browser against a real listener under the real
 * policy: making a key and seeing its secret once, narrowing and revoking one,
 * the keyboard alone, a phone's width, light and dark, two keys asking for the
 * same source, a key revoked under an open page, and a long list of item types.
 */
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  launchTestBrowser,
  listen,
  reserveOrigin,
} from "../../test-browser.js";
import {
  createTestContext,
  mintWorkingKey,
  TEST_CONTENT_PERMISSIONS,
  cleanupTestContext,
} from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";

const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const inBrowser = launched instanceof Error ? it.skip : it;

let browser: Browser;
let origin: string;
let ctx: TestContext;
let server: { close: () => Promise<void> };

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
  server = listen(ctx.app, reserved.port);
});

afterAll(async () => {
  if (launched instanceof Error) return;
  await browser.close();
  await server.close();
  await cleanupTestContext(ctx);
});

let nextAddress = 1;

interface Opened {
  page: Page;
  context: BrowserContext;
  errors: string[];
  violations: () => Promise<string[]>;
}

async function open(
  options: {
    scheme?: "light" | "dark";
    width?: number;
  } = {},
): Promise<Opened> {
  const context = await browser.newContext({
    colorScheme: options.scheme ?? "light",
    viewport: { width: options.width ?? 1280, height: 900 },
    extraHTTPHeaders: { "x-real-ip": `198.51.100.${String(nextAddress++)}` },
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

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const powers = (page: Page) =>
  page.locator("summary", { hasText: "More control over Marfa" });

/** The `value` of each option a locator finds. */
async function optionValues(options: Locator): Promise<string[]> {
  return Promise.all(
    (await options.all()).map(
      async (option) => (await option.getAttribute("value")) ?? "",
    ),
  );
}

/** Opens every group of access rows, as a person would one at a time. */
const openGroups = (page: Page) =>
  page.evaluate(() => {
    for (const group of document.querySelectorAll("details")) group.open = true;
  });

async function makeKey(
  context: BrowserContext,
  label: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const made = await context.request.post(`${origin}/keys`, {
    headers: { origin },
    data: {
      label,
      source: label.toLowerCase().replace(/ /g, "-"),
      permissions: ["instance.read"],
      type_permissions: { "core.note": "write" },
      ...extra,
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  return ((await made.json()) as { id: string }).id;
}

describe("Create key", () => {
  inBrowser(
    "stays unavailable until it has a name and something to do, says why, and shows the secret once",
    async () => {
      const { page, context, errors, violations } = await open();
      try {
        await page.goto(`${origin}/auth/owner/keys/new`);
        const create = page.getByRole("button", { name: "Create key" });
        await create.waitFor();
        expect(await create.getAttribute("aria-disabled")).toBe("true");
        const reason = page.locator("[data-reason]");
        expect(await reason.textContent()).toBe("Give the key a name");

        await page.getByLabel("Name").fill("Backup script");
        expect(await reason.textContent()).toBe(
          "Turn on at least one thing it can do",
        );
        await powers(page).click();
        await page.locator('input[value="instance.read"]').check();
        expect(await create.getAttribute("aria-disabled")).toBeNull();
        expect(await reason.textContent()).toBe("");

        await create.click();
        const secret = page.locator("#key-secret");
        await secret.filter({ hasText: "marfa_k1_" }).waitFor();
        const shown = (await secret.textContent()) ?? "";
        expect(await page.title()).toContain("Copy your key");
        expect(page.url()).toMatch(/\/auth\/owner\/keys\/[^/]+\/copy$/);
        expect(page.url()).not.toContain(shown);
        expect(
          await page.evaluate(() => [
            localStorage.length,
            sessionStorage.length,
          ]),
        ).toEqual([0, 0]);

        // A second look, by reload, says it cannot be shown again.
        await page.reload();
        await page
          .getByText(/can.t be shown again|no longer/i)
          .first()
          .waitFor();
        expect(await page.content()).not.toContain(shown);

        const listed = await ctx.ownerRequest("/keys");
        const rows = (
          (await listed.json()) as {
            data: { label: string; permissions: string[] }[];
          }
        ).data;
        expect(
          rows.find((row) => row.label === "Backup script")?.permissions,
        ).toEqual(["instance.read"]);
        expect(await violations()).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "puts the focus on what is missing when the button is pressed anyway",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}/auth/owner/keys/new`);
        const create = page.getByRole("button", { name: "Create key" });
        await create.click({ force: true });
        expect(await page.evaluate(() => document.activeElement?.id)).toBe(
          "key-name",
        );
        await page.getByLabel("Name").fill("Needs access");
        await create.click({ force: true });
        expect(
          await page.evaluate(() =>
            document.activeElement?.getAttribute("name"),
          ),
        ).toBe("scopes");
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "can be made with the keyboard alone, and the dialog for revoking is reachable the same way",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}/auth/owner/keys/new`);
        await page.locator("#key-name").focus();
        await page.keyboard.type("Keyboard key");
        await powers(page).focus();
        await page.keyboard.press("Enter");
        await page.locator('input[value="instance.read"]').focus();
        await page.keyboard.press("Space");
        const create = page.getByRole("button", { name: "Create key" });
        await create.focus();
        await page.keyboard.press("Enter");
        await page
          .locator("#key-secret")
          .filter({ hasText: "marfa_k1_" })
          .waitFor();
        // Focus is on the new page's heading, not lost on a hidden form.
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
          "H1",
        );

        const listed = await ctx.ownerRequest("/keys");
        const id = (
          (await listed.json()) as { data: { id: string; label: string }[] }
        ).data.find((row) => row.label === "Keyboard key")!.id;
        await page.goto(`${origin}/auth/owner/keys/${id}`);
        const revoke = page.getByRole("button", { name: "Revoke" });
        await revoke.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", {
          name: "Revoke Keyboard key?",
        });
        await dialog.waitFor();
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        expect(
          await page.evaluate(() => document.activeElement?.textContent.trim()),
        ).toBe("Revoke");
        await page.keyboard.press("Enter");
        await dialog.waitFor();
        await dialog.getByRole("button", { name: "Revoke" }).focus();
        await page.keyboard.press("Enter");
        await page.waitForURL(`${origin}/auth/owner/keys`);
        await page.getByText("Revoked Keyboard key").waitFor();
        expect(await ctx.storage.keys.get(id)).toBeNull();
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "says in place that another key writes as the source, and keeps the form",
    async () => {
      const { page, context } = await open();
      try {
        await makeKey(context, "Source taker");
        await page.goto(`${origin}/auth/owner/keys/new`);
        await page.getByLabel("Name").fill("Second writer");
        await page.getByLabel("Source it writes as").fill("source-taker");
        await powers(page).click();
        await page.locator('input[value="instance.read"]').check();
        await page.getByRole("button", { name: "Create key" }).click();
        const source = page.locator("#key-source");
        await page
          .locator(".row:has(#key-source) .rd.danger")
          .filter({ hasText: /\S/ })
          .waitFor();
        expect(page.url()).toBe(`${origin}/auth/owner/keys/new`);
        expect(await source.inputValue()).toBe("source-taker");
        expect(await page.getByLabel("Name").inputValue()).toBe(
          "Second writer",
        );
        const labels = (
          (await (await ctx.ownerRequest("/keys")).json()) as {
            data: { label: string }[];
          }
        ).data.map((row) => row.label);
        // Witness: the first key is listed, the second is not.
        expect(labels).toContain("Source taker");
        expect(labels).not.toContain("Second writer");
        // Changing the source clears the line and the second press works.
        await source.fill("second-writer");
        await page.getByRole("button", { name: "Create key" }).click();
        await page
          .locator("#key-secret")
          .filter({ hasText: "marfa_k1_" })
          .waitFor();
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "offers every item type to choose when there are many, with a search and a way to set them all",
    async () => {
      const { page, context } = await open();
      try {
        const schemaKey = await mintWorkingKey(ctx, {
          permissions: [...TEST_CONTENT_PERMISSIONS, "schema.write"],
        });
        for (let n = 1; n <= 30; n += 1) {
          const made = await fetch(`${origin}/types`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${schemaKey}`,
            },
            body: JSON.stringify({
              id: `browsertype.t${String(n).padStart(2, "0")}`,
              fields: { title: { type: "string" } },
            }),
          });
          expect(made.status).toBe(201);
        }
        await page.goto(`${origin}/auth/owner/keys/new`);
        await page.getByLabel("Name").fill("Types key");
        await openGroups(page);
        await page
          .getByLabel("All your data")
          .selectOption({ label: "Choose types" });
        await page.getByPlaceholder("Search types").fill("t07");
        const visible = page.locator('select[name="types"]:visible');
        await expect.poll(() => visible.count()).toBe(1);
        await page.getByPlaceholder("Search types").fill("");
        await page.getByLabel("Set every type").selectOption({ index: 1 });
        const create = page.getByRole("button", { name: "Create key" });
        await expect
          .poll(() => create.getAttribute("aria-disabled"))
          .toBeNull();
        await create.click();
        await page
          .locator("#key-secret")
          .filter({ hasText: "marfa_k1_" })
          .waitFor();
        const rows = (
          (await (await ctx.ownerRequest("/keys")).json()) as {
            data: { label: string; type_permissions: Record<string, string> }[];
          }
        ).data;
        const made = rows.find((row) => row.label === "Types key");
        expect(
          Object.keys(made?.type_permissions ?? {}).filter((id) =>
            id.startsWith("browsertype."),
          ),
        ).toHaveLength(30);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "sends integration data that follows all data, and none when types are chosen or access is specific",
    async () => {
      const { page, context } = await open();
      try {
        const sent: Record<string, unknown>[] = [];
        page.on("request", (request) => {
          if (request.method() === "POST" && request.url() === `${origin}/keys`)
            sent.push(request.postDataJSON() as Record<string, unknown>);
        });
        const create = page.getByRole("button", { name: "Create key" });
        const extensions = page.getByLabel("Integration data");
        const dataLine = page.locator(
          "[data-access-group=data] [data-summary]",
        );

        // All data at a level: integration data starts at that level.
        await page.goto(`${origin}/auth/owner/keys/new`);
        await page.getByLabel("Name").fill("Follows all data");
        await openGroups(page);
        expect(await extensions.inputValue()).toBe("none");
        await page
          .getByLabel("All your data")
          .selectOption({ label: "Read and edit" });
        expect(await extensions.inputValue()).toBe("write");
        expect(await dataLine.textContent()).toMatch(/integration data/);
        await create.click();
        await page
          .locator("#key-secret")
          .filter({ hasText: "marfa_k1_" })
          .waitFor();
        expect(sent[0]?.extension_permissions).toEqual({ "*": "write" });

        // A choice of its own is kept when all data changes after it.
        await page.goto(`${origin}/auth/owner/keys/new`);
        await page.getByLabel("Name").fill("Own choice");
        await openGroups(page);
        await extensions.selectOption({ label: "Read only" });
        await page
          .getByLabel("All your data")
          .selectOption({ label: "Read and edit" });
        expect(await extensions.inputValue()).toBe("read");
        await create.click();
        await page
          .locator("#key-secret")
          .filter({ hasText: "marfa_k1_" })
          .waitFor();
        expect(sent[1]?.extension_permissions).toEqual({ "*": "read" });

        // Specific access: none, sent as an empty map so the key inherits nothing.
        await page.goto(`${origin}/auth/owner/keys/new`);
        await page.getByLabel("Name").fill("Specific access");
        await powers(page).click();
        await page.locator('input[value="instance.read"]').check();
        expect(await extensions.inputValue()).toBe("none");
        await create.click();
        await page
          .locator("#key-secret")
          .filter({ hasText: "marfa_k1_" })
          .waitFor();
        expect(sent[2]?.extension_permissions).toEqual({});

        const stored = (
          (await (await ctx.ownerRequest("/keys")).json()) as {
            data: {
              label: string;
              extension_permissions: Record<string, string>;
            }[];
          }
        ).data;
        const held = (label: string) =>
          stored.find((key) => key.label === label)?.extension_permissions;
        expect(held("Follows all data")).toEqual({ "*": "write" });
        expect(held("Own choice")).toEqual({ "*": "read" });
        expect(held("Specific access")).toEqual({});
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "can skip Marfa's write rules without holding the config.manage switch",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}/auth/owner/keys/new`);
        await page.getByLabel("Name").fill("Skips rules");
        await powers(page).click();
        await page.locator('input[value="instance.read"]').check();
        await page.getByLabel("Marfa's write rules").selectOption("skip");
        const create = page.getByRole("button", { name: "Create key" });
        expect(await create.getAttribute("aria-disabled")).toBeNull();
        expect(await page.locator("[data-reason]").textContent()).toBe("");
        await create.click();
        await page
          .locator("#key-secret")
          .filter({ hasText: "marfa_k1_" })
          .waitFor();
        const made = (
          (await (await ctx.ownerRequest("/keys")).json()) as {
            data: {
              label: string;
              permissions: string[];
              enforcement_override?: unknown;
            }[];
          }
        ).data.find((key) => key.label === "Skips rules");
        expect(made?.permissions).toEqual(["instance.read"]);
        expect(made?.enforcement_override).toBeTruthy();
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "takes the secret off the page when the person leaves it, and shows the gone page when the browser brings it back",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}/auth/owner/keys/new`);
        await page.getByLabel("Name").fill("Left behind");
        await powers(page).click();
        await page.locator('input[value="instance.read"]').check();
        await page.getByRole("button", { name: "Create key" }).click();
        const secret = page.locator("#key-secret");
        await secret.filter({ hasText: "marfa_k1_" }).waitFor();
        const shown = (await secret.textContent()) ?? "";

        // The page, as the browser would keep it when the person leaves.
        await page.evaluate(
          'window.dispatchEvent(new PageTransitionEvent("pagehide"))',
        );
        expect(await page.content()).not.toContain(shown);
        expect(await secret.textContent()).toBe("");

        // Witness: before leaving, the secret was on the page.
        expect(shown).toContain("marfa_k1_");

        // A real trip away and back never shows it.
        await page.goto(`${origin}/auth/owner/keys`);
        await page.goBack();
        await page
          .getByText(/can.t be shown again|no longer/i)
          .first()
          .waitFor();
        expect(await page.content()).not.toContain(shown);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "reloads a kept page into the gone page when the browser restores it",
    async () => {
      const { page, context } = await open();
      try {
        await page.goto(`${origin}/auth/owner/keys/new`);
        await page.getByLabel("Name").fill("Restored");
        await powers(page).click();
        await page.locator('input[value="instance.read"]').check();
        await page.getByRole("button", { name: "Create key" }).click();
        const secret = page.locator("#key-secret");
        await secret.filter({ hasText: "marfa_k1_" }).waitFor();
        const shown = (await secret.textContent()) ?? "";
        await page.evaluate(
          'window.dispatchEvent(new PageTransitionEvent("pagehide")); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))',
        );
        await page
          .getByText(/can.t be shown again|no longer/i)
          .first()
          .waitFor();
        expect(await page.content()).not.toContain(shown);
      } finally {
        await context.close();
      }
    },
  );
});

describe("A key", () => {
  inBrowser(
    "can be given less, shows what changed was saved, and cannot be given more",
    async () => {
      const { page, context, errors, violations } = await open();
      try {
        const id = await makeKey(context, "Narrowing key");
        await page.goto(`${origin}/auth/owner/keys/${id}`);
        const bar = page.locator("[data-save-bar]");
        const save = page.getByRole("button", { name: "Save", exact: true });
        await page.getByRole("button", { name: "Revoke" }).waitFor();
        expect(await bar.isVisible()).toBe(false);
        await powers(page).click();
        await page.locator('input[value="instance.read"]').uncheck();
        await save.waitFor();
        // Discard puts back what the page said.
        await page.getByRole("button", { name: "Discard" }).click();
        expect(
          await page.locator('input[value="instance.read"]').isChecked(),
        ).toBe(true);
        expect(await bar.isVisible()).toBe(false);

        await page.locator('input[value="instance.read"]').uncheck();
        await save.click();
        await page.getByText("Saved").waitFor();
        expect((await ctx.storage.keys.get(id))?.permissions).toEqual([]);
        expect((await ctx.storage.keys.get(id))?.type_permissions).toEqual({
          "core.note": "write",
        });
        expect(await bar.isVisible()).toBe(false);

        // A page opened before another change cannot lift what the key holds now.
        const stale = await context.newPage();
        await stale.goto(`${origin}/auth/owner/keys/${id}`);
        await openGroups(stale);
        await ctx.storage.keys.update(id, { type_permissions: {} });
        await stale
          .locator("select[name=scopes]")
          .first()
          .selectOption({ index: 1 });
        await stale.getByRole("button", { name: "Save", exact: true }).click();
        await stale
          .locator("[data-notice=problem]")
          .waitFor({ state: "visible" });
        expect((await ctx.storage.keys.get(id))?.type_permissions).toEqual({});
        expect(await violations()).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "keeps the revoke dialog open on Escape while the revoke is being sent",
    async () => {
      const { page, context } = await open();
      try {
        const id = await makeKey(context, "Held key");
        await page.goto(`${origin}/auth/owner/keys/${id}`);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route("**/keys/*", async (route) => {
          if (route.request().method() !== "DELETE") return route.continue();
          await held;
          await route.continue();
        });
        await page.getByRole("button", { name: "Revoke" }).click();
        const dialog = page.getByRole("dialog", { name: "Revoke Held key?" });
        await dialog.waitFor();
        await dialog.getByRole("button", { name: "Revoke" }).click();
        await dialog.locator('.card[aria-busy="true"]').waitFor();
        await page.keyboard.press("Escape");
        expect(await dialog.isVisible()).toBe(true);
        release();
        await page.waitForURL(`${origin}/auth/owner/keys`);
        expect(await ctx.storage.keys.get(id)).toBeNull();
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "says it was revoked when it is revoked under an open page, and revoking it again is not an error",
    async () => {
      const { page, context } = await open();
      try {
        const id = await makeKey(context, "Gone elsewhere");
        await page.goto(`${origin}/auth/owner/keys/${id}`);
        await powers(page).click();
        await page.locator('input[value="instance.read"]').uncheck();
        await ctx.storage.keys.revoke(id);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        const problem = page.locator("[data-notice=problem]");
        await problem.waitFor({ state: "visible" });
        expect(await problem.innerText()).toContain("revoked");

        await page.getByRole("button", { name: "Revoke" }).click();
        await page
          .getByRole("dialog", { name: "Revoke Gone elsewhere?" })
          .getByRole("button", { name: "Revoke" })
          .click();
        await page.waitForURL(`${origin}/auth/owner/keys`);
        await page.getByText("Revoked Gone elsewhere").waitFor();

        const missing = await page.goto(`${origin}/auth/owner/keys/${id}`);
        expect(missing?.status()).toBe(404);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "offers only ends no later than the key's own, and never lengthens it",
    async () => {
      const { page, context } = await open();
      try {
        const current = new Date(Date.now() + 100 * 86_400_000).toISOString();
        const id = await makeKey(context, "Ends in a while", {
          expires_at: current,
        });
        await page.goto(`${origin}/auth/owner/keys/${id}`);
        const ends = page.locator("#key-ends");
        const values = await optionValues(ends.locator("option"));
        expect(values).toEqual(["current", "30", "90"]);

        await ends.selectOption("90");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByText("Saved").waitFor();
        const saved = (await ctx.storage.keys.get(id))?.expires_at;
        expect(Date.parse(saved ?? "")).toBeLessThan(Date.parse(current));
        expect(Date.parse(saved ?? "")).toBeGreaterThan(
          Date.now() + 89 * 86_400_000,
        );

        // Witness: a key that never ends is offered every end, "Never" first.
        const open = await makeKey(context, "Never ends");
        await page.goto(`${origin}/auth/owner/keys/${open}`);
        expect(await optionValues(page.locator("#key-ends option"))).toEqual([
          "never",
          "30",
          "90",
          "365",
        ]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser("offers to choose only the types the key holds", async () => {
    const { page, context } = await open();
    try {
      const id = await makeKey(context, "Denied a type", {
        type_permissions: { "*": "read", "core.note": "none" },
      });
      await page.goto(`${origin}/auth/owner/keys/${id}`);
      await openGroups(page);
      await page
        .getByLabel("All your data")
        .selectOption({ label: "Choose types" });
      const values = await optionValues(
        page.locator('select[name="types"] option'),
      );
      expect(values.some((value) => value.startsWith("core.task:"))).toBe(true);
      expect(values.some((value) => value.startsWith("core.note:"))).toBe(
        false,
      );
    } finally {
      await context.close();
    }
  });

  inBrowser(
    "will not save over a key that changed after the page opened, and saves after a reload",
    async () => {
      const { page, context } = await open();
      try {
        const id = await makeKey(context, "Changed elsewhere");
        await page.goto(`${origin}/auth/owner/keys/${id}`);
        await powers(page).click();
        await page.locator('input[value="instance.read"]').uncheck();

        // Another window gives the key less.
        const patched = await context.request.patch(`${origin}/keys/${id}`, {
          headers: { origin },
          data: {
            narrow_only: true,
            type_permissions: { "core.note": "read" },
          },
        });
        expect(patched.status(), await patched.text()).toBe(200);

        await page.getByRole("button", { name: "Save", exact: true }).click();
        const problem = page.locator("[data-notice=problem]");
        await problem.waitFor({ state: "visible" });
        expect(await problem.innerText()).toContain(
          "This key changed after this page opened. Reload to see it.",
        );
        const held = await ctx.storage.keys.get(id);
        expect(held?.permissions).toEqual(["instance.read"]);
        expect(held?.type_permissions).toEqual({ "core.note": "read" });

        // Witness: after a reload the same change saves.
        await page.reload();
        await powers(page).click();
        await page.locator('input[value="instance.read"]').uncheck();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByText("Saved").waitFor();
        expect((await ctx.storage.keys.get(id))?.permissions).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );
});

const countOf = (page: Page) =>
  page.locator("[data-save-bar-count]").textContent();
const statusOf = (page: Page) =>
  page.locator("[data-save-bar-status]").textContent();

describe("the save bar on a key's page", () => {
  inBrowser(
    "appears on a change, counts each control, and hides when the form is back as it loaded",
    async () => {
      const { page, context, errors, violations } = await open();
      try {
        const id = await makeKey(context, "Counting key");
        await page.goto(`${origin}/auth/owner/keys/${id}`);
        const bar = page.locator("[data-save-bar]");
        await page.getByRole("button", { name: "Revoke" }).waitFor();
        // Witness for everything below: nothing has changed, so nothing shows.
        expect(await bar.isVisible()).toBe(false);
        expect(await page.locator("[data-hook=save-discard]").count()).toBe(1);
        expect(await statusOf(page)).toBe("");

        await powers(page).click();
        const read = page.locator('input[value="instance.read"]');
        await read.uncheck();
        await bar.waitFor();
        expect(await countOf(page)).toBe("1 change");
        expect(await statusOf(page)).toContain("1 change");
        // The bar appearing does not take the focus from where the person is.
        expect(
          await page.evaluate(
            () =>
              document
                .querySelector("[data-save-bar]")
                ?.contains(document.activeElement) ?? true,
          ),
        ).toBe(false);
        expect(
          await page.evaluate(
            () => document.activeElement?.getAttribute("value") ?? "",
          ),
        ).toBe("instance.read");

        await page.locator("#key-ends").selectOption("30");
        expect(await countOf(page)).toBe("2 changes");
        expect(await statusOf(page)).toContain("2 changes");

        // Putting one back counts one fewer; putting both back hides the bar.
        await page.locator("#key-ends").selectOption("never");
        expect(await countOf(page)).toBe("1 change");
        await read.check();
        await bar.waitFor({ state: "hidden" });
        expect(await statusOf(page)).toBe("");
        expect(await violations()).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "puts every control back on Discard, hides, and leaves the focus on a control",
    async () => {
      const { page, context } = await open();
      try {
        const id = await makeKey(context, "Discarded key");
        await page.goto(`${origin}/auth/owner/keys/${id}`);
        await powers(page).click();
        const read = page.locator('input[value="instance.read"]');
        await read.uncheck();
        await page.locator("#key-ends").selectOption("90");
        const bar = page.locator("[data-save-bar]");
        await bar.waitFor();
        expect(await countOf(page)).toBe("2 changes");

        await page.getByRole("button", { name: "Discard" }).click();
        await bar.waitFor({ state: "hidden" });
        expect(await read.isChecked()).toBe(true);
        expect(await page.locator("#key-ends").inputValue()).toBe("never");
        // The pressed button is gone, so the focus goes to the first thing that had changed.
        expect(await page.evaluate(() => document.activeElement?.id)).toBe(
          "key-ends",
        );
        // Witness: nothing was sent.
        expect((await ctx.storage.keys.get(id))?.permissions).toEqual([
          "instance.read",
        ]);
        // Changing again shows the bar again.
        await read.uncheck();
        await bar.waitFor();
        expect(await countOf(page)).toBe("1 change");
      } finally {
        await context.close();
      }
    },
  );

  inBrowser(
    "is reached by the keyboard after the controls and the revoke card, and saves with Enter",
    async () => {
      const { page, context } = await open();
      try {
        const id = await makeKey(context, "Keyboard saved key");
        await page.goto(`${origin}/auth/owner/keys/${id}`);
        await powers(page).click();
        const read = page.locator('input[value="instance.read"]');
        await read.focus();
        await page.keyboard.press("Space");
        await page.locator("[data-save-bar]").waitFor();
        // Pressing Space moved nothing: the focus is where the person was.
        expect(
          await page.evaluate(
            () => document.activeElement?.getAttribute("value") ?? "",
          ),
        ).toBe("instance.read");

        const seen: string[] = [];
        for (let step = 0; step < 80 && !seen.includes("Save"); step += 1) {
          await page.keyboard.press("Tab");
          const name = await page.evaluate(
            () => document.activeElement?.textContent.trim() ?? "",
          );
          if (name === "Revoke" || name === "Discard" || name === "Save")
            seen.push(name);
        }
        expect(seen).toEqual(["Revoke", "Discard", "Save"]);
        await page.keyboard.press("Enter");
        await page.getByText("Saved", { exact: true }).waitFor();
        expect((await ctx.storage.keys.get(id))?.permissions).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );
});

describe("the keys pages at a phone's width and in both colors", () => {
  inBrowser(
    "fit 375 px with no sideways scroll, in light and dark",
    async () => {
      for (const scheme of ["light", "dark"] as const) {
        const { page, context, errors } = await open({ scheme, width: 375 });
        try {
          const id = await makeKey(context, `Narrow ${scheme} key`);
          for (const path of [
            "/auth/owner/keys",
            "/auth/owner/keys/new",
            `/auth/owner/keys/${id}`,
          ]) {
            await page.goto(`${origin}${path}`);
            await page.locator("h1").first().waitFor();
            expect(
              await overflow(page),
              `${scheme} ${path}`,
            ).toBeLessThanOrEqual(0);
          }
          const background = await page.evaluate(
            () => getComputedStyle(document.body).backgroundColor,
          );
          const [red = 0, green = 0, blue = 0] = (
            background.match(/\d+/g) ?? []
          ).map(Number);
          const light = (red + green + blue) / 3 > 128;
          expect(light, scheme).toBe(scheme === "light");
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    },
  );
});
