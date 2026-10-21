import { describe, it, expect } from "vitest";
import {
  buildAccess,
  CHOOSE_TYPES,
  describeHeld,
  resolveSelection,
} from "./access-model.js";
import { grantCoversScope, parseScope } from "@withmarfa/shared";
import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";

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
        resolveSelection(asked, [], ["core.note:read", "keys.mint"]),
      ).toEqual({ ok: true, scopes: asked, chosen: true });
    });

    it("adds the scopes the request names that the app holds now, and only those", () => {
      const asked = [
        "openid",
        "core.note:write",
        "keys.mint",
        "core.task:read",
      ];
      expect(
        resolveSelection(
          asked,
          ["openid", "core.task:read"],
          ["openid", "core.note:write", "keys.mint"],
        ),
      ).toEqual({ ok: true, scopes: asked, chosen: true });
      // A wildcard the app holds covers the literals the request names.
      expect(resolveSelection(asked, ["keys.mint"], ["core.*:write"])).toEqual({
        ok: true,
        scopes: ["core.note:write", "keys.mint", "core.task:read"],
        chosen: true,
      });
    });

    it("gives back nothing once the app no longer holds it, and treats a post of nothing new as no approval", () => {
      const asked = [
        "openid",
        "core.note:write",
        "keys.mint",
        "core.task:read",
      ];
      expect(resolveSelection(asked, ["openid"], [])).toEqual({
        ok: true,
        scopes: ["openid"],
        chosen: false,
      });
      expect(resolveSelection(asked, ["openid", "core.task:read"], [])).toEqual(
        {
          ok: true,
          scopes: ["openid", "core.task:read"],
          chosen: true,
        },
      );
    });

    it("answers in the request's order, whatever order the form arrived in", () => {
      expect(
        resolveSelection(
          ["core.note:read", "core.task:read", "keys.mint"],
          ["keys.mint", "core.task:read"],
          ["core.note:read"],
        ),
      ).toMatchObject({
        scopes: ["core.note:read", "core.task:read", "keys.mint"],
      });
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
        const noChoiceLeft = asked.every(
          (literal) =>
            model.mechanisms.includes(literal) ||
            grantCoversScope(held, literal),
        );
        expect(noChoiceLeft, JSON.stringify([asked, held])).toBe(
          controls === 0,
        );
        // With a control offered, turning everything off is not approval.
        expect(
          resolveSelection(asked, model.mechanisms, held),
          JSON.stringify([asked, held]),
        ).toMatchObject({ ok: true, chosen: controls === 0 });
      }
    });
  });
});

describe("resolveSelection choosing types instead of all data", () => {
  const ASKED = ["openid", "*:read", "*:write", "keys.mint"];
  const OFFERED = ["core.note", "core.task", "core.event", "app.inkwell.draft"];
  const types = (...values: string[]) => ({ values, offered: OFFERED });

  it("grants the types chosen and not all data", () => {
    const result = resolveSelection(
      ASKED,
      [CHOOSE_TYPES],
      [],
      types("core.note:write", "core.task:read"),
    );
    expect(result).toMatchObject({ ok: true, chosen: true });
    expect(result.ok && result.scopes.sort()).toEqual([
      "core.note:read",
      "core.note:write",
      "core.task:read",
    ]);
    expect(result.ok && result.scopes).not.toContain("*:read");
    expect(result.ok && result.scopes).not.toContain("*:write");
  });

  it("leaves a type the person chose a runtime registration", () => {
    const result = resolveSelection(
      ASKED,
      [CHOOSE_TYPES],
      [],
      types("app.inkwell.draft:read"),
    );
    expect(result.ok && result.scopes).toEqual(["app.inkwell.draft:read"]);
  });

  it("grants all data and ignores the type controls when types were not chosen", () => {
    const result = resolveSelection(
      ASKED,
      ["*:read"],
      [],
      types("core.note:read", "core.task:read"),
    );
    expect(result).toEqual({ ok: true, scopes: ["*:read"], chosen: true });
  });

  it("grants nothing when types were chosen and none was turned on", () => {
    expect(resolveSelection(ASKED, [CHOOSE_TYPES], [], types())).toEqual({
      ok: true,
      scopes: [],
      chosen: false,
    });
    // The witness: with one turned on, the same post grants it.
    expect(
      resolveSelection(ASKED, [CHOOSE_TYPES], [], types("core.task:read")),
    ).toMatchObject({ ok: true, chosen: true });
  });

  it("refuses a level above the one the request names for all data", () => {
    expect(
      resolveSelection(
        ["*:read"],
        [CHOOSE_TYPES],
        [],
        types("core.note:write"),
      ),
    ).toEqual({ ok: false });
    // The witness: asked to write, the same choice is granted.
    expect(
      resolveSelection(
        ["*:write"],
        [CHOOSE_TYPES],
        [],
        types("core.note:write"),
      ),
    ).toMatchObject({ ok: true });
  });

  it("refuses a type the page did not offer, and grants nothing from the rest", () => {
    for (const bad of [
      "system.connection:read",
      "core.unheard:read",
      "core.*:read",
      "keys.mint",
      "core.note",
    ])
      expect(
        resolveSelection(
          ASKED,
          [CHOOSE_TYPES],
          [],
          types("core.task:read", bad),
        ),
        bad,
      ).toEqual({ ok: false });
  });

  it("refuses a type chosen when the request names no all-data scope", () => {
    expect(
      resolveSelection(
        ["core.note:read"],
        [CHOOSE_TYPES],
        [],
        types("core.task:read"),
      ),
    ).toEqual({ ok: false });
    expect(
      resolveSelection(["core.note:read"], [CHOOSE_TYPES], [], types()),
    ).toEqual({ ok: false });
  });

  it("ignores a type control that is out of bounds when types were not chosen", () => {
    // A page without a script posts every control, and a type deleted since the
    // page was drawn is one of them: with all data kept it means nothing.
    for (const stale of ["core.note:write", "core.unheard:read", "keys.mint"])
      expect(
        resolveSelection(["*:read"], ["*:read"], [], types(stale)),
        stale,
      ).toEqual({ ok: true, scopes: ["*:read"], chosen: true });
  });

  it("keeps the types an app already holds, whether it asks for all data or chooses types", () => {
    const held = ["core.note:read"];
    const chose = resolveSelection(
      ["*:read"],
      [CHOOSE_TYPES],
      held,
      types("core.task:read"),
    );
    expect(chose.ok && chose.scopes.sort()).toEqual([
      "core.note:read",
      "core.task:read",
    ]);
    const nothingNew = resolveSelection(
      ["*:read"],
      [CHOOSE_TYPES],
      held,
      types(),
    );
    // Held access is carried and is not a choice: nothing new denies.
    expect(nothingNew).toEqual({
      ok: true,
      scopes: ["core.note:read"],
      chosen: false,
    });
  });

  it("does not carry a held type beside all data, which already covers it", () => {
    expect(
      resolveSelection(["*:read"], ["*:read"], ["core.note:read"], types()),
    ).toEqual({ ok: true, scopes: ["*:read"], chosen: true });
  });

  it("does not carry a held read beside a write chosen for the same type", () => {
    const result = resolveSelection(
      ["*:write"],
      [CHOOSE_TYPES],
      ["core.note:read"],
      types("core.note:write"),
    );
    expect(result.ok && result.scopes).toEqual(["core.note:write"]);
  });

  it("does not count a held type as a choice made on this screen", () => {
    expect(
      resolveSelection(
        ["*:read"],
        [CHOOSE_TYPES],
        ["core.note:read"],
        types("core.note:read"),
      ),
    ).toMatchObject({ ok: true, chosen: false });
  });

  it("keeps the request's own order, then the chosen types in the order the page lists them", () => {
    const result = resolveSelection(
      ["openid", "*:read", "keys.mint"],
      ["keys.mint", CHOOSE_TYPES, "openid"],
      [],
      types("core.task:read", "core.note:read"),
    );
    expect(result.ok && result.scopes).toEqual([
      "openid",
      "keys.mint",
      "core.note:read",
      "core.task:read",
    ]);
  });

  it("names no read for a chosen write when the request named no all-data read", () => {
    const result = resolveSelection(
      ["*:write"],
      [CHOOSE_TYPES],
      [],
      types("core.note:write"),
    );
    expect(result.ok && result.scopes).toEqual(["core.note:write"]);
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
    expect(model.data.map((r) => r.title)).toEqual(["Note", "Task"]);
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
    expect(model.data.map((r) => r.title)).toEqual(["Note"]);
    expect(model.data[0]?.options).toEqual([
      { value: "", label: "Read only" },
      { value: "core.note:write", label: "Read and edit" },
    ]);
    expect(model.mechanisms).toEqual([]);
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

  it("offers the held level as the empty choice, even when the request names its literal", () => {
    const model = buildAccess({
      scopes: [scope("core.note:read"), scope("core.note:write")],
      held: ["core.note:read"],
      bundles,
    });
    expect(model.data[0]?.options).toEqual([
      { value: "", label: "Read only" },
      { value: "core.note:write", label: "Read and edit" },
    ]);
  });

  it.each([
    [["core.note:read", "core.note:write"], ["core.note:read"]],
    [["profile:read", "profile:write"], ["profile:read"]],
    [["core.*:read", "core.note:write"], ["core.*:read"]],
  ])(
    "never offers a value the app holds, so picking the level it holds posts nothing and a disconnected app regains nothing (%j)",
    (asked, held) => {
      const model = buildAccess({ scopes: asked.map(scope), held, bundles });
      const row = [...model.data, ...model.profile].find(
        (r) => r.kind === "level",
      );
      const posted = row?.kind === "level" ? row.options[0]?.value : undefined;
      expect(posted).toBe("");
      // The consent the app held has since been ended.
      expect(resolveSelection(asked, [posted ?? "?"], [])).toMatchObject({
        ok: true,
        chosen: false,
      });
      for (const option of row?.kind === "level" ? row.options : [])
        expect(grantCoversScope(held, option.value)).toBe(false);
    },
  );

  describe("where the controls start", () => {
    const asked = [
      scope("core.note:read"),
      scope("core.note:write"),
      scope("keys.mint"),
    ];

    it("starts a control on, and a power off, when answering an app's request", () => {
      const model = buildAccess({ scopes: asked, held: undefined, bundles });
      expect(model.data[0]?.selected).toBe("core.note:write");
      expect(model.powers.map((row) => row.checked)).toEqual([false]);
      expect(model.counted).toBe(false);
      expect(model.summaries.powers).toBe(
        "1 thing asked, off until you turn it on",
      );
    });

    it("starts every control off for a key being made, and counts the powers", () => {
      const model = buildAccess({
        scopes: asked,
        held: undefined,
        bundles,
        start: "off",
      });
      expect(model.data[0]?.selected).toBe("");
      expect(model.powers.map((row) => row.checked)).toEqual([false]);
      expect(model.counted).toBe(true);
      expect(model.summaries.powers).toBe("0 of 1 turned on");
    });

    it("starts every control at the most it offers for a key being narrowed", () => {
      const model = buildAccess({
        scopes: asked,
        held: undefined,
        bundles,
        start: "held",
      });
      expect(model.data[0]?.selected).toBe("core.note:write");
      expect(model.powers.map((row) => row.checked)).toEqual([true]);
      expect(model.counted).toBe(true);
      expect(model.summaries.powers).toBe("1 of 1 turned on");
    });
  });

  describe("offersEdit", () => {
    const offers = (...literals: string[]): boolean =>
      buildAccess({ scopes: literals.map(scope), held: undefined, bundles })
        .offersEdit;

    it("is true where a level to edit an item type or the content is offered", () => {
      expect(offers("core.note:read", "core.note:write")).toBe(true);
      expect(offers("content:write")).toBe(true);
      expect(offers("*:write")).toBe(true);
    });

    it("is false where the only level to edit is not about items", () => {
      // The witness above shows each of these rows offers a level to edit.
      expect(
        buildAccess({
          scopes: [scope("metadata.types:write")],
          held: undefined,
          bundles,
        }).data[0]?.options.map((o) => o.label),
      ).toContain("Read and edit");
      expect(offers("metadata.types:write")).toBe(false);
      expect(offers("metadata:read", "metadata:write")).toBe(false);
      expect(offers("edge.parent-of:write")).toBe(false);
      expect(offers("profile:write")).toBe(false);
    });

    it("is false where editing is not offered", () => {
      expect(offers("core.note:read")).toBe(false);
    });
  });

  it("treats an app that holds only the mechanisms as new", () => {
    const model = buildAccess({
      scopes: [scope("core.note:read"), scope("keys.mint")],
      held: ["openid", "offline_access"],
      bundles,
    });
    expect(model.returning).toBe(false);
    expect(model.held).toEqual([]);
  });

  it("treats an app that holds any access beyond the mechanisms as returning", () => {
    const model = buildAccess({
      scopes: [scope("core.note:read"), scope("core.task:read")],
      held: ["openid", "core.note:read"],
      bundles,
    });
    expect(model.returning).toBe(true);
  });

  it("lists everything the app holds, including what this request does not ask for", () => {
    const model = buildAccess({
      scopes: [scope("core.task:read")],
      held: ["core.note:write", "keys.mint", "openid"],
      bundles,
    });
    expect(model.held).toEqual([
      { title: "Note", value: "Read and edit" },
      { title: "Make, see, edit and revoke keys", value: "On" },
    ]);
  });

  it("lists every power in one fixed order whatever order the app asked in", () => {
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
    expect(model.powers.map((row) => row.literal)).toEqual([
      "keys.mint",
      "keys.manage",
      "webhooks.manage",
      "items.purge",
    ]);
  });

  describe("names and the line each group says", () => {
    it("titles an item type by its own singular label and speaks of it in the plural", () => {
      const model = buildAccess({
        scopes: [
          scope("core.note:write"),
          scope("core.entity.person:read"),
          scope("core.media.series:read"),
        ],
        held: undefined,
        bundles,
      });
      expect(model.data.map((row) => [row.title, row.noun])).toEqual([
        ["Note", "notes"],
        ["Person", "people"],
        ["Series", "series"],
      ]);
    });

    it("reads the label of a type registered on the instance from what the caller looked up", () => {
      const model = buildAccess({
        scopes: [scope("app.inkwell.draft:write")],
        held: undefined,
        typeLabels: { "app.inkwell.draft": "Reading summary" },
        bundles,
      });
      expect(model.data[0]).toMatchObject({
        title: "Reading summary",
        noun: "reading summaries",
      });
      expect(model.summaries.data).toBe("Read and edit reading summaries");
    });

    it("says what the starting choice gives, and that nothing is on when nothing is", () => {
      const model = buildAccess({
        scopes: [
          scope("core.note:write"),
          scope("core.task:read"),
          scope("keys.mint"),
        ],
        held: undefined,
        bundles,
      });
      expect(model.summaries.data).toBe("Read and edit notes; read tasks");
      expect(model.summaries.powers).toBe(
        "1 thing asked, off until you turn it on",
      );
      const none = buildAccess({
        scopes: [scope("core.note:write")],
        held: undefined,
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
      expect(none.summaries.data).toBe("No access to your data");
    });

    it("leaves out of the line what the app already holds, and says nothing new when that is all", () => {
      const model = buildAccess({
        scopes: [scope("core.note:write"), scope("core.event:read")],
        held: ["core.note:read", "core.event:read"],
        bundles,
      });
      expect(model.summaries.data).toBe("Read and edit notes");
      expect(model.summaries.empty.data).toBe("Nothing new turned on");
      expect(model.summaries.held).toBe("Read notes and events");
    });

    it("says what the app holds in the same words, with the powers after", () => {
      const model = buildAccess({
        scopes: [scope("core.task:read")],
        held: ["core.task:write", "core.event:read", "keys.mint"],
        bundles,
      });
      expect(model.summaries.held).toBe(
        "Read and edit tasks; read events. Can also make, see, edit and revoke keys",
      );
    });
  });

  describe("choosing types in place of all data", () => {
    const chooseTypes = [
      { id: "core.note", label: "Note" },
      { id: "core.task", label: "Task" },
      { id: "app.inkwell.draft", label: "Reading summary" },
    ];

    it("offers the choice beside the levels, and a control for each type at the levels asked", () => {
      const model = buildAccess({
        scopes: [scope("*:read"), scope("*:write")],
        held: undefined,
        chooseTypes,
        bundles,
      });
      const all = model.data[0];
      expect(all?.title).toBe("All your data");
      expect(all?.options).toEqual([
        { value: "", label: "No access" },
        { value: "*:read", label: "Read only" },
        { value: "*:write", label: "Read and edit" },
        { value: CHOOSE_TYPES, label: "Choose types" },
      ]);
      expect(all?.selected).toBe("*:write");
      expect(
        all?.choose?.rows.map((r) => [r.title, r.name, r.selected]),
      ).toEqual([
        ["Note", "types", "core.note:write"],
        ["Task", "types", "core.task:write"],
        ["Reading summary", "types", "app.inkwell.draft:write"],
      ]);
      expect(all?.choose?.rows[0]?.options).toEqual([
        { value: "", label: "No access" },
        { value: "core.note:read", label: "Read only" },
        { value: "core.note:write", label: "Read and edit" },
      ]);
      // The line still says what the starting choice gives.
      expect(model.summaries.data).toBe("Read and edit all your data");
    });

    it("offers no level for a type above the one asked for all data", () => {
      const model = buildAccess({
        scopes: [scope("*:read")],
        held: undefined,
        chooseTypes,
        bundles,
      });
      for (const row of model.data[0]?.choose?.rows ?? [])
        expect(row.options.map((o) => o.label)).toEqual([
          "No access",
          "Read only",
        ]);
    });

    it("offers a type no lower than the app holds, and leaves out a type held in full", () => {
      const model = buildAccess({
        scopes: [scope("*:read"), scope("*:write")],
        held: ["core.note:write", "core.task:read"],
        chooseTypes,
        bundles,
      });
      const rows = model.data[0]?.choose?.rows ?? [];
      expect(rows.map((r) => r.title)).toEqual(["Task", "Reading summary"]);
      expect(rows[0]?.options).toEqual([
        { value: "", label: "Read only" },
        { value: "core.task:write", label: "Read and edit" },
      ]);
      expect(rows[0]?.description).toBe("Now: Read only");
    });

    it("offers nothing to choose when the request does not name all data or no type is known", () => {
      expect(
        buildAccess({
          scopes: [scope("core.*:read")],
          held: undefined,
          chooseTypes,
          bundles,
        }).data.flatMap((r) => r.choose ?? []),
      ).toEqual([]);
      const without = buildAccess({
        scopes: [scope("*:read")],
        held: undefined,
        bundles,
      });
      expect(without.data[0]?.choose).toBeUndefined();
      expect(without.data[0]?.options.map((o) => o.value)).toEqual([
        "",
        "*:read",
      ]);
    });
  });
});

describe("types that share a label", () => {
  const bundles: PermissionBundle[] = [];
  const chooseTypes = [
    { id: "core.note", label: "Note" },
    { id: "core.task", label: "Task" },
    { id: "aic.ticket.task", label: "Task" },
  ];

  it("gives each type of a shared label its identifier under the label, and a type with a label of its own none", () => {
    const model = buildAccess({
      scopes: [scope("*:read"), scope("*:write")],
      held: undefined,
      chooseTypes,
      bundles,
    });
    expect(
      model.data[0]?.choose?.rows.map((r) => [r.title, r.description]),
    ).toEqual([
      ["Note", undefined],
      ["Task", "core.task"],
      ["Task", "aic.ticket.task"],
    ]);
  });

  it("keeps what a row already says beside the identifier", () => {
    const model = buildAccess({
      scopes: [scope("*:read"), scope("*:write")],
      held: ["core.task:read"],
      chooseTypes,
      bundles,
    });
    expect(
      model.data[0]?.choose?.rows.map((r) => [r.title, r.description]),
    ).toEqual([
      ["Note", undefined],
      ["Task", "core.task. Now: Read only"],
      ["Task", "aic.ticket.task"],
    ]);
  });

  it("names the identifier on the rows for a request that names both types", () => {
    const model = buildAccess({
      scopes: [scope("core.task:read"), scope("aic.ticket.task:write")],
      held: undefined,
      typeLabels: { "aic.ticket.task": "Task" },
      bundles,
    });
    expect(model.data.map((r) => [r.title, r.description])).toEqual([
      ["Task", "core.task"],
      ["Task", "aic.ticket.task"],
    ]);
  });

  it("leaves a type alone when only one row of that label is on the page, even where the app holds and asks for it", () => {
    const model = buildAccess({
      scopes: [scope("core.task:write")],
      held: ["core.task:read"],
      bundles,
    });
    expect(model.data.map((r) => r.description)).toEqual(["Now: Read only"]);
    expect(model.held).toEqual([{ title: "Task", value: "Read only" }]);
  });

  it("tells apart what is held, in the box on the approval pages and on the pages that only show it", () => {
    const words = { typeLabels: { "aic.ticket.task": "Task" } };
    const held = describeHeld(
      ["core.task:read", "aic.ticket.task:write", "core.note:read"],
      words,
    );
    expect(held.data).toEqual([
      { title: "Task", value: "Read only", description: "core.task" },
      {
        title: "Task",
        value: "Read and edit",
        description: "aic.ticket.task",
      },
      { title: "Note", value: "Read only" },
    ]);
    expect(held.rows).toEqual(held.data);
  });

  it("names the integration data of every namespace in words, and other namespaces as they are", () => {
    const all = describeHeld([], {}, { extensions: { "*": "write" } });
    expect(all.data).toEqual([
      { title: "Integration data", value: "Read and edit" },
    ]);
    expect(all.summary).toBe("Read and edit integration data");
    const mixed = describeHeld(
      ["core.note:read"],
      {},
      { extensions: { "*": "read", "app.cursor": "write" } },
    );
    expect(mixed.summary).toBe(
      "Read and edit app.cursor; read notes and integration data",
    );
    expect(
      describeHeld([], {}, { extensions: { "*": "none" } }).summaries.data,
    ).toBe("No access to integration data");
  });

  it("tells a held type from a type the request offers when they share a label", () => {
    const model = buildAccess({
      scopes: [scope("aic.ticket.task:read")],
      held: ["core.task:read"],
      typeLabels: { "aic.ticket.task": "Task" },
      bundles,
    });
    expect(model.held).toEqual([
      { title: "Task", value: "Read only", description: "core.task" },
    ]);
    expect(model.data.map((r) => [r.title, r.description])).toEqual([
      ["Task", "aic.ticket.task"],
    ]);
  });

  it("gives a type the identifier when a curated row shares its label, and a curated row never one", () => {
    const words = { typeLabels: { "aic.me.profile": "Profile" } };
    const model = buildAccess({
      scopes: [scope("profile:read"), scope("aic.me.profile:read")],
      held: undefined,
      ...words,
      bundles,
    });
    expect(model.data.map((r) => [r.title, r.description])).toEqual([
      ["Profile", "aic.me.profile"],
    ]);
    expect(model.profile.map((r) => [r.title, r.description])).toEqual([
      ["Profile", "Covers what exists today plus anything added later"],
    ]);
    const held = describeHeld(["profile:read", "aic.me.profile:read"], words);
    expect([...held.data, ...held.profile]).toEqual([
      { title: "Profile", value: "Read only", description: "aic.me.profile" },
      { title: "Profile", value: "Read only" },
    ]);
  });

  it("names the types in a summary line by identifier where their nouns read alike", () => {
    const model = buildAccess({
      scopes: [scope("core.task:write"), scope("aic.ticket.task:write")],
      held: ["core.task:read", "aic.ticket.task:read"],
      typeLabels: { "aic.ticket.task": "Task" },
      bundles,
    });
    expect(model.summaries.data).toBe(
      "Read and edit core.task and aic.ticket.task",
    );
    expect(model.summaries.held).toBe("Read core.task and aic.ticket.task");
    const fresh = buildAccess({
      scopes: [scope("core.task:write"), scope("aic.ticket.task:write")],
      held: undefined,
      typeLabels: { "aic.ticket.task": "Task" },
      bundles,
    });
    expect(fresh.summaries.data).toBe(
      "Read and edit core.task and aic.ticket.task",
    );
  });

  it("names a type by identifier in the line for what is held and the line for what is asked when the two read alike", () => {
    const model = buildAccess({
      scopes: [scope("aic.ticket.task:write")],
      held: ["core.task:read"],
      typeLabels: { "aic.ticket.task": "Task" },
      bundles,
    });
    expect(model.summaries.held).toBe("Read core.task");
    expect(model.summaries.data).toBe("Read and edit aic.ticket.task");
    expect(model.heldLevels).toEqual([
      { noun: "tasks", alias: "core.task", level: "read" },
    ]);
    // The witness: with no other type of the label, both lines keep the noun.
    const alone = buildAccess({
      scopes: [scope("core.task:write")],
      held: ["core.task:read"],
      bundles,
    });
    expect(alone.summaries.held).toBe("Read tasks");
    expect(alone.summaries.data).toBe("Read and edit tasks");
  });
});

describe("connected app inherited access", () => {
  it("keeps the broad profile control editable when every profile row is also named", () => {
    const scopes = [
      "profile:read",
      "profile.name:read",
      "profile.email:read",
      "profile.avatar:read",
    ];
    const model = buildAccess({
      scopes: scopes.map(scope),
      held: undefined,
      bundles: [],
      start: "held",
      narrowing: scopes,
    });
    const broad = model.profile.find(
      (row) => row.kind === "level" && row.selected === "profile:read",
    );
    expect(broad?.kind === "level" && broad.inherited).toBeUndefined();
    expect(broad?.kind === "level" && broad.options[0]).toEqual({
      value: "",
      label: "No access",
    });
  });
  it.each([
    ["*:read", "core.note:read", "read"],
    ["*:write", "core.note:read", "read"],
    ["core.media.*:write", "core.media.article:read", "read"],
    ["content:write", "core.note:read", "read"],
    ["edge.*:write", "edge.parent-of:read", "read"],
    ["metadata:write", "metadata.types:read", "write"],
    ["profile:write", "profile.name:read", "write"],
  ])(
    "locks %s coverage of %s at its effective %s level",
    (broad, narrow, level) => {
      const scopes = [broad, narrow];
      const model = buildAccess({
        scopes: scopes.map(scope),
        held: undefined,
        bundles: [],
        start: "held",
        narrowing: scopes,
      });
      const rows = [...model.data, ...model.profile].filter(
        (row) => row.kind === "level",
      );
      const dependent = rows.find((row) => row.selected === narrow);
      expect(dependent?.inherited).toEqual({ level, scopes: [narrow] });
      expect(dependent?.options).toEqual([
        {
          value: narrow,
          label: level === "write" ? "Read and edit" : "Read only",
        },
      ]);
      expect(
        rows.find((row) => row.selected === broad)?.inherited,
      ).toBeUndefined();
      const reloaded = buildAccess({
        scopes: [scope(narrow)],
        held: undefined,
        bundles: [],
        start: "held",
        narrowing: [narrow],
      });
      const unlocked = [...reloaded.data, ...reloaded.profile].find(
        (row) => row.kind === "level",
      );
      expect(unlocked?.kind === "level" && unlocked.inherited).toBeUndefined();
      expect(unlocked?.kind === "level" && unlocked.options[0]).toEqual({
        value: "",
        label: "No access",
      });
    },
  );
});
