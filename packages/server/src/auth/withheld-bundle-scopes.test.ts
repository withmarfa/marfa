/**
 * A configured permission bundle cannot publish a scope this server withholds.
 *
 * The allowlist is assembled from registry keys and is well-formed by
 * construction. A bundle's scopes are configuration: `MARFA_PERMISSION_BUNDLES`
 * parses arbitrary JSON and validates shape only, so the bundle loop is the one
 * way into the allowlist that does not pass a parser. It filtered on
 * `isValidScope` alone — which answers whether the grammar recognizes a literal,
 * not whether this server is willing to publish it.
 *
 * **Every case here uses a CONFIGURED bundle rather than the shipped
 * defaults**, which is the population that can actually carry the defect. The
 * defaults name no capability literal and never did, so a suite written against
 * them would pass whether or not the drop exists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { PermissionBundle } from "@withmarfa/shared";
import { isValidScope, CAPABILITY_SCOPES } from "@withmarfa/shared";
import * as logger from "../middleware/logger.js";
import { buildAllowedScopes } from "./oauth-provider.js";
import { bundlePublishedScopes } from "./ceiling-catchup.js";
import {
  isWithheldFromAllowlist,
  resetWithheldScopeWarnings,
} from "./allowlist-withholding.js";
import { DEFAULT_PERMISSION_BUNDLES } from "../config.js";

/** An operator's bundle, of the shape `MARFA_PERMISSION_BUNDLES` produces. */
const OPERATOR_BUNDLE: PermissionBundle = {
  id: "operator-custom",
  label: "Operator custom",
  description: "Configured, not shipped.",
  scopes: ["core.note:read", "capability.keys", "metadata.types:write"],
  default_on: false,
};

let logSpy: MockInstance<typeof logger.log>;

beforeEach(() => {
  resetWithheldScopeWarnings();
  logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
});

describe("a configured bundle cannot publish a withheld scope", () => {
  it("is built on a literal the grammar accepts, or it proves nothing", () => {
    // The precondition, stated rather than assumed: this defect exists only
    // because a capability literal is grammatically valid. If `isValidScope`
    // ever starts refusing it, every case below passes for the wrong reason.
    expect(isValidScope("capability.keys")).toBe(true);
    expect(isWithheldFromAllowlist("capability.keys")).toBe(true);
  });

  it("drops it from the OAuth scope allowlist", () => {
    const scopes = new Set(buildAllowedScopes([OPERATOR_BUNDLE]));
    expect(scopes.has("capability.keys")).toBe(false);
  });

  it("drops it from the ceiling a stale client is widened by", () => {
    // The subtler of the two doors: this set is what a stored registration row
    // is widened by, so a literal admitted here outlives the configuration
    // that introduced it.
    expect(
      bundlePublishedScopes([OPERATOR_BUNDLE]).has("capability.keys"),
    ).toBe(false);
  });

  it("keeps the bundle's other scopes, so the drop is per scope", () => {
    const scopes = new Set(buildAllowedScopes([OPERATOR_BUNDLE]));
    expect(scopes.has("core.note:read")).toBe(true);
    expect(scopes.has("metadata.types:write")).toBe(true);
  });

  it("logs the refusal, naming the scope", () => {
    buildAllowedScopes([OPERATOR_BUNDLE]);
    const named = logSpy.mock.calls.filter(
      ([level, , data]) =>
        level === "warn" &&
        (data as { scope?: string } | undefined)?.scope === "capability.keys",
    );
    expect(named.length).toBeGreaterThanOrEqual(1);
  });

  it("withholds every capability literal, not the one under test", () => {
    // Asked of the closed set, so a literal added to `CAPABILITY_SCOPES` is
    // withheld by having been added rather than by somebody editing the
    // withholding module.
    for (const literal of CAPABILITY_SCOPES) {
      expect(isWithheldFromAllowlist(literal), literal).toBe(true);
    }
  });

  it("leaves the shipped defaults exactly as they were", () => {
    // The control. If this ever fails, the drop has caught something the
    // defaults legitimately publish.
    const before = new Set(buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES));
    expect([...before].some((s) => isWithheldFromAllowlist(s))).toBe(false);
    expect(before.has("core.note:read")).toBe(true);
  });

  it("does not withhold a scope over a type nothing has registered", () => {
    // Deliberate, and recorded on the predicate: that is the same shape as a
    // grant made before a type was registered, and refusing it would make a
    // bundle's validity depend on boot ordering.
    expect(isWithheldFromAllowlist("acme.thing:read")).toBe(false);
  });
});
