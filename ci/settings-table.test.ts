import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeSettings } from "../packages/server/src/config.js";
import { withSettingsTable } from "../conformance/src/utils/settings-table.js";

const CHAPTER = new URL("../conformance/spec/instance.md", import.meta.url);

/**
 * The instance chapter's settings table is written from the server's
 * settings schema by `conformance/scripts/settings-table.ts`. A setting
 * added, removed, rebounded or redescribed in `packages/server/src/config.ts`
 * changes the table, so one that was not rewritten is stale in the
 * contract. Compared as text, because the table is text a reader sees.
 */
describe("the settings table in the instance chapter", () => {
  it("is what the settings schema produces", () => {
    const committed = readFileSync(CHAPTER, "utf8");
    expect(
      committed,
      "Run `pnpm --filter @withmarfa/conformance exec tsx scripts/settings-table.ts` and commit the result.",
    ).toBe(withSettingsTable(committed, describeSettings()));
  });

  it("holds every setting the schema describes, so the comparison above cannot pass on an empty table", () => {
    const committed = readFileSync(CHAPTER, "utf8");
    const settings = describeSettings();
    expect(settings.length).toBeGreaterThan(90);
    for (const { name } of settings) {
      expect(committed, name).toContain(`| \`${name}\` `);
    }
  });
});
