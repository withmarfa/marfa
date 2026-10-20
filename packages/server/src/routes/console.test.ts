import { describe, expect, it } from "vitest";
import { createPageRegistry } from "../pages/registry.js";
import type { GroupDefinition } from "../pages/registry.js";
import { CONSOLE_PAGES, createConsolePages } from "./console.js";
import type { ConsoleReads } from "./console.js";
import { PAGE_REGISTRY } from "../pages/registry.js";

const GROUPS: readonly GroupDefinition[] = [
  {
    id: "access",
    title: "Access",
    pages: [
      { id: "keys", title: "API keys", description: "Let scripts use Marfa" },
      { id: "apps", title: "Connected apps", description: "Apps you approved" },
    ],
  },
];
const reads = {} as ConsoleReads;
const pages = () => createConsolePages(createPageRegistry(GROUPS));

describe("the seam a console page uses to tell Home about itself", () => {
  it("registers the page and reads its value and attention items", async () => {
    const console = pages();
    console.register("keys", {
      href: "/auth/owner/keys",
      value: () => Promise.resolve({ text: "3 keys" }),
      attention: () =>
        Promise.resolve([
          { title: "A key ends soon", href: "/auth/owner/keys", tone: "warn" },
        ]),
    });
    expect(console.registry.page("keys")?.href).toBe("/auth/owner/keys");
    const reading = await console.read(reads);
    expect(reading.values.get("keys")).toEqual({ text: "3 keys" });
    expect(reading.attention).toEqual([
      { title: "A key ends soon", href: "/auth/owner/keys", tone: "warn" },
    ]);
  });

  it("reads nothing from a page that registered neither", async () => {
    const console = pages();
    console.register("apps", { href: "/auth/owner/apps" });
    const reading = await console.read(reads);
    expect(reading.values.size).toBe(0);
    expect(reading.attention).toEqual([]);
  });

  it("refuses a second registration of a page, and a page it does not define", () => {
    const console = pages();
    console.register("keys", { href: "/auth/owner/keys" });
    expect(() => {
      console.register("keys", { href: "/auth/owner/keys" });
    }).toThrow(/already registered/);
    expect(() => {
      console.register("nope", { href: "/auth/owner/nope" });
    }).toThrow(/Unknown page/);
  });

  it("keeps a page that fails to answer from taking the rest down", async () => {
    const console = pages();
    console.register("keys", {
      href: "/auth/owner/keys",
      value: () => Promise.reject(new Error("boom")),
      attention: () => Promise.reject(new Error("boom")),
    });
    console.register("apps", {
      href: "/auth/owner/apps",
      value: () => Promise.resolve({ text: "1 app", tone: "warn" }),
    });
    const reading = await console.read(reads);
    expect(reading.values.has("keys")).toBe(false);
    expect(reading.values.get("apps")).toEqual({ text: "1 app", tone: "warn" });
    expect(reading.attention).toEqual([
      {
        title: "Couldn't check API keys",
        href: "/auth/owner/keys",
        tone: "warn",
      },
    ]);
  });

  it("asks every page at once rather than one after another", async () => {
    const console = pages();
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const id of ["keys", "apps"])
      console.register(id, {
        href: `/auth/owner/${id}`,
        value: async () => {
          started.push(id);
          await gate;
          return { text: id };
        },
      });
    const reading = console.read(reads);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(["keys", "apps"]);
    release();
    expect([...(await reading).values.keys()]).toEqual(["keys", "apps"]);
  });

  it("is the console's own registry that the shipped pages register into", () => {
    expect(CONSOLE_PAGES.registry).toBe(PAGE_REGISTRY);
  });
});
