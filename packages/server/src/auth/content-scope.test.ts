/**
 * The content category is defined by the stored family, not by the name.
 *
 * **This file exists because the shipped set cannot tell the two apart.**
 * Every system type this build ships is named `system.something`, so a test
 * written against the compiled registry alone passes whether the exclusion
 * reads the family-backed `SYSTEM_TYPE_IDS` or a `system.` string prefix.
 * The distinction only becomes visible on a row whose family says `system`
 * and whose name says otherwise, and the platform seed path is what produces
 * one: `projectPlatformRows` pins a row whose `family` column this build
 * cannot read to `system`, and `seedPlatformTypes` refills the id set from
 * what the projection said.
 *
 * That is not a hypothetical row. It is a retired platform type, a row from
 * an archive, or a row written by a newer build and met by an older one
 * after a rollback — the three cases the projection was written for.
 *
 * The projection under test therefore has to run AFTER the seed, and the
 * precondition is asserted rather than assumed: a run in which the seed did
 * not take is a run in which the interesting case does not exist, and it
 * would pass for the wrong reason.
 *
 * **Only the exclusion direction is observable here, and a case written the
 * other way round proves nothing.** A type the seed adds as ordinary content
 * resolves to the granted level whether or not the seed ran, because the
 * category projects a global wildcard and an unknown id falls to it either
 * way — so such a case passes with its own `seedPlatformTypes` call deleted.
 * The seeded set is only visible where it decides an id OUT, which is what
 * the case below does; the inverse is closed by the `system.*` belt in the
 * projection rather than by the set, so no seed can open it. A case written
 * the other way round is not a second guard and should not be added as one:
 * it would name the seed and pass without it.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { MockInstance } from "vitest";
import {
  SYSTEM_TYPE_IDS,
  resolveTypePermission,
  scopesToTypePermissions,
  seedPlatformTypes,
  shippedPlatformTypes,
} from "@withmarfa/shared";
import type { TypeSchema } from "@withmarfa/shared";
import { projectPlatformRows } from "../storage/platform-family.js";
import type { LoadedType } from "../storage/interface.js";
import * as logger from "../middleware/logger.js";

/** A platform row whose family column holds a value no build can read. */
function unreadableFamilyRow(id: string): LoadedType {
  const schema: TypeSchema = { id, version: 1, fields: {} };
  return {
    space_id: "",
    schema,
    origin: "platform",
    family: "written-by-a-newer-build" as LoadedType["family"],
  };
}

let logSpy: MockInstance<typeof logger.log>;

beforeEach(() => {
  // The projection says so loudly, which is correct and is not what this
  // file is about.
  logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  // Put the registry back, because it is a module-level binding every other
  // suite in this process shares.
  seedPlatformTypes(shippedPlatformTypes());
  vi.restoreAllMocks();
});

describe("the content category excludes by family, not by name", () => {
  it("still excludes a platform row pinned to system by an unreadable column", () => {
    // `acme.widget` is deliberately nothing like `system.`: a `system.`
    // string prefix test cannot reach it, and the family-backed set can.
    const projected = projectPlatformRows([unreadableFamilyRow("acme.widget")]);
    expect(projected[0]?.family).toBe("system");
    seedPlatformTypes([...shippedPlatformTypes(), ...projected]);

    // The precondition, asserted rather than assumed. Without the seed
    // having taken, `SYSTEM_TYPE_IDS` holds the compiled shipped set and
    // this row does not exist, so the case below would pass for the wrong
    // reason.
    expect(SYSTEM_TYPE_IDS.has("acme.widget")).toBe(true);
    expect("acme.widget".startsWith("system.")).toBe(false);

    for (const level of ["read", "write"] as const) {
      const perms = scopesToTypePermissions([`content:${level}`]);
      expect(resolveTypePermission("acme.widget", perms), level).toBe("none");
      // And the category is otherwise intact, so the exclusion is an
      // exclusion rather than the whole projection having gone empty.
      expect(resolveTypePermission("core.note", perms), level).toBe(level);
    }
  });

  it("keeps every shipped system type out either way", () => {
    // The plain case, kept because it is the one a reader looks for first.
    // On its own it proves nothing about family versus name — every id here
    // is under `system.` — which is what the first case exists to cover.
    const perms = scopesToTypePermissions(["content:read"]);
    expect(SYSTEM_TYPE_IDS.size).toBeGreaterThan(0);
    for (const id of SYSTEM_TYPE_IDS) {
      expect(resolveTypePermission(id, perms), id).toBe("none");
    }
    expect(logSpy).not.toHaveBeenCalled();
  });
});
