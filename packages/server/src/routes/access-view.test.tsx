/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { visibleText } from "../pages/reading.js";
import { buildAccess, describeHeld } from "./access-model.js";
import { AccessChoices } from "./access-choices.js";
import { AccessView, scopesOfKey } from "./access-view.js";

const html = (node: unknown): string => String(node);

/** A key or an app holding a bit of everything the pages describe. */
const HELD = [
  "openid",
  "offline_access",
  "*:read",
  "core.note:write",
  "core.note:read",
  "core.task:read",
  "app.inkwell.draft:write",
  "edge.parent-of:read",
  "metadata.types:write",
  "profile:read",
  "profile.name:write",
  "keys.mint",
  "items.purge",
];
const LABELS = { "app.inkwell.draft": "Reading summary" };
const DESCRIPTIONS = { "edge.parent-of": "Which items sit inside others." };

describe("describeHeld", () => {
  const held = describeHeld(HELD, {
    typeLabels: LABELS,
    descriptions: DESCRIPTIONS,
  });

  it("puts each scope in the group the approval page puts it in, at the level it holds it", () => {
    expect(held.data).toEqual([
      { title: "All your data", value: "Read only" },
      { title: "Note", value: "Read and edit" },
      { title: "Task", value: "Read only" },
      { title: "Reading summary", value: "Read and edit" },
      { title: "Which items sit inside others", value: "Read only" },
      { title: "Custom data types", value: "Read and edit" },
    ]);
    expect(held.profile).toEqual([
      { title: "Profile", value: "Read only" },
      { title: "Name", value: "Read and edit" },
    ]);
    expect(held.powers).toEqual([
      {
        title: "Make, see, edit and revoke keys",
        description: "Keys made this way never hold more than their maker.",
        destructive: false,
      },
      {
        title: "Delete items in the trash for good",
        description: "Can't be undone.",
        destructive: true,
      },
    ]);
  });

  it("leaves out the mechanisms, which are no access", () => {
    const titles = [...held.data, ...held.profile].map((row) => row.title);
    expect(titles.join(" ")).not.toMatch(/openid|offline|Stay signed in/i);
  });

  it("says each group in a line, in the words the approval page uses", () => {
    expect(held.summaries.data).toBe(
      "Read and edit notes, reading summaries, and custom data types; read all your data, tasks, and which items sit inside others",
    );
    expect(held.summaries.profile).toBe(
      "Read and edit your name; read your profile",
    );
    expect(held.summaries.powers).toBe("2 turned on");
  });

  it("says no access for a group the credential holds nothing in", () => {
    const none = describeHeld(["openid"], {});
    expect(none.data).toEqual([]);
    expect(none.summaries.data).toBe("No access to your data");
    expect(none.summaries.profile).toBe("No access to your profile");
  });
});

describe("AccessView", () => {
  const view = visibleText(
    html(
      <AccessView
        scopes={HELD}
        typeLabels={LABELS}
        descriptions={DESCRIPTIONS}
      />,
    ),
  );

  it("shows the three groups in the approval page's order and titles", () => {
    const at = ["Your data", "Your profile", "More control over Marfa"].map(
      (title) => view.indexOf(title),
    );
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("shows every row with its level", () => {
    for (const row of [
      "All your data Read only",
      "Note Read and edit",
      "Task Read only",
      "Reading summary Read and edit",
      "Which items sit inside others Read only",
      "Custom data types Read and edit",
      "Profile Read only",
      "Name Read and edit",
    ])
      expect(view).toContain(row);
  });

  it("names each power, and marks the ones that cannot be undone", () => {
    expect(view).toContain("Make, see, edit and revoke keys");
    expect(view).toMatch(/Delete items in the trash for good.*Can't be undone/);
    // The witness: a power that deletes nothing is not marked.
    expect(view).not.toMatch(
      /Make, see, edit and revoke keys[^.]*Can't be undone/,
    );
  });

  it("offers no control: it only shows", () => {
    const markup = html(<AccessView scopes={HELD} />);
    expect(markup).not.toMatch(/<(select|input|button)\b/);
  });

  it("says the same words as the approval page for the same access", () => {
    const model = buildAccess({
      scopes: [],
      held: HELD,
      typeLabels: LABELS,
      descriptions: DESCRIPTIONS,
      bundles: [],
    });
    const page = visibleText(html(<AccessChoices model={model} />));
    for (const row of model.held)
      expect(page, row.title).toContain(`${row.title} ${row.value}`);
    for (const row of describeHeld(HELD, {
      typeLabels: LABELS,
      descriptions: DESCRIPTIONS,
    }).data)
      expect(view).toContain(`${row.title} ${row.value}`);
  });

  it("shows a credential that holds nothing as holding nothing", () => {
    const empty = visibleText(html(<AccessView scopes={["openid"]} />));
    expect(empty).toContain("No access");
  });

  it("shows only the groups the credential holds something in, beside the empty line", () => {
    const only = visibleText(html(<AccessView scopes={["core.note:read"]} />));
    expect(only).toContain("Your data");
    expect(only).not.toContain("Your profile");
    expect(only).not.toContain("More control over Marfa");
  });
});

describe("a key's access", () => {
  const view = (key: Parameters<typeof scopesOfKey>[0]) =>
    visibleText(html(<AccessView {...scopesOfKey(key)} />));

  it("reads a key's permissions and maps as the scopes the pages describe", () => {
    expect(
      scopesOfKey({
        permissions: ["keys.mint"],
        type_permissions: { "core.note": "write", "core.task": "read" },
        edge_permissions: { "parent-of": "read" },
        metadata_permissions: { types: "write" },
        profile_permissions: { name: "write" },
      }).scopes,
    ).toEqual([
      "keys.mint",
      "core.note:write",
      "core.task:read",
      "edge.parent-of:read",
      "metadata.types:write",
      "profile.name:write",
    ]);
  });

  it("shows a type denied beside all data as no access, not as read", () => {
    const text = view({
      type_permissions: { "*": "read", "core.note": "none" },
    });
    expect(text).toContain("All your data Read only");
    expect(text).toContain("Note No access");
    // The line says it too, so a closed group does not read as all data.
    expect(text).toContain("Read all your data; no access to notes");
    // The witness: with no carve-out nothing is denied.
    expect(view({ type_permissions: { "*": "read" } })).not.toContain(
      "No access to notes",
    );
  });

  it("names a profile and a metadata entry for everything as the pages and the CLI do", () => {
    const text = view({
      metadata_permissions: { "*": "write" },
      profile_permissions: { "*": "read" },
    });
    expect(text).toContain("Profile Read only");
    expect(text).toContain("Definitions on your server Read and edit");
    expect(text).not.toMatch(/\(all\)/);
    // Profile reads under Your profile, not under Your data.
    expect(text.indexOf("Profile Read only")).toBeGreaterThan(
      text.indexOf("Your profile"),
    );
  });

  it("shows an extension namespace at the level it is held", () => {
    const text = view({
      extension_permissions: { "app.cursor": "write", "app.old": "none" },
    });
    expect(text).toContain("app.cursor Read and edit");
    expect(text).toContain("app.old No access");
  });

  it("says the same words as the CLI for one mixed key", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../../ci/fixtures/access-mixed-key.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      key: Parameters<typeof scopesOfKey>[0];
      rows: { page: string; level: string }[];
      powers: string[];
    };
    const held = describeHeld(
      scopesOfKey(fixture.key).scopes,
      {},
      scopesOfKey(fixture.key),
    );
    const shown = [...held.data, ...held.profile].map(
      (row) => `${row.title} ${row.value}`,
    );
    expect(shown.sort()).toEqual(
      fixture.rows.map((row) => `${row.page} ${row.level}`).sort(),
    );
    expect(held.powers.map((power) => power.title)).toEqual(fixture.powers);
  });
});

describe("AccessView for types that share a label", () => {
  const view = visibleText(
    html(
      <AccessView
        scopes={["core.task:read", "aic.ticket.task:write", "core.note:read"]}
        typeLabels={{ "aic.ticket.task": "Task" }}
      />,
    ),
  );

  it("shows each such type's identifier under its label, and none under a label of its own", () => {
    expect(view).toContain("Task core.task Read only");
    expect(view).toContain("Task aic.ticket.task Read and edit");
    expect(view).toContain("Note Read only");
    expect(view).not.toContain("core.note");
  });
});
