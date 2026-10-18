import { afterEach, describe, expect, it } from "vitest";
import { clearFaults, setFault } from "../control/faults.js";
import { DiskReserve } from "./disk-space.js";

afterEach(() => {
  clearFaults();
});

describe("a reserve on a volume made to have a chosen room", () => {
  it("reads the room the fault sets, not the volume, until the fault is cleared", async () => {
    const reserve = new DiskReserve("/volume", 1000, () =>
      Promise.resolve(10_000_000),
    );
    (await reserve.admit(0)).close();
    setFault("free:blobs", "10");
    await expect(reserve.admit(0)).rejects.toMatchObject({
      details: { reserve_bytes: 1000, available_bytes: 10 },
    });
    setFault("free:database", "10");
    setFault("free:blobs", "10000000");
    (await reserve.admit(0)).close();
    clearFaults();
    (await reserve.admit(0)).close();
  });
});
