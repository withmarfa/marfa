import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogueTables } from "../conformance/scripts/catalogue-sources.js";
import {
  CATALOGUES,
  CATALOGUE_CHAPTER,
  withTable,
} from "../conformance/src/utils/catalogue-tables.js";
import {
  ALL_EDGE_TYPES,
  ALL_SYSTEM_TYPES,
  ALL_TYPES,
} from "../packages/types/src/index.js";
import { PERMISSIONS } from "../packages/shared/src/scopes.js";
import { WEBHOOK_EVENTS } from "../packages/server/src/routes/webhooks.js";

const chapter = (name: (typeof CATALOGUES)[number]) =>
  readFileSync(
    new URL(`../conformance/spec/${CATALOGUE_CHAPTER[name]}`, import.meta.url),
    "utf8",
  );

/**
 * The contract's catalogues are written from the server's own definitions by
 * `conformance/scripts/catalogue-tables.ts`: the shipped types and edge types
 * in `packages/types`, the permission list in `packages/shared` and the
 * event names in the server's webhook vocabulary and the stream's frame
 * schema. A definition added, removed or changed changes its table, so one
 * that was not rewritten is stale in the contract. Compared as text, because
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
    expect(ALL_TYPES.length).toBeGreaterThan(15);
    expect(ALL_SYSTEM_TYPES.length).toBeGreaterThan(0);
    for (const { id } of [...ALL_TYPES, ...ALL_SYSTEM_TYPES]) {
      expect(rows("types"), id).toContain(`| \`${id}\` `);
    }
    expect(ALL_EDGE_TYPES.length).toBe(10);
    for (const { id } of ALL_EDGE_TYPES) {
      expect(rows("edge-types"), id).toContain(`| \`${id}\` `);
    }
    expect(PERMISSIONS).toHaveLength(12);
    for (const name of PERMISSIONS) {
      expect(rows("permissions"), name).toContain(`| \`${name}\` `);
    }
    expect(WEBHOOK_EVENTS.length).toBeGreaterThan(9);
    for (const name of WEBHOOK_EVENTS) {
      expect(rows("event-types"), name).toContain(`| \`${name}\` `);
    }
  });
});
