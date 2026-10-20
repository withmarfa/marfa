/**
 * The API keys pages in a real browser against a real listener under the real
 * policy: making a key and seeing its secret once, narrowing and revoking one,
 * the keyboard alone, a phone's width, light and dark, two keys asking for the
 * same source, a key revoked under an open page, and a long list of item types.
 */
import type { Browser, BrowserContext, Page } from "playwright-core";
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
  await ctx.cleanup();
});

let nextAddress = 1;

interface Opened {
  page: Page;
  context: BrowserContext;
  errors: string[];
  violations: () => Promise<string[]>;
}

async function open(
  options: { scheme?: "light" | "dark"; width?: number } = {},
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
});

describe("A key", () => {
  inBrowser(
    "can be given less, shows what changed was saved, and cannot be given more",
    async () => {
      const { page, context, errors, violations } = await open();
      try {
        const id = await makeKey(context, "Narrowing key");
        await page.goto(`${origin}/auth/owner/keys/${id}`);
        const save = page.getByRole("button", { name: "Save changes" });
        await save.waitFor();
        expect(await save.getAttribute("aria-disabled")).toBe("true");
        await powers(page).click();
        await page.locator('input[value="instance.read"]').uncheck();
        expect(await save.getAttribute("aria-disabled")).toBeNull();
        // Discard puts back what the page said.
        await page.getByRole("button", { name: "Discard" }).click();
        expect(
          await page.locator('input[value="instance.read"]').isChecked(),
        ).toBe(true);
        expect(await save.getAttribute("aria-disabled")).toBe("true");

        await page.locator('input[value="instance.read"]').uncheck();
        await save.click();
        await page.getByText("Saved").waitFor();
        expect((await ctx.storage.keys.get(id))?.permissions).toEqual([]);
        expect((await ctx.storage.keys.get(id))?.type_permissions).toEqual({
          "core.note": "write",
        });

        // A page opened before another change cannot lift what the key holds now.
        const stale = await context.newPage();
        await stale.goto(`${origin}/auth/owner/keys/${id}`);
        await openGroups(stale);
        await ctx.storage.keys.update(id, { type_permissions: {} });
        await stale
          .locator("select[name=scopes]")
          .first()
          .selectOption({ index: 1 });
        await stale.getByRole("button", { name: "Save changes" }).click();
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
    "says it was revoked when it is revoked under an open page, and revoking it again is not an error",
    async () => {
      const { page, context } = await open();
      try {
        const id = await makeKey(context, "Gone elsewhere");
        await page.goto(`${origin}/auth/owner/keys/${id}`);
        await powers(page).click();
        await page.locator('input[value="instance.read"]').uncheck();
        await ctx.storage.keys.revoke(id);
        await page.getByRole("button", { name: "Save changes" }).click();
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
