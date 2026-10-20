import { describe, expect, it } from "vitest";
import { restoreSummary } from "./restore-words.js";

const none = {
  imported: 0,
  duplicates: 0,
  edges_imported: 0,
  blobs_imported: 0,
  blobs_missing: [],
  types_registered: 0,
  edge_types_registered: 0,
};

describe("restoreSummary", () => {
  it("counts what was added and what was already here", () => {
    expect(
      restoreSummary({
        ...none,
        imported: 3,
        duplicates: 1,
        edges_imported: 1,
        blobs_imported: 2,
        types_registered: 1,
        edge_types_registered: 1,
      }),
    ).toBe("3 items added, 1 already here. 1 link, 2 files and 2 types added.");
  });

  it("says so, and only then, when a file is in neither the export nor the instance", () => {
    expect(restoreSummary(none)).not.toContain("neither");
    expect(restoreSummary({ ...none, blobs_missing: ["sha256:a"] })).toContain(
      "1 file named in the export is neither in it nor here.",
    );
  });
});
