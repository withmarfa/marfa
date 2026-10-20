import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  scopesToEdgePermissions,
  scopesToMetadataPermissions,
  scopesToProfilePermissions,
  scopesToTypePermissions,
} from "@withmarfa/shared";
import {
  accessBody,
  claimedSources,
  endsAt,
  SKIPPED_WRITE_RULES,
  withDenials,
} from "./key-body.js";

/** Literals the key pages can offer: every family, at both levels, with names and without. */
const OFFERED = [
  "*:read",
  "*:write",
  "core.note:read",
  "core.note:write",
  "core.task:read",
  "edge.*:read",
  "edge.*:write",
  "edge.links_to:read",
  "metadata:read",
  "metadata:write",
  "metadata.history:read",
  "profile:read",
  "profile:write",
  "profile.name:write",
  "profile.avatar:read",
];

describe("the access the key pages send", () => {
  it("is what the shared converters read from the same literals", () => {
    for (const literals of [
      [],
      ["core.note:read"],
      ["core.note:write", "core.note:read"],
      ["*:write", "edge.*:read", "metadata:write", "profile:read"],
      OFFERED,
      [...OFFERED].reverse(),
    ]) {
      const body = accessBody(literals);
      expect(body.type_permissions, literals.join()).toEqual(
        scopesToTypePermissions(literals),
      );
      expect(body.edge_permissions, literals.join()).toEqual(
        scopesToEdgePermissions(literals),
      );
      expect(body.metadata_permissions, literals.join()).toEqual(
        scopesToMetadataPermissions(literals),
      );
      expect(body.profile_permissions, literals.join()).toEqual(
        scopesToProfilePermissions(literals),
      );
    }
  });

  it("puts a literal with no level among the permissions, once", () => {
    const body = accessBody([...PERMISSIONS, "keys.mint", "core.note:read"]);
    expect(body.permissions).toEqual([...PERMISSIONS]);
    expect(body.type_permissions).toEqual({ "core.note": "read" });
  });

  it("names every map, empty when nothing is in it, so a create never inherits what its maker holds", () => {
    expect(accessBody([])).toEqual({
      permissions: [],
      type_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
    });
  });

  it("keeps the higher level where two literals name one thing", () => {
    expect(
      accessBody(["core.note:write", "core.note:read"]).type_permissions,
    ).toEqual({ "core.note": "write" });
    expect(
      accessBody(["core.note:read", "core.note:write"]).type_permissions,
    ).toEqual({ "core.note": "write" });
  });
});

describe("a saved key's denials", () => {
  it("are put back into the maps that are sent whole", () => {
    const sent = withDenials(accessBody(["core.note:read"]), {
      type_permissions: ["system.connection", "system.key"],
    });
    expect(sent.type_permissions).toEqual({
      "core.note": "read",
      "system.connection": "none",
      "system.key": "none",
    });
    expect(sent.edge_permissions).toEqual({});
  });

  it("give way to a grant that now names the same thing", () => {
    const sent = withDenials(accessBody(["system.key:read"]), {
      type_permissions: ["system.key"],
    });
    expect(sent.type_permissions).toEqual({ "system.key": "read" });
  });

  it("are not shared with the body they were put into", () => {
    const body = accessBody(["core.note:read"]);
    withDenials(body, { type_permissions: ["system.key"] });
    expect(body.type_permissions).toEqual({ "core.note": "read" });
  });
});

describe("when a key ends", () => {
  const NOW = Date.UTC(2026, 9, 20, 12);

  it("is nothing for never and that many days on for the others", () => {
    expect(endsAt("never", NOW)).toBeNull();
    expect(endsAt("30", NOW)).toBe("2026-11-19T12:00:00.000Z");
    expect(endsAt("90", NOW)).toBe("2027-01-18T12:00:00.000Z");
    expect(endsAt("365", NOW)).toBe("2027-10-20T12:00:00.000Z");
  });
});

describe("the sources a key claims", () => {
  it("are split on commas, trimmed, deduplicated and without the key's own", () => {
    expect(claimedSources(" a, b ,a,,own ,c", "own")).toEqual(["a", "b", "c"]);
    expect(claimedSources("", "own")).toEqual([]);
  });
});

describe("skipping Marfa's write rules", () => {
  it("empties every lever the instance sets", () => {
    expect(SKIPPED_WRITE_RULES).toEqual({
      strict_mode: { types: [] },
      source_allowlist: { types: [], sources: [] },
      source_filter: { types: [], sources: [] },
    });
  });
});
