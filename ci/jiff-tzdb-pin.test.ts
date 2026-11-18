/**
 * The core and the Swift crate are two workspaces with two lockfiles, and
 * both bundle the time zone database that `jiff-tzdb` carries. A zone rule
 * that differs between a Mac app and the server would put the same series on
 * two days, so the two lockfiles must pin the same `jiff-tzdb`. Dependabot
 * moves each lockfile on its own, so this test fails when one moves alone.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface LockedPackage {
  name: string;
  version: string;
  dependencies?: string[];
}

/** The `jiff-tzdb` version the one `jiff` 1.x of a lockfile depends on. */
function tzdbOfJiff(lock: string): string {
  const { package: packages } = parseToml(lock) as unknown as {
    package: LockedPackage[];
  };
  const jiffs = packages.filter(
    (p) => p.name === "jiff" && p.version.startsWith("1."),
  );
  expect(jiffs, "one jiff 1.x package").toHaveLength(1);
  const entries = (jiffs[0]?.dependencies ?? []).filter(
    (dependency) =>
      dependency === "jiff-tzdb" || dependency.startsWith("jiff-tzdb "),
  );
  expect(entries, "jiff 1.x depends on jiff-tzdb").toHaveLength(1);
  // A lockfile names the version only when it holds more than one package of
  // that name.
  const [, named] = entries[0]!.split(" ");
  if (named !== undefined) return named;
  const tzdbs = packages.filter((p) => p.name === "jiff-tzdb");
  expect(tzdbs, "one jiff-tzdb package").toHaveLength(1);
  return tzdbs[0]!.version;
}

function lockfile(...path: string[]): string {
  return readFileSync(join(ROOT, ...path), "utf8");
}

const lock = (
  jiff: string,
  tzdbs: Record<string, string>,
  depends: string,
): string =>
  [
    "[[package]]",
    'name = "jiff"',
    `version = "${jiff}"`,
    `dependencies = ["jiff-core", "${depends}"]`,
    ...Object.entries(tzdbs).flatMap(([version, name]) => [
      "[[package]]",
      `name = "${name}"`,
      `version = "${version}"`,
    ]),
  ].join("\n");

describe("the time zone database the core and the Swift crate bundle", () => {
  it("is the same jiff-tzdb in both lockfiles", () => {
    expect(
      tzdbOfJiff(lockfile("core", "bindings", "swift", "Cargo.lock")),
    ).toBe(tzdbOfJiff(lockfile("core", "Cargo.lock")));
  });

  describe("the reading of a lockfile", () => {
    it("names the version a lockfile with one jiff-tzdb leaves out", () => {
      expect(
        tzdbOfJiff(lock("1.0.1", { "1.0.0": "jiff-tzdb" }, "jiff-tzdb")),
      ).toBe("1.0.0");
    });

    it("takes the jiff-tzdb of jiff 1.x when jiff 0.2 holds another", () => {
      const both = [
        lock("1.0.1", { "1.0.0": "jiff-tzdb" }, "jiff-tzdb 1.0.0"),
        lock("0.2.39", { "0.1.9": "jiff-tzdb" }, "jiff-tzdb-platform"),
      ].join("\n");
      expect(tzdbOfJiff(both)).toBe("1.0.0");
    });

    it("sees two lockfiles that pin different versions", () => {
      const a = tzdbOfJiff(
        lock("1.0.1", { "1.0.0": "jiff-tzdb" }, "jiff-tzdb"),
      );
      const b = tzdbOfJiff(
        lock("1.0.2", { "1.0.1": "jiff-tzdb" }, "jiff-tzdb"),
      );
      expect(a).not.toBe(b);
    });
  });
});
