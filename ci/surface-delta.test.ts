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

  it("orders packages and names, whichever way the locks list them", () => {
    const deltas = surfaceDelta(
      {
        "@withmarfa/z": {
          hash: "h",
          exports: { y: "1", x: "1", m: "9", k: "9" },
        },
        "@withmarfa/a": { hash: "h", exports: { q: "1" } },
      },
      {
        "@withmarfa/z": {
          hash: "h",
          exports: { d: "1", c: "1", m: "1", k: "1" },
        },
        "@withmarfa/b": { hash: "h", exports: { f: "1", e: "1" } },
      },
    );
    expect(deltas.map((delta) => delta.pkg)).toEqual([
      "@withmarfa/a",
      "@withmarfa/b",
      "@withmarfa/z",
    ]);
    expect(deltas[1]?.removed).toEqual(["e", "f"]);
    expect(deltas[2]).toMatchObject({
      added: ["x", "y"],
      removed: ["c", "d"],
      changed: ["k", "m"],
    });
  });

  it("renders each list as the names, quoted, and says first only when it is", () => {
    const deltas = surfaceDelta(
      lock({ b: "2", a: "1", c: "3" }),
      lock({ c: "0" }),
    );
    const text = render(deltas, false);
    expect(text).toContain("Added: `a`, `b`");
    expect(text).toContain("Changed: `c`");
    expect(text).not.toContain("The first release");
  });
});
