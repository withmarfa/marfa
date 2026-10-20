/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { parseScope } from "@withmarfa/shared";
import { describe, expect, it } from "vitest";
import { readControls, visibleText } from "../test-html.js";
import { AccessChoices } from "./access-choices.js";
import { buildAccess } from "./access-model.js";

const markup = (node: unknown): string => String(node);

const TYPES = Array.from({ length: 10 }, (_, i) => ({
  id: `app.demo.kind${String(i)}`,
  label: `Kind ${String(i)}`,
}));

function setEveryOptions(asked: string[], held?: string[]): string[] {
  const scopes = asked.map((literal) => {
    const scope = parseScope(literal);
    if (!scope) throw new Error(literal);
    return scope;
  });
  const model = buildAccess({
    scopes,
    held,
    chooseTypes: TYPES,
    bundles: [],
  });
  const html = markup(<AccessChoices model={model} />);
  const every = readControls(html).find((c) => c.label === "Set every type");
  return every?.options.map((o) => o.label) ?? [];
}

describe("Set every type", () => {
  it("offers each level only when some type offers it", () => {
    expect(setEveryOptions(["*:read", "*:write"])).toEqual([
      "Choose…",
      "Read and edit",
      "Read only",
      "No access",
    ]);
    // Asked only to edit, no type can be read without editing it.
    expect(setEveryOptions(["*:write"])).toEqual([
      "Choose…",
      "Read and edit",
      "No access",
    ]);
    // Asked only to read, no type can be edited.
    expect(setEveryOptions(["*:read"])).toEqual([
      "Choose…",
      "Read only",
      "No access",
    ]);
  });

  it("offers read only where an app that holds the read is asked for the write", () => {
    expect(
      setEveryOptions(
        ["*:write"],
        TYPES.map((t) => `${t.id}:read`),
      ),
    ).toEqual(["Choose…", "Read and edit", "Read only"]);
  });
});

describe("the list of types a person chooses", () => {
  const types = [
    { id: "core.task", label: "Task" },
    { id: "aic.ticket.task", label: "Task" },
    { id: "core.note", label: "Note" },
  ];
  const model = buildAccess({
    scopes: ["*:read", "*:write"].map((literal) => {
      const scope = parseScope(literal);
      if (!scope) throw new Error(literal);
      return scope;
    }),
    held: undefined,
    chooseTypes: types,
    bundles: [],
  });
  const html = markup(<AccessChoices model={model} />);
  const rows = [...html.matchAll(/<div[^>]*\bdata-type-row\b[^>]*>/g)];

  it("is searched by the identifier as well as the label", () => {
    const searches = rows.map(
      (row) => /data-search="([^"]*)"/.exec(row[0])?.[1] ?? "",
    );
    expect(searches).toHaveLength(3);
    expect(searches[0]).toContain("task");
    expect(searches[0]).toContain("core.task");
    expect(searches[1]).toContain("aic.ticket.task");
    // The identifier of a type whose label is its own is searched too.
    expect(searches[2]).toContain("core.note");
  });

  it("shows the identifier under each of the types that share a label, and under no other", () => {
    const text = visibleText(html);
    expect(text).toContain("Task core.task");
    expect(text).toContain("Task aic.ticket.task");
    expect(text).not.toMatch(/Note core\.note/);
  });
});

describe("a row's line, for a person who hears the page", () => {
  const model = buildAccess({
    scopes: ["*:read", "*:write"].map((literal) => {
      const scope = parseScope(literal);
      if (!scope) throw new Error(literal);
      return scope;
    }),
    held: undefined,
    chooseTypes: [
      { id: "core.task", label: "Task" },
      { id: "aic.ticket.task", label: "Task" },
      { id: "core.note", label: "Note" },
    ],
    bundles: [],
  });
  const html = markup(<AccessChoices model={model} />);

  /** What the control's description says: the text of each element `aria-describedby` names. */
  const described = (name: string, nth: number): string => {
    const control = readControls(html).filter((c) => c.label === name)[nth];
    const ids = (control?.describedby ?? "").split(" ").filter(Boolean);
    return ids
      .map((id) =>
        visibleText(
          new RegExp(`<div[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</div>`).exec(
            html,
          )?.[1] ?? "",
        ),
      )
      .join(" ");
  };

  it("is the description of the control, so the identifier is heard, and the name stays the label", () => {
    expect(described("Task", 0)).toBe("core.task");
    expect(described("Task", 1)).toBe("aic.ticket.task");
    // A control with no line has nothing to describe it.
    expect(described("Note", 0)).toBe("");
    expect(readControls(html).filter((c) => c.label === "Task")).toHaveLength(
      2,
    );
  });
});

describe("what the app holds, for the line the browser rebuilds", () => {
  it("is on the page as each held level's noun and identifier", () => {
    const model = buildAccess({
      scopes: [parseScope("aic.ticket.task:write")].flatMap((s) =>
        s ? [s] : [],
      ),
      held: ["core.task:read", "core.note:read"],
      typeLabels: { "aic.ticket.task": "Task" },
      bundles: [],
    });
    const html = markup(<AccessChoices model={model} />);
    const held = [
      ...html.matchAll(/<[a-z]+[^>]*\bdata-held-pick\b[^>]*>/g),
    ].map((m) => [
      /data-noun="([^"]*)"/.exec(m[0])?.[1],
      /data-alias="([^"]*)"/.exec(m[0])?.[1],
    ]);
    expect(held).toEqual([
      ["tasks", "core.task"],
      ["notes", "core.note"],
    ]);
  });
});
