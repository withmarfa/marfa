import { describe, expect, it } from "vitest";
import {
  render,
  surfaceDelta,
  type Lock,
} from "../scripts/release/surface-delta.js";

const lock = (exports: Record<string, string>): Lock => ({
  "@withmarfa/client": { hash: "h", exports },
});

describe("the surface delta a release carries", () => {
  it("names the exports a release added, removed and changed", () => {
    const deltas = surfaceDelta(
      lock({ kept: "1", moved: "2", added: "3" }),
      lock({ kept: "1", moved: "0", gone: "4" }),
    );
    expect(deltas).toEqual([
      {
        pkg: "@withmarfa/client",
        status: "changed",
        added: ["added"],
        removed: ["gone"],
        changed: ["moved"],
      },
    ]);
  });

  it("reports nothing for a surface that did not move", () => {
    const same = lock({ a: "1" });
    expect(surfaceDelta(same, same)).toEqual([]);
    expect(render([], false)).toContain(
      "Nothing on the published surface moved.",
    );
  });

  it("reads the first release as every export new", () => {
    const deltas = surfaceDelta(lock({ b: "2", a: "1" }), {});
    expect(deltas[0]?.status).toBe("added");
    expect(deltas[0]?.added).toEqual(["a", "b"]);
    expect(render(deltas, true)).toContain("The first release");
  });

  it("names a package that left the published set", () => {
    const deltas = surfaceDelta({}, lock({ a: "1" }));
    expect(deltas[0]).toMatchObject({ status: "removed", removed: ["a"] });
  });
});
