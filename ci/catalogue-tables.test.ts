import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  catalogueTables,
  permissionNames,
  shippedCatalog,
  webhookEvents,
} from "../conformance/scripts/catalogue-sources.js";
import {
  CATALOGUES,
  CATALOGUE_CHAPTER,
  withTable,
} from "../conformance/src/utils/catalogue-tables.js";

const chapter = (name: (typeof CATALOGUES)[number]) =>
  readFileSync(
    new URL(`../conformance/spec/${CATALOGUE_CHAPTER[name]}`, import.meta.url),
    "utf8",
  );

/**
 * The contract's catalogues are written from the server's own definitions by
 * `conformance/scripts/catalogue-tables.ts`: the shipped types and edge types
 * in the rules crate's `builtin_catalog.json`, and the permission list, the
 * event names in the webhook vocabulary and the stream's frame schema in
 * `openapi.json`. A definition added, removed or changed changes its table, so
 * one that was not rewritten is stale in the contract. Compared as text, because
 * the table is text a reader sees.
 */
describe("the catalogues in the contract", () => {
  const tables = catalogueTables();

  for (const name of CATALOGUES) {
    it(`hold the ${name} table the server's definitions produce`, () => {
      const committed = chapter(name);
      expect(
        committed,
        "Run `pnpm --filter @withmarfa/conformance exec tsx scripts/catalogue-tables.ts` and commit the result.",
      ).toBe(withTable(committed, name, tables[name]));
    });
  }

  it("list every definition they are written from, so the comparisons above cannot pass on an empty table", () => {
    const rows = (name: (typeof CATALOGUES)[number]) => chapter(name);
    const { types, edgeTypes } = shippedCatalog();
    expect(
      types.filter(({ id }) => !id.startsWith("system.")).length,
    ).toBeGreaterThan(15);
    expect(
      types.filter(({ id }) => id.startsWith("system.")).length,
    ).toBeGreaterThan(0);
    for (const { id } of types) {
      expect(rows("types"), id).toContain(`| \`${id}\` `);
    }
    expect(edgeTypes.length).toBe(11);
    for (const { id } of edgeTypes) {
      expect(rows("edge-types"), id).toContain(`| \`${id}\` `);
    }
    const permissions = permissionNames();
    expect(permissions).toHaveLength(15);
    for (const name of permissions) {
      expect(rows("permissions"), name).toContain(`| \`${name}\` `);
    }
    const events = webhookEvents();
    expect(events.length).toBeGreaterThan(9);
    for (const name of events) {
      expect(rows("event-types"), name).toContain(`| \`${name}\` `);
    }
  });

  // A type under a permission's root would read as that permission in a
  // scope, so the core refuses to register one.
  it("reserve the root of every permission as a type root", () => {
    const catalog = JSON.parse(
      readFileSync(
        new URL(
          "../core/marfa-rules/src/builtin_catalog.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { reserved_type_roots: string[] };
    const roots = new Set(catalog.reserved_type_roots);
    expect(roots.size).toBeGreaterThan(0);
    for (const name of permissionNames()) {
      expect(roots, name).toContain(name.split(".")[0]);
    }
  });
});
