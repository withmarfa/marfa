import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { LUCIDE_ICON_NAMES, LUCIDE_VERSION } from "./lucide-icons.js";
import { validateTypeSchema } from "./schema-validation.js";
import type { TypeSchema } from "./schema-types.js";

const parent: TypeSchema = {
  id: "acme.base",
  version: 1,
  fields: { name: { type: "string" }, text: { type: "string" } },
  display_hints: { title_field: "name" },
};
const validate = (data: unknown) =>
  validateTypeSchema(data, {
    resolveSchema: (id) => (id === parent.id ? parent : undefined),
  });
const type = (display_hints: unknown) => ({
  id: "acme.thing",
  fields: { name: { type: "string" } },
  display_hints,
});

describe("display_hints.icon", () => {
  it("takes a name the pinned Lucide release has, beside the other hints", () => {
    const result = validate(type({ title_field: "name", icon: "calendar" }));
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.display_hints).toEqual({
        title_field: "name",
        icon: "calendar",
      });
    }
  });

  it("takes an icon alone, where the hints above it name the title", () => {
    const result = validate({
      id: "acme.base.thing",
      parent: "acme.base",
      fields: {},
      display_hints: { icon: "box" },
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it("refuses a name the release does not have, naming the member", () => {
    for (const icon of [
      "Calendar", // wrong case
      "calendar_days", // wrong separator
      "CalendarDays", // Lucide's component name, not its icon name
      " calendar", // padded
      "github", // a brand icon Lucide removed
      "not-an-icon",
      "",
    ]) {
      const result = validate(type({ icon }));
      expect(result.success, `"${icon}" was taken`).toBe(false);
      if (!result.success) {
        expect(result.errors.map((error) => error.field)).toEqual([
          "display_hints.icon",
        ]);
      }
    }
    // The witness: the same icon, spelled as the release spells it.
    expect(validate(type({ icon: "calendar-days" })).success).toBe(true);
  });

  it("refuses a value that is not text", () => {
    for (const icon of [3, null, ["calendar"], { name: "calendar" }]) {
      const result = validate(type({ icon }));
      expect(result.success, JSON.stringify(icon)).toBe(false);
    }
  });

  it("is refused for what the other hints already refuse, and still checked per hint", () => {
    const result = validate(
      type({ title_field: "missing", body_field: "text", icon: "box" }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.map((error) => error.field).sort()).toEqual([
        "display_hints.body_field",
        "display_hints.title_field",
      ]);
    }
  });
});

describe("the pinned Lucide release", () => {
  const require = createRequire(import.meta.url);
  const installed = require.resolve("lucide/package.json");
  const folder = installed.replace(/package\.json$/, "");

  it("is the release the package.json pins, and the list is its names", () => {
    const pinned = (
      JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { devDependencies: Record<string, string> }
    ).devDependencies.lucide;
    expect(pinned).toBe(LUCIDE_VERSION);
    expect(
      (JSON.parse(readFileSync(installed, "utf8")) as { version: string })
        .version,
    ).toBe(LUCIDE_VERSION);
    const names = readdirSync(`${folder}dist/esm/icons`)
      .filter((file) => file.endsWith(".mjs"))
      .map((file) => file.slice(0, -".mjs".length))
      .sort();
    expect([...LUCIDE_ICON_NAMES]).toEqual(names);
  });

  it("holds each name once, in kebab case", () => {
    expect(new Set(LUCIDE_ICON_NAMES).size).toBe(LUCIDE_ICON_NAMES.length);
    for (const name of LUCIDE_ICON_NAMES) {
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});
