import { describe, expect, it } from "vitest";
import { compareTimes, summaryTable } from "./shard-drift.js";

const weights: Record<string, number> = {
  "src/a.test.ts": 100,
  "src/b.test.ts": 100,
  "src/c.test.ts": 100,
  "src/small.test.ts": 5,
};
const weigh = (path: string) => weights[path] ?? 5;

describe("comparing measured times with the weights", () => {
  const rows = compareTimes(
    {
      "src/a.test.ts": 140,
      "src/b.test.ts": 160,
      "src/c.test.ts": 40,
      "src/small.test.ts": 12,
      "src/new.test.ts": 75,
      "src/new-small.test.ts": 9,
    },
    weigh,
  );
  const drifted = (path: string) =>
    rows.find((row) => row.path === path)?.drifted;

  it("leaves a file within half its weight alone", () => {
    expect(drifted("src/a.test.ts")).toBe(false);
  });

  it("flags a file slower or faster than half its weight", () => {
    expect(drifted("src/b.test.ts")).toBe(true);
    expect(drifted("src/c.test.ts")).toBe(true);
  });

  it("flags a slow file nobody weighed", () => {
    expect(drifted("src/new.test.ts")).toBe(true);
  });

  it("leaves small files alone, however far apart the numbers are", () => {
    expect(drifted("src/small.test.ts")).toBe(false);
    expect(drifted("src/new-small.test.ts")).toBe(false);
  });

  it("lists the slowest file first", () => {
    expect(rows.map((row) => row.path)[0]).toBe("src/b.test.ts");
  });

  it("puts the drifted and the slow files in the summary and leaves the rest out", () => {
    const table = summaryTable(rows);
    expect(table).toContain("`src/b.test.ts` | 100 | 160 | drifted");
    expect(table).toContain("`src/small.test.ts` | 5 | 12 |");
    expect(table).not.toContain("new-small");
  });
});
