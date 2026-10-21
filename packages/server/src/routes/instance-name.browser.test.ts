import { expect, it } from "vitest";
import { createTestContext } from "../test-utils.js";
import { launchTestBrowser, listen, reserveOrigin } from "../test-browser.js";

it("shows changed names on later browser requests without creating HTML from the name", async () => {
  const browser = await launchTestBrowser();
  if (browser instanceof Error) throw browser;
  const { origin, port } = await reserveOrigin();
  const ctx = await createTestContext({ authBaseUrl: origin });
  const server = listen(ctx.app, port);
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(origin);
    expect(await page.locator("h1").textContent()).toBe("Marfa is running");
    const name = '<img src=x onerror="throw 1"> & Library';
    const update = await context.request.put(`${origin}/config`, {
      headers: { Authorization: `Bearer ${ctx.workingKey}` },
      data: { name },
    });
    expect(update.status()).toBe(200);
    await page.reload();
    expect(await page.locator("h1").textContent()).toBe(`${name} is running`);
    expect(await page.title()).toBe(name);
    expect(await page.locator("img").count()).toBe(0);
    await page.goto(`${origin}/auth/sign-in`);
    expect(await page.locator("h1").textContent()).toBe(`Sign in to ${name}`);
    await context.request.put(`${origin}/config`, {
      headers: { Authorization: `Bearer ${ctx.workingKey}` },
      data: {},
    });
    await page.reload();
    expect(await page.locator("h1").textContent()).toBe("Sign in to Marfa");
    expect(
      (
        await context.request.put(`${origin}/config`, {
          headers: { Authorization: `Bearer ${ctx.workingKey}` },
          data: { name },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await context.request.post(`${origin}/auth/sign-in/email`, {
          headers: { origin },
          data: { email: ctx.owner.email, password: ctx.owner.password },
        })
      ).status(),
    ).toBe(200);
    await page.goto(origin);
    expect(await page.locator("h1").textContent()).toBe(name);
    expect(await page.title()).toBe(name);
    await page.goto(`${origin}/auth/owner/export`);
    expect(await page.locator("h1").textContent()).toBe("Export and restore");
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("link", { name })
      .waitFor();
    expect(await page.locator("img").count()).toBe(0);
    await page.goto(`${origin}/auth/owner/passkeys`);
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("link", { name })
      .waitFor();
    expect(await page.locator("img").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
    await server.close();
    await ctx.cleanup();
  }
});
