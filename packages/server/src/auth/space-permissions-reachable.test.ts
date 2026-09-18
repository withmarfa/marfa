/**
 * A space permission is requestable, and is granted only by being named.
 *
 * **Two properties that pull in opposite directions, which is why they are
 * tested together.** Until now the family was unreachable: `buildAllowedScopes`
 * emitted no space permission literal and the bundle door dropped any a
 * configuration named, so an authorization request naming one was refused
 * `invalid_scope`. That made the family safe by making it useless — no route
 * could gate on a space permission nobody could hold.
 *
 * Publishing the family is what makes the gate possible. What must not come
 * with it is the thing the withholding was standing in for: a space permission
 * arriving pre-ticked, or arriving through a bundle that claims it. Those are
 * now two separate guards rather than one, and the drop is no longer visible
 * in the allowlist's output, so it needs asserting where it still shows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { PermissionBundle } from "@withmarfa/shared";
import { SPACE_PERMISSIONS, requiresExplicitConsent } from "@withmarfa/shared";
import * as logger from "../middleware/logger.js";
import { buildAllowedScopes } from "./oauth-provider.js";
import { bundlePublishedScopes } from "./ceiling-catchup.js";
import { resetWithheldScopeWarnings } from "./allowlist-withholding.js";
import { DEFAULT_PERMISSION_BUNDLES } from "../config.js";

/** A bundle of the shape `MARFA_PERMISSION_BUNDLES` produces, naming a
 *  space permission — the configuration that can carry the defect. */
const CLAIMING_BUNDLE: PermissionBundle = {
  id: "operator-custom",
  label: "Operator custom",
  description: "Configured, not shipped.",
  scopes: ["core.note:read", "space.keys"],
  default_on: true,
};

let logSpy: MockInstance<typeof logger.log>;

beforeEach(() => {
  resetWithheldScopeWarnings();
  logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
});

describe("the allowlist publishes the space permission family", () => {
  it("emits every space permission literal, so a client can ask for one", () => {
    const scopes = new Set(buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES));
    for (const literal of SPACE_PERMISSIONS) {
      expect(scopes.has(literal), literal).toBe(true);
    }
  });

  it("emits them from the closed set rather than from a bundle", () => {
    // Asked with no bundles at all: a space permission's reachability must not
    // depend on a configuration naming it, or an operator who ships none
    // has an instance whose gates can never be satisfied.
    const scopes = new Set(buildAllowedScopes([]));
    for (const literal of SPACE_PERMISSIONS) {
      expect(scopes.has(literal), literal).toBe(true);
    }
  });
});

describe("a bundle still cannot be the reason one is publishable", () => {
  it("drops it from the ceiling a stale client is widened by", () => {
    // The door that still shows the drop. This set is written into a stored
    // registration row, where a literal outlives the configuration that
    // introduced it — and a row is not re-derived at boot the way the
    // allowlist is.
    expect(bundlePublishedScopes([CLAIMING_BUNDLE]).has("space.keys")).toBe(
      false,
    );
    expect(bundlePublishedScopes([CLAIMING_BUNDLE]).has("core.note:read")).toBe(
      true,
    );
  });

  it("logs the refusal, naming the scope", () => {
    buildAllowedScopes([CLAIMING_BUNDLE]);
    const named = logSpy.mock.calls.filter(
      ([level, , data]) =>
        level === "warn" &&
        (data as { scope?: string } | undefined)?.scope === "space.keys",
    );
    expect(named.length).toBeGreaterThanOrEqual(1);
  });

  it("no shipped bundle names a space permission", () => {
    // The property the gate rests on, pinned rather than remembered: a
    // space permission inside a default-on bundle would arrive ticked at every
    // consent, which is the grant-by-silence the family exists to stop.
    for (const bundle of DEFAULT_PERMISSION_BUNDLES) {
      for (const scope of bundle.scopes) {
        expect(requiresExplicitConsent(scope), `${bundle.id}: ${scope}`).toBe(
          false,
        );
      }
    }
  });
});
