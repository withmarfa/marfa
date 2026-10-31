import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { typeCatalog, wireType } from "../../device/marfa-answers.js";
import type { BindingHarness } from "./harness.js";
import { bindingHarness } from "./binding.shared.js";

/**
 * A device names and previews an item by its catalog alone, as the server
 * names it. The cases are the ones the server's names are held to in
 * `compliance/item-summaries.test.ts`, so the two cannot drift.
 */

interface SharedType {
  id: string;
  parent?: string;
  fields: Record<string, unknown>;
  display_hints?: Record<string, string>;
}

const SHARED = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/item-display.json", import.meta.url),
    "utf8",
  ),
) as {
  types: SharedType[];
  cases: {
    description: string;
    type: string;
    properties: Record<string, unknown>;
    name: string | null;
    preview: string | null;
  }[];
};

let harness: BindingHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("an item's name and preview on a device", () => {
  it("names and previews every shared case from the copy's catalog, without asking the server", async () => {
    const own = await bindingHarness("binding-item-display", {
      setup: ({ server }) => {
        server.copyAnswer("GET", "/types", () =>
          typeCatalog(
            SHARED.types.map((type) => ({
              ...wireType(type.id, {
                parent: type.parent,
                fields: type.fields,
              }),
              // As registered: a type without hints of its own inherits its
              // parent's, which a scripted default would hide.
              display_hints: type.display_hints ?? {},
            })),
          ),
        );
      },
    });
    harness = own;
    const types = await own.device.itemTypes();
    expect(
      types.ok && types.value.map((type) => type.id),
      "the copy does not hold the shared types, so the cases below would be named by the fallback fields alone",
    ).toEqual(expect.arrayContaining(SHARED.types.map((type) => type.id)));

    const asked = own.server.requests.length;
    const shown = await own.device.itemDisplays(
      SHARED.cases.map(({ type, properties }) => ({ type, properties })),
    );
    expect(shown.ok, JSON.stringify(shown)).toBe(true);
    if (!shown.ok) return;
    expect(own.server.requests.slice(asked)).toEqual([]);
    expect(shown.value).toHaveLength(SHARED.cases.length);
    SHARED.cases.forEach(({ description, name, preview }, at) => {
      expect(
        {
          name: shown.value[at]?.name ?? null,
          preview: shown.value[at]?.preview ?? null,
        },
        description,
      ).toEqual({ name, preview });
    });
  });
});
