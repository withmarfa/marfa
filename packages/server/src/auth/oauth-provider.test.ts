import { describe, it, expect } from "vitest";
import { expandBundlesToScopes } from "@withmarfa/shared";
import { buildAllowedScopes } from "./oauth-provider.js";
import {
  DEFAULT_PERMISSION_BUNDLES,
  loadPermissionBundles,
} from "../config.js";

describe("buildAllowedScopes", () => {
  it("includes the global type wildcards (Customise full-access path)", () => {
    const scopes = buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES);
    expect(scopes).toContain("*:read");
    expect(scopes).toContain("*:write");
  });

  it("includes the metadata.edge_types sub-resource scopes", () => {
    const scopes = buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES);
    expect(scopes).toContain("metadata.edge_types:read");
    expect(scopes).toContain("metadata.edge_types:write");
  });

  it("includes every scope referenced by the configured bundles", () => {
    const scopes = new Set(buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES));
    for (const s of expandBundlesToScopes(DEFAULT_PERMISSION_BUNDLES)) {
      expect(scopes.has(s)).toBe(true);
    }
    // The namespace wildcards an app needs for its runtime user.* types.
    expect(scopes.has("user.*:read")).toBe(true);
    expect(scopes.has("user.*:write")).toBe(true);
  });

  it("still enumerates concrete registry + OIDC scopes", () => {
    const scopes = buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES);
    expect(scopes).toContain("core.note:read");
    expect(scopes).toContain("edge.*:write");
    expect(scopes).toContain("openid");
  });
});

describe("loadPermissionBundles", () => {
  it("returns the defaults when unset", () => {
    expect(loadPermissionBundles(undefined)).toBe(DEFAULT_PERMISSION_BUNDLES);
  });

  it("falls back to defaults on malformed JSON", () => {
    expect(loadPermissionBundles("{not json")).toBe(DEFAULT_PERMISSION_BUNDLES);
  });

  it("falls back to defaults on a non-array payload", () => {
    expect(loadPermissionBundles('{"id":"x"}')).toBe(
      DEFAULT_PERMISSION_BUNDLES,
    );
  });

  it("falls back to defaults when an entry is malformed", () => {
    expect(loadPermissionBundles('[{"label":"no id or scopes"}]')).toBe(
      DEFAULT_PERMISSION_BUNDLES,
    );
  });

  it("accepts a valid override array", () => {
    const raw = JSON.stringify([
      {
        id: "x",
        label: "X",
        description: "",
        scopes: ["core.note:read"],
        default_on: true,
      },
    ]);
    const out = loadPermissionBundles(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("x");
  });
});

describe("DEFAULT_PERMISSION_BUNDLES", () => {
  it("ships the four expected bundles, all default-on", () => {
    expect(DEFAULT_PERMISSION_BUNDLES.map((b) => b.id)).toEqual([
      "read",
      "write",
      "profile",
      "connected",
    ]);
    expect(DEFAULT_PERMISSION_BUNDLES.every((b) => b.default_on)).toBe(true);
  });

  it("folds item- and edge-type setup into the write bundle", () => {
    const write = DEFAULT_PERMISSION_BUNDLES.find((b) => b.id === "write");
    expect(write?.scopes).toContain("metadata.types:write");
    expect(write?.scopes).toContain("metadata.edge_types:write");
  });

  it("keeps system.* out of read/write (security internals stay private)", () => {
    for (const id of ["read", "write"]) {
      const bundle = DEFAULT_PERMISSION_BUNDLES.find((b) => b.id === id);
      expect(bundle?.scopes.some((s) => s.startsWith("system."))).toBe(false);
    }
    // Connected services is the only default bundle touching system.*.
    const connected = DEFAULT_PERMISSION_BUNDLES.find(
      (b) => b.id === "connected",
    );
    expect(connected?.scopes).toContain("system.connection:read");
  });
});
