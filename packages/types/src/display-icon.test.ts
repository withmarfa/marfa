import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ICON_SETS, isIconId, lucideIconId } from "./icon-sets.js";
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

interface IconifyData {
  icons: Record<string, { hidden?: boolean }>;
  aliases?: Record<string, { parent: string }>;
}

const require = createRequire(import.meta.url);
const installed = (prefix: string) => {
  const manifest = require.resolve(`@iconify-json/${prefix}/package.json`);
  const folder = manifest.replace(/package\.json$/, "");
  return {
    version: (JSON.parse(readFileSync(manifest, "utf8")) as { version: string })
      .version,
    data: JSON.parse(
      readFileSync(`${folder}icons.json`, "utf8"),
    ) as IconifyData,
  };
};

describe("display_hints.icon", () => {
  it("takes an icon ID from each accepted set, beside the other hints", () => {
    for (const icon of ["lucide:calendar", "simple-icons:github"]) {
      const result = validate(type({ title_field: "name", icon }));
      expect(result.success, JSON.stringify(result)).toBe(true);
      if (result.success) {
        expect(result.data.display_hints).toEqual({
          title_field: "name",
          icon,
        });
      }
    }
  });

  it("takes an icon alone, where the hints above it name the title", () => {
    const result = validate({
      id: "acme.base.thing",
      parent: "acme.base",
      fields: {},
      display_hints: { icon: "lucide:box" },
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it("refuses anything but an ID from a pinned set's icons, naming the member", () => {
    const lucide = installed("lucide").data;
    const alias = Object.keys(lucide.aliases ?? {})[0];
    const hidden = Object.entries(lucide.icons).find(([, icon]) => icon.hidden);
    expect(alias, "the pinned Lucide data has no alias").toBeDefined();
    expect(hidden, "the pinned Lucide data has no hidden icon").toBeDefined();
    for (const icon of [
      "calendar", // a bare name
      "github", // a bare name from another set
      "lucide:Calendar", // wrong case
      "Lucide:calendar", // wrong case in the set
      "lucide:calendar_days", // wrong separator
      "lucide:not-an-icon", // not in the set
      "lucide:github", // in another set, not this one
      "simple-icons:calendar", // in another set, not this one
      `lucide:${String(alias)}`, // an alias of an icon
      `lucide:${String(hidden?.[0])}`, // an icon the set has removed
      "mdi:calendar", // a set Marfa does not accept
      "lucide:", // no name
      ":calendar", // no set
      "lucide:calendar:days", // two separators
      " lucide:calendar", // padded
      "lucide:calendar ",
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
    // The witness: the same icons, written as IDs from the pinned sets.
    expect(validate(type({ icon: "lucide:calendar-days" })).success).toBe(true);
    expect(validate(type({ icon: "simple-icons:github" })).success).toBe(true);
  });

  it("tells a caller who sends a bare name which ID to send", () => {
    const result = validate(type({ icon: "calendar-days" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]?.hint).toContain('"lucide:calendar-days"');
    }
  });

  it("refuses a value that is not text", () => {
    for (const icon of [3, null, ["lucide:calendar"], { name: "calendar" }]) {
      const result = validate(type({ icon }));
      expect(result.success, JSON.stringify(icon)).toBe(false);
    }
  });

  it("is refused for what the other hints already refuse, and still checked per hint", () => {
    const result = validate(
      type({ title_field: "missing", body_field: "text", icon: "lucide:box" }),
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

describe("lucideIconId", () => {
  it("names the icon a bare name stands for, following a rename, and nothing else", () => {
    expect(lucideIconId("calendar")).toBe("lucide:calendar");
    expect(lucideIconId("bold")).toBe("lucide:letter-b");
    expect(lucideIconId("archive-restore")).toBe("lucide:archive-arrow-up");
    expect(lucideIconId("circle-parking-off")).toBe(
      "lucide:circle-letter-p-off",
    );
    expect(lucideIconId("square-parking-off")).toBe(
      "lucide:square-letter-p-off",
    );
    for (const name of [
      "indent",
      "album",
      "no-such-icon",
      "Bold",
      "toString",
    ]) {
      expect(lucideIconId(name), name).toBeUndefined();
    }
    // The ID it gives is an accepted one; the alias it came from is not.
    expect(isIconId(String(lucideIconId("bold")))).toBe(true);
    expect(isIconId("lucide:bold")).toBe(false);
  });
});

describe("the pinned icon sets", () => {
  const pins = (
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { devDependencies: Record<string, string> }
  ).devDependencies;

  it("are lucide and simple-icons", () => {
    expect(ICON_SETS.map((set) => set.prefix)).toEqual([
      "lucide",
      "simple-icons",
    ]);
  });

  for (const set of ICON_SETS) {
    describe(set.prefix, () => {
      it("is the version the package.json pins, and the list is its icons", () => {
        expect(set.package).toBe(`@iconify-json/${set.prefix}`);
        expect(pins[set.package]).toBe(set.version);
        const { version, data } = installed(set.prefix);
        expect(version).toBe(set.version);
        const icons = Object.entries(data.icons)
          .filter(([, icon]) => icon.hidden !== true)
          .map(([name]) => name)
          .sort();
        expect([...set.icons]).toEqual(icons);
      });

      it("holds each name once, in kebab case, and no alias", () => {
        expect(new Set(set.icons).size).toBe(set.icons.length);
        for (const name of set.icons) {
          expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        }
        const aliases = Object.keys(installed(set.prefix).data.aliases ?? {});
        expect(aliases.filter((alias) => set.icons.includes(alias))).toEqual(
          [],
        );
      });

      it("maps each alias to the listed icon it resolves to, and no other", () => {
        const { aliases } = installed(set.prefix).data;
        const resolved = (alias: string): string => {
          let name = alias;
          for (let a = aliases?.[name]; a; a = aliases?.[name]) name = a.parent;
          return name;
        };
        const expected: Record<string, string> = {};
        for (const alias of Object.keys(aliases ?? {}).sort()) {
          const icon = resolved(alias);
          if (set.icons.includes(icon)) expected[alias] = icon;
        }
        expect({ ...set.aliases }).toEqual(expected);
        expect(Object.keys(set.aliases).length).toBeGreaterThan(0);
      });
    });
  }
});

describe("the core types' icons", () => {
  const core = new URL("../core/", import.meta.url);
  const files = readdirSync(core, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".json"),
  );

  it("are each in its set's pinned list", () => {
    const used = files.flatMap((file) => {
      const schema = JSON.parse(readFileSync(new URL(file, core), "utf8")) as {
        display_hints?: { icon?: string };
      };
      const icon = schema.display_hints?.icon;
      return icon === undefined ? [] : [[file, icon] as const];
    });
    // The witness: the core types do set icons.
    expect(used.length).toBeGreaterThan(20);
    for (const [file, icon] of used) {
      const result = validate({
        id: "acme.thing",
        fields: {},
        display_hints: { icon },
      });
      expect(result.success, `${file} uses "${icon}"`).toBe(true);
      expect(icon, file).toMatch(/^lucide:/);
    }
  });
});
