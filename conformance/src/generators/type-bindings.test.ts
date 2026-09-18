/**
 * Binds this suite's fixture type identifiers to the platform type registry.
 *
 * `@withmarfa/shared` is read here as a spec artifact rather than as an
 * implementation: the only thing taken from it is `ALL_TYPE_IDS`, the list of
 * registered type identifiers. Nothing in `src/generators/` or `src/suites/`
 * imports it, so the suite still exercises a server over HTTP alone and the
 * no-implementation-imports rule stands.
 *
 * It resolves to the workspace package, so a commit that changes the registry
 * and leaves a fixture behind reddens in its own pull request rather than as a
 * puzzling `unknown_type` from a server during a conformance run. This test
 * needs no server and runs in `test:generators`.
 */

import { describe, it, expect } from "vitest";
import { ALL_TYPE_IDS } from "@withmarfa/shared";
import * as itemGenerators from "./items.js";
import { PROFILES } from "../suites/load/profiles.js";

const REGISTERED = new Set<string>(ALL_TYPE_IDS);

/**
 * Namespace roots the platform owns, derived from the registry rather than
 * listed by hand so a new publisher namespace is covered the moment it ships.
 * A type outside these roots is invented by this suite and is not the
 * registry's to account for.
 */
const PLATFORM_ROOTS = new Set<string>(
  ALL_TYPE_IDS.map((id) => id.split(".")[0]!),
);

function isPlatformType(typeId: string): boolean {
  return PLATFORM_ROOTS.has(typeId.split(".")[0]!);
}

/**
 * Every item generator, discovered by reflection rather than by an
 * enumeration that a new generator could be added without joining. The
 * generators take an overrides object and return a `CreateItemInput`; the
 * module's other exports are id and timestamp helpers, which either return a
 * string or reject the object argument outright. Both are filtered out here:
 * a throw means the export does not take overrides, so it is not a generator.
 */
function emittedTypes(): Array<{ generator: string; type: string }> {
  const emitted: Array<{ generator: string; type: string }> = [];

  for (const [name, exported] of Object.entries(itemGenerators)) {
    if (typeof exported !== "function") continue;

    let produced: unknown;
    try {
      produced = (exported as (o?: object) => unknown)({});
    } catch {
      continue;
    }

    if (
      typeof produced !== "object" ||
      produced === null ||
      typeof (produced as { type?: unknown }).type !== "string"
    ) {
      continue;
    }

    emitted.push({
      generator: name,
      type: (produced as { type: string }).type,
    });
  }

  return emitted;
}

describe("generator type bindings", () => {
  it("discovers the item generators", () => {
    // Reflection silently finding nothing would make every assertion below
    // vacuously pass, so the discovery itself is asserted.
    expect(emittedTypes().length).toBeGreaterThan(15);
  });

  it("every generated type is registered in the platform registry", () => {
    const unregistered = emittedTypes().filter(
      ({ type }) => !REGISTERED.has(type),
    );

    expect(
      unregistered,
      `generators emit type identifiers absent from the pinned registry: ${unregistered
        .map(({ generator, type }) => `${generator} -> ${type}`)
        .join(", ")}`,
    ).toEqual([]);
  });

  it("every generated type sits in a platform namespace", () => {
    // A fixture that quietly drifted into an unregistered namespace would pass
    // the registry check above only by being exempted from it.
    const foreign = emittedTypes().filter(({ type }) => !isPlatformType(type));

    expect(foreign).toEqual([]);
  });

  it("load profiles distribute over registered types", () => {
    // Every id in a profile has to be registered, with no exemption for
    // suite-owned namespaces: nothing registers a type at run time, so an id
    // the registry does not carry cannot be written.
    const seen: string[] = [];
    const unregistered: string[] = [];

    for (const profile of Object.values(PROFILES)) {
      for (const typeId of Object.keys(profile.typeDistribution)) {
        seen.push(typeId);
        if (!REGISTERED.has(typeId)) {
          unregistered.push(`${profile.name} -> ${typeId}`);
        }
      }
    }

    // A profile set that quietly emptied would satisfy the check below by
    // having nothing to check.
    expect(seen.length).toBeGreaterThan(10);
    expect(unregistered).toEqual([]);
  });
});
