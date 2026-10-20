/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { parseScope } from "@withmarfa/shared";
import { describe, expect, it } from "vitest";
import { readControls } from "../test-html.js";
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
