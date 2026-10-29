import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createPageRegistry, HOME_GROUPS } from "../pages/registry.js";
import { pageForms, pageLinks, visibleText } from "../pages/reading.js";
import { HOSTILE } from "../pages/test-fixture.js";
import { createConsolePages } from "./console.js";
import { MAX_CONSOLE_RETURN_TO_LENGTH } from "./console-gate.js";
import {
  createTestContext,
  request,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";

const BROWSER = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await cleanupTestContext(ctx);
});

const asBrowser = (path: string, cookie?: string) =>
  ctx.app.request(path, {
    headers: { ...BROWSER, ...(cookie === undefined ? {} : { cookie }) },
  });

describe("a console page, asked for by a browser that is not signed in", () => {
  it("goes to sign in and says to come back to the same address, query included", async () => {
    for (const [path, returnTo] of [
      ["/auth/owner/keys", "/auth/owner/keys"],
      ["/auth/owner/keys?tab=keys&x=%20y", "/auth/owner/keys?tab=keys&x=%20y"],
      ["/auth/owner/passkeys", "/auth/owner/passkeys"],
      ["/auth/owner/profile", "/auth/owner/profile"],
    ] as const) {
      const res = await asBrowser(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe(
        `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`,
      );
      expect(res.headers.get("cache-control"), path).toContain("no-store");
    }
  });

  it("serves the owner's own pages to a signed-in owner, each under its heading", async () => {
    for (const [path, heading] of [
      ["/auth/owner/profile", "Profile"],
      ["/auth/owner/passkeys", "Password and passkeys"],
    ] as const) {
      const res = await asBrowser(path, ctx.owner.cookie);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expect(await res.text(), path).toMatch(
        new RegExp(`<h1 class="title">${heading}</h1>`),
      );
    }
  });

  it("never carries an address a browser would read as another host", async () => {
    const res = await asBrowser("/auth/owner/keys?next=//evil.example/x");
    const location = res.headers.get("location") ?? "";
    const returnTo = new URL(location, "http://localhost").searchParams.get(
      "return_to",
    );
    expect(returnTo).toBe("/auth/owner/keys?next=//evil.example/x");
    expect(new URL(returnTo ?? "", "http://localhost").host).toBe("localhost");
  });

  it("sends an address too long to carry to sign in with no way back, so it lands on Home", async () => {
    const room = MAX_CONSOLE_RETURN_TO_LENGTH - "/auth/owner/keys?x=".length;
    const fits = `/auth/owner/keys?x=${"a".repeat(room)}`;
    expect(fits).toHaveLength(MAX_CONSOLE_RETURN_TO_LENGTH);
    // Witness: the longest address that fits is carried whole.
    const carried = await asBrowser(fits);
    expect(carried.headers.get("location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent(fits)}`,
    );
    const res = await asBrowser(`${fits}a`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/sign-in?return_to=%2F");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("treats a HEAD for a page as the GET it stands for", async () => {
    const head = (headers: Record<string, string>) =>
      ctx.app.request("/auth/owner/keys?tab=keys", {
        method: "HEAD",
        headers,
      });
    const out = await head(BROWSER);
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent("/auth/owner/keys?tab=keys")}`,
    );
    expect(out.headers.get("cache-control")).toContain("no-store");
    // Witness: with the owner's session the same HEAD is the page's headers.
    const signedIn = await head({ ...BROWSER, cookie: ctx.owner.cookie });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    expect(await signedIn.text()).toBe("");
    // A program's HEAD keeps the refusal it always had.
    const program = await head({ accept: "application/json" });
    expect(program.status).toBe(401);
    expect(program.headers.get("location")).toBeNull();
  });

  it("is sent back to the page it asked for once it has signed in", async () => {
    const res = await request(ctx.app, "POST", "/auth/sign-in", {
      headers: { origin: "http://localhost:0" },
      form: {
        email: ctx.owner.email,
        password: ctx.owner.password,
        return_to: "/auth/owner/keys?x=1",
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/owner/keys?x=1");
  });

  it("lands on Home after signing in with nowhere to return to", async () => {
    const res = await request(ctx.app, "POST", "/auth/sign-in", {
      headers: { origin: "http://localhost:0" },
      form: { email: ctx.owner.email, password: ctx.owner.password },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("is sent to sign in again when its session ends while a page is open", async () => {
    const mine = await createTestContext();
    try {
      const open = await mine.app.request("/auth/owner/keys", {
        headers: { ...BROWSER, cookie: mine.owner.cookie },
      });
      expect(open.status).toBe(200);
      const out = await mine.app.request("/auth/sign-out", {
        method: "POST",
        headers: {
          cookie: mine.owner.cookie,
          origin: "http://localhost:0",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(out.status).toBe(200);
      const next = await mine.app.request("/auth/owner/keys", {
        headers: { ...BROWSER, cookie: mine.owner.cookie },
      });
      expect(next.status).toBe(302);
      expect(next.headers.get("location")).toBe(
        "/auth/sign-in?return_to=%2Fauth%2Fowner%2Fkeys",
      );
    } finally {
      await mine.cleanup();
    }
  });

  it("opens for the owner's session, with a policy that lets the page's script reach this server", async () => {
    const res = await asBrowser("/auth/owner/keys", ctx.owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
  });
});

describe("a console page, asked for by something that is not a browser", () => {
  it("keeps the answer it had: refused, as JSON, with no redirect", async () => {
    for (const headers of [
      {},
      { accept: "*/*" },
      { accept: "application/json" },
    ] as const) {
      const res = await ctx.app.request("/auth/owner/passkeys", { headers });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers.get("location")).toBeNull();
    }
    // Witness: the same address asked the browser's way is the redirect.
    expect((await asBrowser("/auth/owner/passkeys")).status).toBe(302);
  });

  it("keeps the answer it had for a bearer caller, even one that asks for HTML", async () => {
    const res = await ctx.app.request("/auth/owner/passkeys", {
      headers: { ...BROWSER, authorization: `Bearer ${ctx.workingKey}` },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not send an unclaimed Marfa's visitor to a sign-in that cannot work", async () => {
    const { createUnclaimedTestApp } = await import("../test-utils.js");
    const fresh = await createUnclaimedTestApp();
    try {
      const res = await fresh.app.request("/auth/owner/keys", {
        headers: BROWSER,
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/setup");
    } finally {
      await fresh.cleanup();
    }
  });
});

describe("Home at the root", () => {
  it("shows the owner's browser Home, and a signed-out browser the page it always had", async () => {
    const home = await asBrowser("/", ctx.owner.cookie);
    expect(home.status).toBe(200);
    expect(home.headers.get("vary")).toContain("Accept");
    expect(home.headers.get("cache-control")).toContain("no-store");
    expect(home.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    const text = visibleText(await home.text());
    expect(text).toContain("Export and restore");
    expect(text).toContain("Sign out");
    expect(text).not.toContain("Marfa is running");

    const out = await asBrowser("/");
    expect(out.status).toBe(200);
    expect(visibleText(await out.text())).toContain("Marfa is running");
  });

  it("shows a program the description, whatever session it carries", async () => {
    for (const headers of [
      {},
      { cookie: ctx.owner.cookie },
      { authorization: `Bearer ${ctx.workingKey}` },
    ] as const) {
      const res = await ctx.app.request("/", { headers });
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(((await res.json()) as { name: string }).name).toBe("Marfa");
    }
  });

  it("links the pages it lists and reaches them from Home", async () => {
    const html = await (await asBrowser("/", ctx.owner.cookie)).text();
    for (const path of ["/auth/owner/export", "/auth/owner/connectors"]) {
      expect(pageLinks(html).map((l) => l.href)).toContain(path);
      expect((await asBrowser(path, ctx.owner.cookie)).status, path).toBe(200);
    }
  });

  it("takes a search from the owner's browser and nobody else", async () => {
    const mine = await asBrowser("/?q=keys", ctx.owner.cookie);
    expect(mine.status).toBe(200);
    expect(visibleText(await mine.text())).toContain("Results for “keys”");
    const theirs = await asBrowser("/?q=keys");
    expect(theirs.status).toBe(400);
    const stray = await asBrowser("/?stray=1", ctx.owner.cookie);
    expect(stray.status).toBe(400);
    expect(stray.headers.get("vary")).toContain("Accept");
    const program = await ctx.app.request("/?q=keys", {
      headers: { cookie: ctx.owner.cookie },
    });
    expect(program.status).toBe(400);
  });

  it("holds up to a search that is empty, enormous or untidy", async () => {
    for (const q of [
      "",
      "%20%20",
      "a".repeat(5000),
      "%00%0a%09",
      "%ff",
      "<b>x</b>",
    ]) {
      const res = await asBrowser(`/?q=${q}`, ctx.owner.cookie);
      expect(res.status, q.slice(0, 20)).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("<b>x</b>");
      expect(pageForms(html).some((f) => f.method === "get")).toBe(true);
    }
  });

  it("names the instance as the owner set it, as text, and Marfa when it has no name", async () => {
    const named = await createTestContext();
    try {
      const before = visibleText(
        await (
          await named.app.request("/", {
            headers: { ...BROWSER, cookie: named.owner.cookie },
          })
        ).text(),
      );
      expect(before).toContain("Marfa");
      const saved = await named.ownerRequest("/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: HOSTILE }),
      });
      expect(saved.status).toBe(200);
      const html = await (
        await named.app.request("/", {
          headers: { ...BROWSER, cookie: named.owner.cookie },
        })
      ).text();
      expect(visibleText(html)).toContain(HOSTILE);
      expect(html).not.toContain(HOSTILE);
    } finally {
      await named.cleanup();
    }
  });

  it("still answers when a page throws at once", async () => {
    const pages = createConsolePages(createPageRegistry(HOME_GROUPS));
    pages.register("keys", {
      href: "/auth/owner/keys",
      value: () => {
        throw new Error("sync");
      },
    });
    pages.register("trash", {
      href: "/auth/owner/trash",
    });
    pages.register("apps", {
      href: "/auth/owner/apps",
      value: () => Promise.resolve({ text: "2 apps" }),
    });
    const mine = await createTestContext();
    try {
      const app = createApp(
        mine.storage,
        mine.blobs,
        mine.housekeeping,
        mine.config,
        "instance-id-for-home",
        { consolePages: pages },
      );
      const res = await app.request("/", {
        headers: { ...BROWSER, cookie: mine.owner.cookie },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      const text = visibleText(html);
      expect(text).toContain("2 apps");
      expect(text).toContain("Unknown");
      expect(text).toContain("Unknown");
      expect(html).not.toContain("evil.example");
    } finally {
      await mine.cleanup();
    }
  });

  it("lists the pages a console is given, with each page's value, and survives one that fails", async () => {
    const pages = createConsolePages(createPageRegistry(HOME_GROUPS));
    pages.register("keys", {
      href: "/auth/owner/keys",
      value: () => Promise.resolve({ text: "7 keys" }),
    });
    pages.register("trash", {
      href: "/auth/owner/trash",
      value: () => Promise.reject(new Error("down")),
    });
    const mine = await createTestContext();
    try {
      const app = createApp(
        mine.storage,
        mine.blobs,
        mine.housekeeping,
        mine.config,
        "instance-id-for-home",
        { consolePages: pages },
      );
      const res = await app.request("/", {
        headers: { ...BROWSER, cookie: mine.owner.cookie },
      });
      expect(res.status).toBe(200);
      const text = visibleText(await res.text());
      expect(text).toContain("API keys");
      expect(text).toContain("7 keys");
      expect(text).toContain("Unknown");
    } finally {
      await mine.cleanup();
    }
  });
});
