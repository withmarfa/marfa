import { describe, expect, it } from "vitest";
import { rowOf } from "./table-data.js";
import { BatchLedger } from "./table-stream.js";

const ITEM = "item-1";
const frameOf = (batch: string, ids: string[], over: object = {}) => ({
  item: { id: ITEM, type: "user.t", source: "s" },
  table: "readings",
  batch,
  rows: ids.map((id, n) => ({ id, values: rowOf(n, 1) })),
  ...over,
});

describe("BatchLedger", () => {
  it("matches each written batch to its frame whichever came first, and records the lag", () => {
    const ledger = new BatchLedger(ITEM, "readings", 1);
    ledger.written("b1", ["a", "b"], 100);
    ledger.frame(frameOf("b1", ["b", "a"]), 130);
    ledger.frame(frameOf("b2", ["c"]), 200);
    ledger.written("b2", ["c"], 210);
    ledger.finish();
    expect(ledger.problems).toEqual([]);
    expect(ledger.lags).toEqual([30, 0]);
    expect(ledger.batches).toBe(2);
  });

  it("names a written batch that no frame reached, and a frame no write made", () => {
    const ledger = new BatchLedger(ITEM, "readings", 1);
    ledger.written("lost", ["a"], 1);
    ledger.frame(frameOf("extra", ["z"]), 2);
    ledger.finish();
    expect(ledger.problems.join("\n")).toMatch(/lost was written and no frame/);
    expect(ledger.problems.join("\n")).toMatch(
      /extra reached the stream and no write/,
    );
  });

  it("names a frame whose rows are not the rows written, and one that came twice", () => {
    const ledger = new BatchLedger(ITEM, "readings", 1);
    ledger.written("b1", ["a", "b"], 1);
    ledger.frame(frameOf("b1", ["a", "x"]), 2);
    ledger.frame(frameOf("b1", ["a", "b"]), 3);
    expect(ledger.problems.join("\n")).toMatch(/differ/);
    expect(ledger.problems.join("\n")).toMatch(/more than one frame/);
  });

  it("names the wrong table, values never written, a deleted row and a frame with no item", () => {
    const ledger = new BatchLedger(ITEM, "readings", 1);
    ledger.frame(frameOf("b1", ["a"], { table: "other" }), 1);
    ledger.frame(
      frameOf("b2", ["a"], { rows: [{ id: "a", values: { note: "x" } }] }),
      1,
    );
    ledger.frame(
      frameOf("b3", ["a"], { rows: [{ id: "a", deleted: true }] }),
      1,
    );
    ledger.frame({ batch: "b4", rows: [] }, 1);
    const text = ledger.problems.join("\n");
    expect(text).toMatch(/names table "other"/);
    expect(text).toMatch(/never written/);
    expect(text).toMatch(/was deleted/);
    expect(text).toMatch(/names no item/);
  });

  it("takes ids alone where the frame says its values were left out, and ignores other items", () => {
    const ledger = new BatchLedger(ITEM, "readings", 1);
    ledger.written("b1", ["a"], 1);
    ledger.frame(
      frameOf("b1", ["a"], { values_included: false, rows: [{ id: "a" }] }),
      2,
    );
    ledger.frame(frameOf("o", ["q"], { item: { id: "other-item" } }), 3);
    ledger.finish();
    expect(ledger.problems).toEqual([]);
  });
});
