/**
 * A refusal caused by a grant the key lacks is built in one place and names
 * the grant.
 *
 * A client holding a write a narrowed key had refused reads `details.grant`
 * to know it may send the write again once the grant is back. A door that
 * builds its own `type_not_permitted`, `edge_permission_denied` or extension
 * refusal reads as covered from every test of the doors that do not, so this
 * reads the source: every module that raises one of those codes is named here
 * with why, and the grant checks are driven to show what they carry.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MarfaError } from "@withmarfa/shared";
import type { ApiKey } from "@withmarfa/shared";
import {
  checkEdgePermission,
  checkExtensionPermission,
  checkTypeAccess,
} from "./auth.js";

const root = join(import.meta.dirname, "..");

const RAISES = /ErrorCode\.(TYPE_NOT_PERMITTED|EDGE_PERMISSION_DENIED)\b/;

/** Modules that raise one of the codes, each with why. */
const RAISERS: Record<string, string> = {
  "middleware/auth.ts":
    "the grant checks, through `grantRefusal`, and the refusals no grant opens: the reserved fence, a map reaching no type, a natural key resolving an unreadable row",
  "routes/folders.ts":
    "the folder door's own type gate, through `grantRefusal`, naming `system.folder`",
  "routes/_blob-reach.ts":
    "an upload needs write on some type rather than on one, so there is no single grant to name",
};

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        rel !== "test-utils.ts"
      ) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out.sort();
}

function key(overrides: Partial<ApiKey>): ApiKey {
  return {
    id: "census",
    label: "census",
    source: "census",
    type_permissions: {},
    edge_permissions: {},
    extension_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
    permissions: [],
    is_operator: false,
    ...overrides,
  } as ApiKey;
}

function refusal(fn: () => void): MarfaError {
  try {
    fn();
  } catch (err) {
    if (err instanceof MarfaError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("a refusal for a missing grant is built once and names the grant", () => {
  it("names every module that raises a grant code", () => {
    const raisers = sources().filter((rel) =>
      RAISES.test(readFileSync(join(root, rel), "utf8")),
    );
    expect(raisers).toEqual(Object.keys(RAISERS).sort());
  });

  it("names the type and the level lacking", () => {
    const reader = key({ type_permissions: { "core.note": "read" } });
    expect(
      refusal(() => {
        checkTypeAccess(reader, "core.note", "write");
      }).details,
    ).toEqual({ grant: { kind: "type", name: "core.note", level: "write" } });
    expect(
      refusal(() => {
        checkTypeAccess(reader, "core.task", "read");
      }).details,
    ).toEqual({ grant: { kind: "type", name: "core.task", level: "read" } });
  });

  it("names the edge type, beside what the code already carried", () => {
    expect(
      refusal(() => {
        checkEdgePermission(key({}), "references", "write");
      }).details,
    ).toEqual({
      edge_type: "references",
      required: "write",
      grant: { kind: "edge_type", name: "references", level: "write" },
    });
  });

  it("names the extension namespace", () => {
    const reader = key({ extension_permissions: { notes: "read" } });
    const err = refusal(() => {
      checkExtensionPermission(reader, "notes", "write");
    });
    expect(err.code).toBe("forbidden");
    expect(err.details).toEqual({
      grant: { kind: "extension", name: "notes", level: "write" },
    });
    expect(() => {
      checkExtensionPermission(reader, "notes", "read");
    }).not.toThrow();
  });

  it("names no grant where no grant would open the door", () => {
    const wide = key({ type_permissions: { "*": "write" } });
    const fenced = refusal(() => {
      checkTypeAccess(wide, "system.folder", "write");
    });
    expect(fenced.code).toBe("type_not_permitted");
    expect(fenced.details).toBeUndefined();
  });
});
