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
  endChoicesFor,
  endsAt,
  extensionFollowing,
  extensionPermissions,
  keyFingerprint,
  notAfter,
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

describe("the ends a saved key can be given", () => {
  const NOW = Date.UTC(2026, 9, 20, 12);
  const DAY = 86_400_000;

  it("are every choice for a key that never ends", () => {
    expect(endChoicesFor(null, NOW)).toEqual(["never", "30", "90", "365"]);
  });

  it("are only the choices that end no later than the key does, and never never", () => {
    expect(endChoicesFor(NOW + 100 * DAY, NOW)).toEqual(["30", "90"]);
    expect(endChoicesFor(NOW + 90 * DAY, NOW)).toEqual(["30", "90"]);
    expect(endChoicesFor(NOW + 90 * DAY - 1, NOW)).toEqual(["30"]);
    expect(endChoicesFor(NOW + 400 * DAY, NOW)).toEqual(["30", "90", "365"]);
    expect(endChoicesFor(NOW + 5 * DAY, NOW)).toEqual([]);
  });
});

describe("integration data on a new key", () => {
  it("follows the level of all data, and is none for anything else", () => {
    expect(extensionFollowing(["*:write"])).toBe("write");
    expect(extensionFollowing(["*:read", "core.note:write"])).toBe("read");
    expect(extensionFollowing(["*:read", "*:write"])).toBe("write");
    expect(extensionFollowing(["core.note:write", "edge.*:write"])).toBe(
      "none",
    );
    expect(extensionFollowing([])).toBe("none");
  });

  it("is sent as the all-namespaces entry, and as an empty map for none so a create never inherits", () => {
    expect(extensionPermissions("write")).toEqual({ "*": "write" });
    expect(extensionPermissions("read")).toEqual({ "*": "read" });
    expect(extensionPermissions("none")).toEqual({});
  });
});

describe("what tells a key from the same key changed elsewhere", () => {
  const key = {
    permissions: ["keys.mint", "audit.read"],
    type_permissions: { "core.note": "write", "*": "read" },
    edge_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
    extension_permissions: { "*": "read" },
    expires_at: undefined,
  };

  it("is the same whatever order the lists and maps come in, and whether a missing end is null or absent", () => {
    const reordered = {
      ...key,
      permissions: ["audit.read", "keys.mint"],
      type_permissions: { "*": "read", "core.note": "write" },
      expires_at: null,
    };
    expect(keyFingerprint(reordered)).toBe(keyFingerprint(key));
  });

  it("differs when a permission, a level, an extension or the end differs", () => {
    const base = keyFingerprint(key);
    for (const changed of [
      { ...key, permissions: ["keys.mint"] },
      { ...key, type_permissions: { "core.note": "read", "*": "read" } },
      { ...key, type_permissions: { "*": "read" } },
      { ...key, extension_permissions: {} },
      { ...key, profile_permissions: { "*": "read" } },
      { ...key, expires_at: "2999-01-01T00:00:00.000Z" },
    ])
      expect(keyFingerprint(changed)).not.toBe(base);
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

describe("notAfter", () => {
  const limit = "2030-01-31T00:00:00.000Z";

  it("holds an end that is later to the limit and leaves one that is not", () => {
    expect(notAfter("2030-02-01T00:00:00.000Z", limit)).toBe(limit);
    expect(notAfter("2030-01-30T00:00:00.000Z", limit)).toBe(
      "2030-01-30T00:00:00.000Z",
    );
    expect(notAfter(limit, limit)).toBe(limit);
  });

  it("leaves an end alone when the key has no limit, and no end as none", () => {
    expect(notAfter("2030-02-01T00:00:00.000Z", undefined)).toBe(
      "2030-02-01T00:00:00.000Z",
    );
    expect(notAfter(null, limit)).toBeNull();
  });
});
