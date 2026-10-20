/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import {
  pageFields,
  pageForms,
  pageLinks,
  visibleText,
} from "../pages/reading.js";
import { createPageRegistry, HOME_GROUPS } from "../pages/registry.js";
import { HOSTILE, LONG_UNBROKEN } from "../pages/test-fixture.js";
import { createConsolePages } from "./console.js";
import type { ConsoleReads } from "./console.js";
import {
  homeSearchQuery,
  MAX_HOME_SEARCH,
  renderHomePage,
} from "./home-page.js";

const reads = {} as ConsoleReads;

/** A Home with the pages a test chooses built, and nothing else. */
async function home(
  built: Record<
    string,
    {
      value?: { text: string; tone?: "warn" | "danger" };
      attention?: { title: string; href: string; description?: string }[];
    }
  > = {},
  options: { instanceName?: string; query?: string } = {},
): Promise<string> {
  const pages = createConsolePages(createPageRegistry(HOME_GROUPS));
  for (const [id, page] of Object.entries(built))
    pages.register(id, {
      href: `/auth/owner/${id}`,
      settings:
        id === "settings"
          ? [
              {
                id: "trash_days",
                title: "Keep items in the trash",
                group: "Keeping things",
                href: "/auth/owner/settings#trash",
              },
            ]
          : [],
      value: page.value ? () => Promise.resolve(page.value) : undefined,
      attention: page.attention
        ? () => Promise.resolve(page.attention ?? [])
        : undefined,
    });
  return renderHomePage({
    nonce: "abc123",
    instanceName: options.instanceName ?? "Marfa",
    address: "marfa.example.net",
    registry: pages.registry,
    reading: await pages.read(reads),
    query: options.query,
  });
}

describe("Home", () => {
  it("names the instance and where it is reached, and offers sign out only to a script", async () => {
    const out = await home({}, { instanceName: "August's Marfa" });
    expect(out).toContain("<title>August&#39;s Marfa</title>");
    expect(out).toMatch(/<h1 class="title">August&#39;s Marfa<\/h1>/);
    expect(visibleText(out)).toContain("marfa.example.net");
    const button = /<button[^>]*data-sign-out[^>]*>/.exec(out)?.[0] ?? "";
    expect(button).toContain("hidden");
    expect(visibleText(out)).toContain("Sign out");
  });

  it("starts with the instance's name as its one crumb, the page it is", async () => {
    const out = await home({}, { instanceName: "August's Marfa" });
    expect(out).toMatch(
      /<nav class="crumbs"[\s\S]*<span class="here" aria-current="page">August&#39;s Marfa<\/span>/,
    );
    expect(out).not.toContain("data-picker-button");
  });

  it("shows only the pages that are built, grouped as the registry groups them", async () => {
    const out = await home({
      keys: {},
      trash: { value: { text: "Empty" } },
    });
    const links = pageLinks(out).map((l) => l.href);
    expect(links).toContain("/auth/owner/keys");
    expect(links).toContain("/auth/owner/trash");
    expect(links).not.toContain("/auth/owner/apps");
    const text = visibleText(out);
    expect(text).toContain("Access");
    expect(text).toContain("Your data");
    expect(text).not.toContain("Connections");
    expect(text).not.toContain("Connected apps");
    // Witness that the check can fail: the same page, once built, shows.
    expect(visibleText(await home({ apps: {} }))).toContain("Connected apps");
  });

  it("shows each page's own value, in the tone the page chose", async () => {
    const out = await home({
      keys: { value: { text: "3 keys" } },
      connectors: { value: { text: "2 need a look", tone: "danger" } },
      folders: { value: { text: "3 problems", tone: "warn" } },
    });
    expect(out).toContain('<span class="val">3 keys</span>');
    expect(out).toContain('<span class="val danger">2 need a look</span>');
    expect(out).toContain('<span class="val warn">3 problems</span>');
  });

  it("lists what needs attention above the groups, and the section only when something does", async () => {
    const quiet = await home({ keys: {} });
    expect(visibleText(quiet)).not.toContain("Needs attention");
    const out = await home({
      keys: {
        attention: [
          {
            title: "Key home-dashboard ends in 3 days",
            description: "Scripts using it will stop working",
            href: "/auth/owner/keys",
          },
        ],
      },
    });
    const text = visibleText(out);
    expect(text).toContain("Needs attention");
    expect(out.indexOf('id="attention"')).toBeLessThan(
      out.indexOf('id="access"'),
    );
    expect(text).toContain("Key home-dashboard ends in 3 days");
    expect(out).toContain('class="dot warn"');
  });

  it("puts the older management page in This Marfa, and keeps it out of what the picker and search list", async () => {
    const without = await home({ keys: {} });
    expect(visibleText(without)).toContain("This Marfa");
    expect(pageLinks(without)).toContainEqual({
      href: "/auth/owner/manage",
      text: expect.stringContaining("Older management page") as string,
    });
    // After Connections and before You, wherever a built page puts them.
    const full = visibleText(
      await home({ keys: {}, connectors: {}, general: {}, profile: {} }),
    );
    expect(full.indexOf("Connections")).toBeLessThan(
      full.indexOf("This Marfa"),
    );
    expect(full.indexOf("General")).toBeLessThan(
      full.indexOf("Older management page"),
    );
    expect(full.indexOf("Older management page")).toBeLessThan(
      full.indexOf("You Profile"),
    );
    // Not a registered page, so the search dialog does not list it.
    const dialog = /<dialog[\s\S]*?<\/dialog>/.exec(without)?.[0] ?? "";
    expect(dialog).toContain("cs-page-keys");
    expect(dialog).not.toContain("/auth/owner/manage");
  });

  it("has a search that is a GET form to Home, and a button that opens the search everywhere", async () => {
    const out = await home();
    const form = pageForms(out).find((f) => f.method === "get");
    expect(form?.action).toBe("/");
    expect(pageFields(out).find((f) => f.name === "q")).toMatchObject({
      type: "search",
    });
    expect(out).toMatch(/<button[^>]*data-command-search-open[^>]*hidden/);
    expect(out).toContain("data-command-search");
  });

  it("answers a search with pages first, then settings, each with where it lives", async () => {
    const out = await home(
      {
        settings: { value: { text: "113" } },
        health: { value: { text: "Needs a look", tone: "warn" } },
      },
      { query: "health" },
    );
    const text = visibleText(out);
    expect(text).toContain("Results for “health”");
    expect(text).toContain("Health");
    expect(text).toContain("Needs a look");
    expect(text).not.toContain("Needs attention");
    expect(text).not.toContain("API keys");
    const settings = visibleText(
      await home({ settings: {} }, { query: "trash" }),
    );
    expect(settings).toContain("Keep items in the trash");
    expect(settings).toContain("All settings. Keeping things");
  });

  it("says so when a search finds nothing, and points at All settings", async () => {
    const text = visibleText(await home({ keys: {} }, { query: "zzzz" }));
    expect(text).toContain("No results");
    expect(text).toContain("Try another word, or look in All settings.");
  });

  it("shows hostile and very long text as text, in the name and in a search", async () => {
    const out = await home(
      {},
      {
        instanceName: HOSTILE,
        query: `${LONG_UNBROKEN}<img src=x onerror=alert(1)>`,
      },
    );
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script>alert");
    expect(visibleText(out)).toContain(HOSTILE);
    expect(pageFields(out).find((f) => f.name === "q")?.value).toContain(
      "<img",
    );
    const long = await home({}, { instanceName: LONG_UNBROKEN });
    expect(visibleText(long)).toContain(LONG_UNBROKEN);
  });

  it("is a page of its own scripts' nonce and nothing inline", async () => {
    const out = await home();
    expect(out).toMatch(/<script src="[^"]+pages\.js[^"]*" nonce="abc123"/);
    expect(out).not.toMatch(/\sstyle=|\sonclick=/);
  });
});

describe("what Home takes as a search", () => {
  it("trims it, and cuts one that is too long, by character", () => {
    expect(homeSearchQuery("  keys  ")).toBe("keys");
    expect(homeSearchQuery(undefined)).toBe("");
    expect(homeSearchQuery("   ")).toBe("");
    const long = "é".repeat(MAX_HOME_SEARCH + 50);
    expect(Array.from(homeSearchQuery(long))).toHaveLength(MAX_HOME_SEARCH);
    expect(homeSearchQuery("😀".repeat(MAX_HOME_SEARCH + 5))).toBe(
      "😀".repeat(MAX_HOME_SEARCH),
    );
  });
});
