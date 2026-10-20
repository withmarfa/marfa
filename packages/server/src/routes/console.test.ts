import { afterEach, describe, expect, it, vi } from "vitest";
import * as logger from "../middleware/logger.js";
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
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    vi.spyOn(logger, "log").mockImplementation(() => undefined);
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

  it("does not wait for ever on a page that never answers, and counts that as a failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, "log").mockImplementation(() => undefined);
    const console = pages();
    console.register("keys", {
      href: "/auth/owner/keys",
      value: () => new Promise<never>(() => undefined),
    });
    console.register("apps", {
      href: "/auth/owner/apps",
      attention: () => new Promise<never>(() => undefined),
    });
    let done = false;
    const reading = console.read(reads).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(done).toBe(true);
    const result = await reading;
    expect(result.values.size).toBe(0);
    expect(result.attention.map((item) => item.title)).toEqual([
      "Couldn't check API keys",
      "Couldn't check Connected apps",
    ]);
  });

  it("lets a page that answers in time be heard, and leaves no timer running", async () => {
    vi.useFakeTimers();
    const console = pages();
    console.register("keys", {
      href: "/auth/owner/keys",
      value: () => Promise.resolve({ text: "3 keys" }),
      attention: () => Promise.resolve([]),
    });
    const reading = await console.read(reads);
    expect(reading.values.get("keys")).toEqual({ text: "3 keys" });
    expect(reading.attention).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a page that throws before it returns a promise from taking the rest down", async () => {
    vi.spyOn(logger, "log").mockImplementation(() => undefined);
    const console = pages();
    console.register("keys", {
      href: "/auth/owner/keys",
      value: () => {
        throw new Error("sync");
      },
      attention: () => {
        throw new Error("sync");
      },
    });
    console.register("apps", {
      href: "/auth/owner/apps",
      value: () => Promise.resolve({ text: "1 app" }),
    });
    const reading = await console.read(reads);
    expect(reading.values.get("apps")).toEqual({ text: "1 app" });
    expect(reading.attention.map((item) => item.title)).toEqual([
      "Couldn't check API keys",
    ]);
  });

  it("treats an attention item that does not point at this server as a page that could not be checked", async () => {
    vi.spyOn(logger, "log").mockImplementation(() => undefined);
    const good = { title: "A key ends soon", href: "/auth/owner/keys" };
    // Witness: the same item with a path on this server is kept.
    const kept = pages();
    kept.register("keys", {
      href: "/auth/owner/keys",
      attention: () => Promise.resolve([good]),
    });
    expect((await kept.read(reads)).attention).toEqual([good]);
    for (const href of [
      "https://evil.example/",
      "//evil.example/x",
      "/\\evil.example",
      "/a\tb",
      "",
    ]) {
      const console = pages();
      console.register("keys", {
        href: "/auth/owner/keys",
        attention: () =>
          Promise.resolve([good, { title: "Off", href, tone: "warn" }]),
      });
      const reading = await console.read(reads);
      expect(reading.attention, JSON.stringify(href)).toEqual([
        good,
        {
          title: "Couldn't check API keys",
          href: "/auth/owner/keys",
          tone: "warn",
        },
      ]);
    }
  });

  it("refuses a tone Home does not know, on an item and on a value", async () => {
    vi.spyOn(logger, "log").mockImplementation(() => undefined);
    const console = pages();
    console.register("keys", {
      href: "/auth/owner/keys",
      value: () => Promise.resolve({ text: "x", tone: "red" as "warn" }),
      attention: () =>
        Promise.resolve([
          { title: "t", href: "/auth/owner/keys", tone: "red" as "warn" },
        ]),
    });
    const reading = await console.read(reads);
    expect(reading.values.has("keys")).toBe(false);
    expect(reading.attention.map((item) => item.title)).toEqual([
      "Couldn't check API keys",
    ]);
  });

  it("says in the log which page failed and why", async () => {
    const lines: { level: string; message: string; data?: unknown }[] = [];
    vi.spyOn(logger, "log").mockImplementation((level, message, data) => {
      lines.push({ level, message, data });
    });
    const console = pages();
    console.register("keys", {
      href: "/auth/owner/keys",
      value: () => Promise.reject(new Error("keys table gone")),
      attention: () => Promise.resolve([]),
    });
    await console.read(reads);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "warn",
      data: { page: "keys", error: "keys table gone" },
    });
    // Witness: a page that answers logs nothing.
    lines.length = 0;
    const quiet = pages();
    quiet.register("keys", {
      href: "/auth/owner/keys",
      value: () => Promise.resolve({ text: "ok" }),
    });
    await quiet.read(reads);
    expect(lines).toEqual([]);
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
