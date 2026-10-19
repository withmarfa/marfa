import { describe, it, expect } from "vitest";
import { buildAccess, resolveSelection } from "./access-model.js";
import { parseScope } from "@withmarfa/shared";
import type { ParsedScope } from "@withmarfa/shared";

const scope = (literal: string): ParsedScope => {
  const parsed = parseScope(literal);
  if (!parsed) throw new Error(`unparseable: ${literal}`);
  return parsed;
};

describe("resolveSelection", () => {
  const REQUESTED = [
    "openid",
    "offline_access",
    "core.note:read",
    "core.note:write",
    "core.task:read",
    "keys.mint",
  ];

  it("grants exactly what was chosen", () => {
    expect(resolveSelection(REQUESTED, ["core.task:read"], [])).toEqual({
      ok: true,
      scopes: ["core.task:read"],
      chosen: true,
    });
  });

  it("brings the read a chosen write includes, when the request named it", () => {
    const result = resolveSelection(REQUESTED, ["core.note:write"], []);
    expect(result).toMatchObject({ ok: true, chosen: true });
    expect(result.ok && result.scopes.sort()).toEqual([
      "core.note:read",
      "core.note:write",
    ]);
  });

  it("does not add a read the request never named", () => {
    const result = resolveSelection(
      ["core.note:write"],
      ["core.note:write"],
      [],
    );
    expect(result.ok && result.scopes).toEqual(["core.note:write"]);
  });

  it("refuses a literal the request did not name, and grants nothing from the rest", () => {
    expect(
      resolveSelection(REQUESTED, ["core.task:read", "core.task:write"], []),
    ).toEqual({ ok: false });
    expect(resolveSelection(REQUESTED, ["webhooks.manage"], [])).toEqual({
      ok: false,
    });
    expect(resolveSelection(REQUESTED, ["core.*:read"], [])).toEqual({
      ok: false,
    });
  });

  it("reads an empty value as no access", () => {
    expect(resolveSelection(REQUESTED, ["", "core.task:read", ""], [])).toEqual(
      {
        ok: true,
        scopes: ["core.task:read"],
        chosen: true,
      },
    );
  });

  it("answers a repeated value once", () => {
    const result = resolveSelection(
      REQUESTED,
      ["core.task:read", "core.task:read"],
      [],
    );
    expect(result.ok && result.scopes).toEqual(["core.task:read"]);
  });

  it("counts nothing but mechanisms as nothing chosen", () => {
    expect(
      resolveSelection(REQUESTED, ["openid", "offline_access"], []),
    ).toEqual({
      ok: true,
      scopes: ["openid", "offline_access"],
      chosen: false,
    });
    expect(resolveSelection(REQUESTED, [], [])).toEqual({
      ok: true,
      scopes: [],
      chosen: false,
    });
  });

  it("lets a request that offers no choice be approved", () => {
    const identity = ["openid", "offline_access"];
    expect(resolveSelection(identity, identity, [])).toMatchObject({
      ok: true,
      chosen: true,
    });
    // Posting nothing at all is still nothing.
    expect(resolveSelection(identity, [], [])).toMatchObject({
      ok: true,
      chosen: false,
    });
  });

  it("counts a power on its own as something chosen", () => {
    expect(resolveSelection(REQUESTED, ["keys.mint"], [])).toMatchObject({
      ok: true,
      chosen: true,
    });
  });

  describe("an app that already holds access", () => {
    const ASKED = [
      "openid",
      "core.note:read",
      "core.task:read",
      "keys.mint",
      "webhooks.manage",
    ];
    const HELD = ["openid", "core.note:read", "keys.mint"];

    it("does not count what the page carries as a choice", () => {
      expect(
        resolveSelection(
          ASKED,
          ["openid", "core.note:read", "keys.mint"],
          HELD,
        ),
      ).toMatchObject({ ok: true, chosen: false });
      expect(resolveSelection(ASKED, [], HELD)).toMatchObject({
        ok: true,
        chosen: false,
      });
    });

    it("counts a control turned on beside what the page carries", () => {
      for (const on of ["core.task:read", "webhooks.manage"])
        expect(
          resolveSelection(ASKED, ["openid", "core.note:read", on], HELD),
        ).toMatchObject({ ok: true, chosen: true });
    });

    it("does not count keeping a level the app holds as a choice, whether or not the request names it", () => {
      const asked = ["core.note:read", "core.note:write"];
      expect(
        resolveSelection(asked, ["core.note:read"], ["core.note:read"]),
      ).toMatchObject({ ok: true, chosen: false });
      expect(resolveSelection(asked, [""], ["core.note:read"])).toMatchObject({
        ok: true,
        chosen: false,
      });
      expect(
        resolveSelection(asked, ["core.note:write"], ["core.note:read"]),
      ).toMatchObject({ ok: true, chosen: true });
    });

    it("treats a wildcard the app holds as carrying the types it covers", () => {
      const asked = ["core.*:read", "core.note:write"];
      expect(
        resolveSelection(asked, ["core.*:read"], ["core.*:read"]),
      ).toMatchObject({ ok: true, chosen: false });
      expect(
        resolveSelection(
          asked,
          ["core.*:read", "core.note:write"],
          ["core.*:read"],
        ),
      ).toMatchObject({ ok: true, chosen: true });
    });

    it("lets an app confirm what it holds in full, where no control is offered", () => {
      const asked = ["core.note:read", "keys.mint"];
      expect(
        resolveSelection(asked, asked, ["core.note:read", "keys.mint"]),
      ).toMatchObject({ ok: true, chosen: true });
      expect(
        resolveSelection(asked, [], ["core.note:read", "keys.mint"]),
      ).toMatchObject({ ok: true, chosen: false });
    });

    it("offers a choice exactly where the screen builds a control", () => {
      const cases: [string[], string[]][] = [
        [["core.note:read", "core.task:read"], ["core.note:read"]],
        [["core.note:read", "core.note:write"], ["core.note:read"]],
        [["core.note:read", "core.note:write"], ["core.note:write"]],
        [["core.note:write"], ["core.note:read"]],
        [["core.*:read", "core.note:write"], ["core.*:read"]],
        [["keys.mint", "webhooks.manage"], ["keys.mint"]],
        [
          ["core.note:read", "keys.mint"],
          ["core.note:read", "keys.mint"],
        ],
        [["profile.name:write"], ["profile:read"]],
        [["profile:write"], ["profile:write"]],
        [["openid", "email", "core.note:read"], ["email"]],
        [["openid", "offline_access"], []],
      ];
      for (const [asked, held] of cases) {
        const model = buildAccess({
          scopes: asked.map(scope),
          held,
          bundles: [],
        });
        const controls =
          model.data.length + model.profile.length + model.powers.length;
        const everyLiteralCarried = asked.every((literal) =>
          model.carried.includes(literal),
        );
        expect(everyLiteralCarried, JSON.stringify([asked, held])).toBe(
          controls === 0,
        );
        // With a control offered, turning everything off is not approval.
        expect(
          resolveSelection(asked, model.carried, held),
          JSON.stringify([asked, held]),
        ).toMatchObject({ ok: true, chosen: controls === 0 });
      }
    });
  });
});

describe("buildAccess", () => {
  const bundles = [] as const;

  it("holds a request to the levels it names: a type asked only to write offers write", () => {
    const model = buildAccess({
      scopes: [scope("core.note:write")],
      held: undefined,
      bundles,
    });
    expect(model.data[0]?.options.map((o) => o.value)).toEqual([
      "",
      "core.note:write",
    ]);
  });

  it("offers one row for a type however the request orders its levels", () => {
    const model = buildAccess({
      scopes: [
        scope("core.note:write"),
        scope("core.task:read"),
        scope("core.note:read"),
      ],
      held: undefined,
      bundles,
    });
    expect(model.data.map((r) => r.title)).toEqual(["Notes", "Tasks"]);
  });

  it("offers the held level as a choice that adds nothing when the request names only a level above it", () => {
    const model = buildAccess({
      scopes: [scope("core.note:write")],
      held: ["core.note:read"],
      bundles,
    });
    expect(model.data[0]?.options).toEqual([
      { value: "", label: "Read only" },
      { value: "core.note:write", label: "Read and edit" },
    ]);
    expect(model.data[0]?.selected).toBe("core.note:write");
  });

  it("offers the same held choice when a wider pattern holds the read and the request names a type's write", () => {
    const model = buildAccess({
      scopes: [scope("core.*:read"), scope("core.note:write")],
      held: ["core.*:read"],
      bundles,
    });
    expect(model.data.map((r) => r.title)).toEqual(["Notes"]);
    expect(model.data[0]?.options).toEqual([
      { value: "", label: "Read only" },
      { value: "core.note:write", label: "Read and edit" },
    ]);
    expect(model.carried).toContain("core.*:read");
  });

  it("offers the held level of a profile row the same way", () => {
    const model = buildAccess({
      scopes: [scope("profile:write")],
      held: ["profile:read"],
      bundles,
    });
    const row = model.profile[0];
    expect(row?.kind).toBe("level");
    expect(row?.kind === "level" && row.options).toEqual([
      { value: "", label: "Read only" },
      { value: "profile:write", label: "Read and edit" },
    ]);
  });

  it("selects the held level when the level asked for starts off", () => {
    const model = buildAccess({
      scopes: [scope("core.note:write")],
      held: ["core.note:read"],
      bundles: [
        {
          id: "manage",
          label: "Manage",
          description: "",
          scopes: ["core.note:write"],
          default_on: false,
        },
      ],
    });
    expect(model.data[0]?.selected).toBe("");
    expect(model.data[0]?.options.map((o) => o.label)).toEqual([
      "Read only",
      "Read and edit",
    ]);
  });

  it("offers the read the request names, not an empty choice, when the request names the held level", () => {
    const model = buildAccess({
      scopes: [scope("core.note:read"), scope("core.note:write")],
      held: ["core.note:read"],
      bundles,
    });
    expect(model.data[0]?.options).toEqual([
      { value: "core.note:read", label: "Read only" },
      { value: "core.note:write", label: "Read and edit" },
    ]);
  });

  it("treats an app that holds only the mechanisms as new, with nothing marked New", () => {
    const model = buildAccess({
      scopes: [scope("core.note:read"), scope("keys.mint")],
      held: ["openid", "offline_access"],
      bundles,
    });
    expect(model.returning).toBe(false);
    expect(model.held).toEqual([]);
    expect(model.data.every((row) => !row.isNew)).toBe(true);
    expect(
      model.powers.every((section) => section.rows.every((row) => !row.isNew)),
    ).toBe(true);
  });

  it("treats an app that holds any access beyond the mechanisms as returning", () => {
    const model = buildAccess({
      scopes: [scope("core.note:read"), scope("core.task:read")],
      held: ["openid", "core.note:read"],
      bundles,
    });
    expect(model.returning).toBe(true);
    expect(model.data.map((row) => row.isNew)).toEqual([true]);
  });

  it("lists everything the app holds, including what this request does not ask for", () => {
    const model = buildAccess({
      scopes: [scope("core.task:read")],
      held: ["core.note:write", "keys.mint", "openid"],
      bundles,
    });
    expect(model.held).toEqual([
      { title: "Notes", value: "Read and edit" },
      { title: "Make, see, edit and revoke keys", value: "On" },
    ]);
  });

  it("groups powers in a fixed order whatever order the app asked in", () => {
    const model = buildAccess({
      scopes: [
        scope("items.purge"),
        scope("keys.manage"),
        scope("webhooks.manage"),
        scope("keys.mint"),
      ],
      held: undefined,
      bundles,
    });
    expect(
      model.powers.map((s) => [s.title, s.rows.map((r) => r.literal)]),
    ).toEqual([
      ["Keys and apps", ["keys.mint", "keys.manage"]],
      ["Connections and records", ["webhooks.manage", "items.purge"]],
    ]);
  });
});
