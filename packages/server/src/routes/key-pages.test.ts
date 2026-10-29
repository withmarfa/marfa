import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  pageButtons,
  pageFields,
  pageForms,
  pageLinks,
  pageRegions,
  visibleText,
} from "../pages/reading.js";
import { HOSTILE, LONG_UNBROKEN } from "../pages/test-fixture.js";
import { hashApiKey } from "../middleware/auth.js";
import {
  createTestContext,
  mintWorkingKey,
  TEST_CONTENT_PERMISSIONS,
  TEST_API_KEY_SALT,
  cleanupTestContext,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { StoredApiKey } from "../storage/interface.js";
import { keyFingerprint } from "../pages/key-body.js";

let ctx: TestContext;
let counter = 0;

beforeAll(async () => {
  ctx = await createTestContext({});
});

afterAll(async () => {
  await cleanupTestContext(ctx);
});

const DAY = 86_400_000;

async function seed(
  label: string,
  overrides: Partial<Parameters<typeof ctx.storage.keys.create>[0]> = {},
): Promise<StoredApiKey> {
  counter += 1;
  return ctx.storage.keys.create(
    {
      label,
      source: `key-pages-${String(counter)}`,
      permissions: [],
      type_permissions: { "core.note": "read" },
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
      default_tier: "library",
      ...overrides,
    },
    hashApiKey(`marfa_k1_page_${String(counter)}`, TEST_API_KEY_SALT),
  );
}

async function page(path: string): Promise<{ status: number; html: string }> {
  const res = await ctx.ownerRequest(path, {
    headers: { accept: "text/html" },
  });
  return { status: res.status, html: await res.text() };
}

async function clearKeys(): Promise<void> {
  for (const key of await ctx.storage.keys.list()) {
    await ctx.storage.keys.revoke(key.id);
  }
}

/** The labels of the keys a list page shows, in order. */
function rowsOf(html: string): string[] {
  return pageLinks(html)
    .filter((link) => /^\/auth\/owner\/keys\/[^/]+$/.test(link.href))
    .filter((link) => link.href !== "/auth/owner/keys/new")
    .map((link) => link.text);
}

describe("the API keys list", () => {
  it("says there are none, and offers neither search nor tabs, until there is a key", async () => {
    await clearKeys();
    const none = (await page("/auth/owner/keys")).html;
    expect(visibleText(none)).toContain("No keys yet");
    expect(pageFields(none).find((f) => f.name === "q")).toBeUndefined();
    expect(visibleText(none)).not.toContain("Made by apps");
    expect(pageLinks(none)).toContainEqual({
      href: "/auth/owner/keys/new",
      text: "Create key",
    });
    // Witness: with a key the same page has what it left out.
    await seed("backup");
    const one = (await page("/auth/owner/keys")).html;
    expect(pageFields(one).find((f) => f.name === "q")).toBeDefined();
    expect(visibleText(one)).toContain("Made by apps");
    expect(visibleText(one)).not.toContain("No keys yet");
  });

  it("lists a key with what it can do, when it ends and when it was last used, linking to its page", async () => {
    await clearKeys();
    const key = await seed("backup");
    const { status, html } = await page("/auth/owner/keys");
    expect(status).toBe(200);
    const link = pageLinks(html).find(
      (l) => l.href === `/auth/owner/keys/${key.id}`,
    );
    expect(link?.text).toContain("backup");
    expect(link?.text).toContain("Never ends");
    expect(link?.text).toContain("Never used");
  });

  it("pages ten at a time, newest first, and clamps a page beyond the end", async () => {
    await clearKeys();
    for (let n = 1; n <= 11; n += 1) {
      await seed(`script ${String(n).padStart(2, "0")}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const first = (await page("/auth/owner/keys")).html;
    expect(rowsOf(first)).toHaveLength(10);
    expect(rowsOf(first)[0]).toContain("script 11");
    expect(visibleText(first)).toContain("1–10 of 11");
    const second = (await page("/auth/owner/keys?page=2")).html;
    expect(rowsOf(second)).toHaveLength(1);
    expect(rowsOf(second)[0]).toContain("script 01");
    const beyond = await page("/auth/owner/keys?page=99");
    expect(beyond.status).toBe(200);
    expect(rowsOf(beyond.html)).toHaveLength(1);
    const wide = (await page("/auth/owner/keys?size=25")).html;
    expect(rowsOf(wide)).toHaveLength(11);
  });

  it("searches the names, and says so when nothing matches", async () => {
    await clearKeys();
    await seed("nightly backup");
    await seed("deploy bot");
    const found = (await page("/auth/owner/keys?q=BACK")).html;
    expect(rowsOf(found)).toHaveLength(1);
    expect(rowsOf(found)[0]).toContain("nightly backup");
    expect(pageFields(found).find((f) => f.name === "q")?.value).toBe("BACK");
    const none = (await page("/auth/owner/keys?q=zzz")).html;
    expect(rowsOf(none)).toEqual([]);
    expect(visibleText(none)).toContain("No keys match");
  });

  it("keeps the keys apps made on their own tab, naming the app or saying it is gone", async () => {
    await clearKeys();
    await seed("mine");
    await seed("from an app", { oauth_client_id: "client-not-registered" });
    const yours = (await page("/auth/owner/keys")).html;
    expect(rowsOf(yours).map((row) => row.includes("from an app"))).toEqual([
      false,
    ]);
    const apps = (await page("/auth/owner/keys?tab=apps")).html;
    expect(rowsOf(apps)).toHaveLength(1);
    expect(rowsOf(apps)[0]).toContain("from an app");
    expect(rowsOf(apps)[0]).toContain("Made by an app");
    const none = (await page("/auth/owner/keys?tab=apps&q=mine")).html;
    expect(visibleText(none)).toContain("No keys match");
  });

  it("writes a name made of markup, emoji or one long word as text, and keeps it whole", async () => {
    await clearKeys();
    const hostile = await seed(HOSTILE);
    await seed("🔑 deploy 🚀");
    await seed(LONG_UNBROKEN);
    for (const path of ["/auth/owner/keys", `/auth/owner/keys/${hostile.id}`]) {
      const { html } = await page(path);
      expect(html, path).not.toContain("<script>window.__injected");
      expect(html, path).not.toContain("<b>bold</b>");
      expect(visibleText(html), path).toContain(HOSTILE);
    }
    const list = visibleText((await page("/auth/owner/keys")).html);
    expect(list).toContain("🔑 deploy 🚀");
    expect(list).toContain(LONG_UNBROKEN);
  });

  it("refuses a query key it does not know", async () => {
    const res = await ctx.ownerRequest("/auth/owner/keys?surprise=1");
    expect(res.status).toBe(400);
  });
});

describe("Home, for the keys", () => {
  it("counts them, and says which end within the week and when", async () => {
    await clearKeys();
    const none = visibleText((await page("/")).html);
    expect(none).toMatch(/Let scripts and tools use Marfa None/);
    await seed("steady");
    // Noon UTC three calendar days on: the page counts UTC calendar days,
    // so a time an hour past three days crosses into the fourth after 23:00.
    const today = Math.floor(Date.now() / DAY) * DAY;
    await seed("backup", {
      expires_at: new Date(today + 3 * DAY + DAY / 2).toISOString(),
    });
    await seed("far away", {
      expires_at: new Date(Date.now() + 40 * DAY).toISOString(),
    });
    const home = visibleText((await page("/")).html);
    expect(home).toContain("Let scripts and tools use Marfa 3 keys");
    expect(home).toContain("Key backup ends in 3 days");
    expect(home).toContain("Scripts using it will stop working");
    expect(home).not.toContain("Key far away ends");
    expect(home).not.toContain("Key steady ends");
  });
});

describe("a key's own page", () => {
  it("shows what it writes as, when it was made and last used, and starts every control where the key stands", async () => {
    await clearKeys();
    const key = await seed("backup", {
      type_permissions: { "core.note": "write" },
      permissions: ["instance.read"],
    });
    await ctx.storage.keys.updateLastUsed(
      key.id,
      new Date(Date.now() - 3 * 3_600_000).toISOString(),
    );
    const { status, html } = await page(`/auth/owner/keys/${key.id}`);
    expect(status).toBe(200);
    const text = visibleText(html);
    expect(text).toContain("Source");
    expect(text).toContain(key.source);
    expect(text).toContain("Created Just now");
    expect(text).toContain("Last used 3 hours ago");
    expect(html).toMatch(/<option[^>]*value="core.note:write"[^>]*selected/);
    const switchOn = (literal: string) =>
      new RegExp(`<input[^>]*value="${literal}"[^>]*checked`).test(html);
    expect(switchOn("instance.read")).toBe(true);
    // A key can be given less, never more: what it lacks is not offered.
    expect(html).not.toContain('value="keys.mint"');
    // Witness: the page for making a key offers it.
    expect((await page("/auth/owner/keys/new")).html).toContain(
      'value="keys.mint"',
    );
    const form = pageForms(html).find((f) => f.action?.endsWith(key.id));
    expect(form).toBeDefined();
  });

  it("shows Save and Discard only in a bar that starts hidden, and Revoke in a card of its own behind a question", async () => {
    await clearKeys();
    const key = await seed("backup");
    const { html } = await page(`/auth/owner/keys/${key.id}`);
    expect(
      pageRegions(html).find((region) => region.label === "Unsaved changes"),
    ).toMatchObject({ label: "Unsaved changes", hidden: true });
    const buttons = pageButtons(html);
    expect(buttons.map((button) => button.text)).toEqual(
      expect.arrayContaining(["Revoke", "Discard", "Save"]),
    );
    // The form it saves has the id the Save button names, and nothing says "Nothing has changed".
    expect(pageForms(html).length).toBeGreaterThan(0);
    expect(buttons.find((button) => button.text === "Save")?.form).toBe(
      "key-form",
    );
    expect(html).toContain('id="key-form"');
    expect(visibleText(html)).not.toContain("Nothing has changed");
    // Keyboard order follows the page: Revoke, then Discard, then Save.
    const order = buttons
      .map((button) => button.text)
      .filter((text) => ["Revoke", "Discard", "Save"].includes(text));
    // (The dialog's own Revoke button follows them.)
    expect(order.slice(0, 3)).toEqual(["Revoke", "Discard", "Save"]);
    expect(visibleText(html)).toContain("Revoke backup?");
    expect(visibleText(html)).toContain("This can't be undone");
  });

  it("says a key an app made can be given less, and names the app that is gone", async () => {
    await clearKeys();
    const key = await seed("from an app", {
      oauth_client_id: "client-not-registered",
    });
    const text = visibleText((await page(`/auth/owner/keys/${key.id}`)).html);
    expect(text).toContain("You can give it less access, not more.");
    expect(text).toContain("Made by An app that is no longer connected");
  });

  it("says in words what the key is denied beside a wider grant, and keeps it for the save", async () => {
    await clearKeys();
    const key = await seed("wide", {
      type_permissions: { "*": "read", "core.note": "none" },
    });
    const { html } = await page(`/auth/owner/keys/${key.id}`);
    expect(visibleText(html)).toMatch(/No access to Note/);
    expect(html).toContain("data-keep=");
    expect(html).toContain("core.note");
  });

  it("offers an end no later than the key's own, and never offers never to a key that ends", async () => {
    await clearKeys();
    const ends = await seed("ends", {
      expires_at: new Date(Date.now() + 100 * DAY).toISOString(),
    });
    const options = (html: string): string[] =>
      [
        ...(
          /<select[^>]*id="key-ends"[\s\S]*?<\/select>/.exec(html)?.[0] ?? ""
        ).matchAll(/<option[^>]*value="([^"]*)"/g),
      ].map((match) => match[1] ?? "");
    expect(options((await page(`/auth/owner/keys/${ends.id}`)).html)).toEqual([
      "current",
      "30",
      "90",
    ]);
    // Witness: a key that never ends is offered every end.
    const open = await seed("open");
    expect(options((await page(`/auth/owner/keys/${open.id}`)).html)).toEqual([
      "never",
      "30",
      "90",
      "365",
    ]);
  });

  it("carries what it loaded, so a save can tell the key changed", async () => {
    await clearKeys();
    const key = await seed("loaded", { permissions: ["instance.read"] });
    const { html } = await page(`/auth/owner/keys/${key.id}`);
    const loaded = /data-loaded="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(loaded.replaceAll("&quot;", '"')).toBe(keyFingerprint(key));
  });

  it("offers to choose only the types the key holds", async () => {
    await clearKeys();
    const key = await seed("denied a type", {
      type_permissions: { "*": "read", "core.note": "none" },
    });
    const { html } = await page(`/auth/owner/keys/${key.id}`);
    // Witness: a type the key holds is offered, and the one it is denied is not.
    expect(html).toContain('value="core.task:read"');
    expect(html).not.toContain('value="core.note:read"');
    const narrow = await seed("holds one type", {
      type_permissions: { "core.task": "read" },
    });
    const only = (await page(`/auth/owner/keys/${narrow.id}`)).html;
    expect(only).not.toContain("choose-types");
    expect(only).not.toContain('name="types"');
  });

  it("names integration data on every namespace as all of it, not as a pattern", async () => {
    await clearKeys();
    const key = await seed("integrations", {
      extension_permissions: { "*": "write" },
    });
    const text = visibleText((await page(`/auth/owner/keys/${key.id}`)).html);
    expect(text).toContain("Integration data All");
    expect(text).not.toMatch(/Integration data \*/);
    // Witness: a named namespace is shown by its name.
    const named = await seed("one integration", {
      extension_permissions: { "app.cursor": "write" },
    });
    expect(
      visibleText((await page(`/auth/owner/keys/${named.id}`)).html),
    ).toContain("Integration data app.cursor");
  });

  it("says it holds nothing for a key with no access", async () => {
    await clearKeys();
    const key = await seed("empty", { type_permissions: {} });
    const text = visibleText((await page(`/auth/owner/keys/${key.id}`)).html);
    expect(text).toContain("This key can't read or change anything.");
  });

  it("is not there for a key that was revoked, has ended or never was", async () => {
    await clearKeys();
    const revoked = await seed("revoked");
    await ctx.storage.keys.revoke(revoked.id);
    const ended = await seed("ended", {
      expires_at: new Date(Date.now() + 40).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    for (const id of [
      revoked.id,
      ended.id,
      "019537a0-7b80-7000-8000-000000000000",
    ]) {
      const res = await page(`/auth/owner/keys/${id}`);
      expect(res.status, id).toBe(404);
      expect(visibleText(res.html), id).toContain("This key isn't here");
    }
    // Witness: a live key's page is the page.
    const live = await seed("live");
    expect((await page(`/auth/owner/keys/${live.id}`)).status).toBe(200);
  });
});

describe("Create key", () => {
  it("starts with nothing on, the button waiting for a name, and the secret's place hidden", async () => {
    const { status, html } = await page("/auth/owner/keys/new");
    expect(status).toBe(200);
    expect(pageFields(html).find((f) => f.name === "label")).toBeDefined();
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(html).not.toMatch(/<option[^>]*value="[^"]*:[^"]*"[^>]*selected/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>\s*Create key/);
    expect(visibleText(html)).toContain("Give the key a name");
    expect(html).toMatch(/<section[^>]*data-key-copy[^>]*hidden/);
    for (const permission of ["instance.read", "keys.mint", "config.manage"])
      expect(html, permission).toContain(`value="${permission}"`);
  });

  it("offers integration data under Advanced, starting at none, and says nothing of config.manage for the write rules", async () => {
    const { html } = await page("/auth/owner/keys/new");
    const select = /<select[^>]*name="extensions"[\s\S]*?<\/select>/.exec(
      html,
    )?.[0];
    expect(select).toBeDefined();
    expect(
      [...(select ?? "").matchAll(/<option([^>]*)>([^<]*)</g)].map((match) => [
        /value="([^"]*)"/.exec(match[1] ?? "")?.[1],
        match[2],
        (match[1] ?? "").includes("selected"),
      ]),
    ).toEqual([
      ["none", "No access", true],
      ["read", "Read only", false],
      ["write", "Read and edit", false],
    ]);
    expect(select).toContain('data-ext-noun="integration data"');
    expect(html.indexOf('name="extensions"')).toBeGreaterThan(
      html.indexOf('id="advanced"'),
    );
    expect(visibleText(html)).not.toContain("Skipping them needs");
    expect(html).not.toContain("data-reason-rules");
  });

  it("offers every item type to choose, however many there are", async () => {
    const schemaKey = await mintWorkingKey(ctx, {
      permissions: [...TEST_CONTENT_PERMISSIONS, "schema.write"],
    });
    for (let n = 1; n <= 30; n += 1) {
      const made = await ctx.app.request("/types", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${schemaKey}`,
        },
        body: JSON.stringify({
          id: `keytype.t${String(n).padStart(2, "0")}`,
          fields: { title: { type: "string" } },
        }),
      });
      expect(made.status).toBe(201);
    }
    const { html } = await page("/auth/owner/keys/new");
    const types = pageFields(html).filter((f) => f.name === "types");
    expect(types.length).toBeGreaterThanOrEqual(30);
    expect(visibleText(html)).toContain("Set every type");
  });
});

describe("where a new key's secret was shown", () => {
  it("can only say it cannot be shown again, and never holds a secret", async () => {
    await clearKeys();
    const made = await ctx.ownerRequest("/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "fresh",
        source: "fresh-source",
        permissions: ["instance.read"],
      }),
    });
    expect(made.status).toBe(201);
    const body = (await made.json()) as { id: string; key: string };
    const { status, html } = await page(`/auth/owner/keys/${body.id}/copy`);
    expect(status).toBe(200);
    expect(visibleText(html)).toContain("This key can't be shown again");
    expect(html).not.toContain(body.key);
    expect(pageLinks(html)).toContainEqual({
      href: `/auth/owner/keys/${body.id}`,
      text: "Go to the key",
    });
    const gone = await page("/auth/owner/keys/missing/copy");
    expect(gone.status).toBe(200);
    expect(pageLinks(gone.html)).toContainEqual({
      href: "/auth/owner/keys",
      text: "Go to API keys",
    });
  });
});

describe("who may open the key pages", () => {
  it("is the owner alone: a key, even one that manages keys, is refused", async () => {
    const manager = await mintWorkingKey(ctx, {
      permissions: ["keys.manage"],
    });
    const res = await ctx.app.request("/auth/owner/keys", {
      headers: { authorization: `Bearer ${manager}` },
    });
    expect(res.status).toBe(403);
    const anon = await ctx.app.request("/auth/owner/keys", {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toContain("/auth/sign-in");
  });
});
