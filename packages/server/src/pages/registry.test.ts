import { describe, expect, it } from "vitest";
import {
  HOME_GROUPS,
  PAGE_REGISTRY,
  createPageRegistry,
  type GroupDefinition,
} from "./registry.js";

const GROUPS: readonly GroupDefinition[] = [
  {
    id: "access",
    title: "Access",
    pages: [
      { id: "keys", title: "API keys", description: "Let scripts use Marfa" },
      { id: "apps", title: "Connected apps", description: "Apps you approved" },
    ],
  },
  {
    id: "data",
    title: "Your data",
    pages: [
      { id: "items", title: "Items", description: "Everything, by type" },
      { id: "trash", title: "Trash", description: "Deleted items" },
    ],
  },
];

function registry() {
  return createPageRegistry(GROUPS);
}

describe("the Home groups", () => {
  it("are the prototype's, in order", () => {
    expect(
      HOME_GROUPS.map((g) => [g.title, g.pages.map((p) => p.title)]),
    ).toEqual([
      ["Access", ["API keys", "Connected apps", "Browsers"]],
      ["Your data", ["Items", "Trash", "Export and restore"]],
      ["Connections", ["Connectors", "Folders"]],
      ["This Marfa", ["General", "Health", "Activity", "All settings"]],
      ["You", ["Profile", "Password and passkeys"]],
    ]);
  });

  it("give every page an id no other page has", () => {
    const ids = HOME_GROUPS.flatMap((g) => g.pages.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("start with no page built, so the shipped registry links to nothing", () => {
    expect(PAGE_REGISTRY.groups()).toEqual([]);
    expect(PAGE_REGISTRY.search("keys")).toEqual({ pages: [], settings: [] });
  });
});

describe("a page that is not built", () => {
  it("is in no group, no search and no lookup", () => {
    const r = registry();
    expect(r.groups()).toEqual([]);
    expect(r.page("keys")).toBeUndefined();
    expect(r.search("keys").pages).toEqual([]);
  });

  it("appears once it registers, with the link it registered", () => {
    const r = registry();
    r.register("keys", { href: "/keys-page" });
    expect(r.page("keys")).toMatchObject({
      id: "keys",
      title: "API keys",
      href: "/keys-page",
    });
    expect(r.groups().map((g) => g.id)).toEqual(["access"]);
    expect(r.groups()[0]?.pages.map((p) => p.id)).toEqual(["keys"]);
  });

  it("keeps a group out of the picker until one of its pages is built", () => {
    const r = registry();
    r.register("trash", { href: "/trash-page" });
    expect(r.groups().map((g) => g.id)).toEqual(["data"]);
    expect(r.groups()[0]?.pages.map((p) => p.id)).toEqual(["trash"]);
  });

  it("keeps the order the groups were defined in, whatever order pages register", () => {
    const r = registry();
    r.register("trash", { href: "/t" });
    r.register("apps", { href: "/a" });
    r.register("keys", { href: "/k" });
    expect(r.groups().map((g) => g.pages.map((p) => p.id))).toEqual([
      ["keys", "apps"],
      ["trash"],
    ]);
  });
});

describe("register", () => {
  it("refuses a page the registry has no definition for", () => {
    expect(() => {
      registry().register("nope", { href: "/x" });
    }).toThrow(/unknown page/i);
  });

  it("refuses to register a page twice", () => {
    const r = registry();
    r.register("keys", { href: "/k" });
    expect(() => {
      r.register("keys", { href: "/k2" });
    }).toThrow(/already/i);
  });

  it("refuses a link that is not a path on this server", () => {
    const r = registry();
    for (const href of [
      "",
      "keys",
      "//evil.example",
      "https://evil.example/",
      "javascript:alert(1)",
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r/evil.com",
      "/\\evil.com",
    ])
      expect(() => {
        r.register("keys", { href });
      }, href).toThrow(/path/i);
  });

  it("refuses two pages that share an id in the definitions", () => {
    expect(() =>
      createPageRegistry([
        {
          id: "a",
          title: "A",
          pages: [{ id: "x", title: "X", description: "" }],
        },
        {
          id: "b",
          title: "B",
          pages: [{ id: "x", title: "X", description: "" }],
        },
      ]),
    ).toThrow(/duplicate/i);
  });
});

describe("search", () => {
  function built() {
    const r = registry();
    r.register("keys", { href: "/k" });
    r.register("items", {
      href: "/i",
      hasItems: true,
      settings: [
        {
          id: "trash_days",
          title: "Keep items in the trash",
          description: "After this, they are deleted for good",
          group: "Keeping things",
          href: "/i#trash",
        },
      ],
    });
    return r;
  }

  it("finds pages by title, description and group", () => {
    const r = built();
    expect(r.search("scripts").pages.map((p) => p.id)).toEqual(["keys"]);
    expect(r.search("everything").pages.map((p) => p.id)).toEqual(["items"]);
    expect(r.search("your data").pages.map((p) => p.id)).toEqual(["items"]);
  });

  it("finds settings by title and description, naming the page they live on", () => {
    const hits = built().search("trash").settings;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: "trash_days",
      href: "/i#trash",
      page: "Items",
    });
  });

  it("puts a title match before a description match", () => {
    const r = createPageRegistry([
      {
        id: "g",
        title: "G",
        pages: [
          { id: "a", title: "Alpha", description: "mentions keys" },
          { id: "b", title: "Keys", description: "" },
        ],
      },
    ]);
    r.register("a", { href: "/a" });
    r.register("b", { href: "/b" });
    expect(r.search("keys").pages.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("returns nothing for a query nothing matches", () => {
    expect(built().search("zzz")).toEqual({ pages: [], settings: [] });
  });
});

describe("settings", () => {
  it("refuses a setting registered twice under one page", () => {
    const r = registry();
    const s = { id: "s", title: "S", group: "G", href: "/s" };
    expect(() => {
      r.register("keys", { href: "/k", settings: [s, s] });
    }).toThrow(/duplicate/i);
  });
});
