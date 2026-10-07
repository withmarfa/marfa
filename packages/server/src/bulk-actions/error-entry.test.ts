import { describe, expect, it } from "vitest";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { toErrorEntry } from "./runner.js";

describe("a bulk action's error entry", () => {
  it("carries a code the error table holds", () => {
    expect(
      toErrorEntry("01J", new MarfaError(ErrorCode.ITEM_NOT_FOUND, "gone")),
    ).toMatchObject({ id: "01J", code: "item_not_found" });
    const conflict = Object.assign(new Error("taken"), {
      code: "version_conflict",
    });
    expect(toErrorEntry("01J", conflict).code).toBe("version_conflict");
  });

  it("answers a driver's or a transaction's own code as internal_error", () => {
    const closed = Object.assign(new Error("transaction closed"), {
      code: "TRANSACTION_CLOSED",
    });
    expect(toErrorEntry("01J", closed)).toMatchObject({
      id: "01J",
      code: "internal_error",
    });
    const driver = Object.assign(new Error("disk I/O error"), {
      code: "SQLITE_IOERR",
    });
    expect(toErrorEntry("01J", driver).code).toBe("internal_error");
  });
});
