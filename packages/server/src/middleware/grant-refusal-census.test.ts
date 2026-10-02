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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaError } from "@withmarfa/shared";
import type { ApiKey } from "@withmarfa/shared";
import {
  checkEdgePermission,
  checkExtensionPermission,
  checkTypeAccess,
} from "./auth.js";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

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

describe("every door that refuses a missing grant names it", () => {
  let ctx: TestContext;
  /** Read on notes, nothing on edges or extensions. */
  let reader: string;
  /** Write on notes, nothing on edges or extensions. */
  let writer: string;
  let note: string;
  let edge: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    reader = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
      edge_permissions: {},
      extension_permissions: {},
    });
    writer = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write" },
      edge_permissions: {},
      extension_permissions: {},
    });
    const made = async (): Promise<string> => {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: "census" } },
      });
      return ((await res.json()) as { item: { id: string } }).item.id;
    };
    note = await made();
    const other = await made();
    const res = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: note, target_id: other, edge_type: "references" },
    });
    edge = ((await res.json()) as { edge: { id: string } }).edge.id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  const typeWrite = { kind: "type", name: "core.note", level: "write" };
  const doors: {
    door: string;
    key: () => string;
    send: () => [string, string, unknown?];
    grant: unknown;
  }[] = [
    {
      door: "POST /items",
      key: () => reader,
      send: () => [
        "POST",
        "/items",
        { type: "core.note", properties: { body: "x" } },
      ],
      grant: typeWrite,
    },
    {
      door: "PATCH /items/{id}",
      key: () => reader,
      send: () => [
        "PATCH",
        `/items/${note}`,
        { properties: { body: "x" }, version: 1 },
      ],
      grant: typeWrite,
    },
    {
      door: "DELETE /items/{id}",
      key: () => reader,
      send: () => ["DELETE", `/items/${note}`],
      grant: typeWrite,
    },
    {
      door: "POST /items/{id}/transition",
      key: () => reader,
      send: () => ["POST", `/items/${note}/transition`, { state: "archived" }],
      grant: typeWrite,
    },
    {
      door: "PUT /items/{id}/metadata",
      key: () => reader,
      send: () => ["PUT", `/items/${note}/metadata`, { tags: ["x"] }],
      grant: typeWrite,
    },
    {
      door: "PATCH /items/{id}/metadata",
      key: () => reader,
      send: () => ["PATCH", `/items/${note}/metadata`, { tags: ["x"] }],
      grant: typeWrite,
    },
    {
      door: "POST /items/{id}/tags",
      key: () => reader,
      send: () => ["POST", `/items/${note}/tags`, { tags: ["x"] }],
      grant: typeWrite,
    },
    {
      door: "DELETE /items/{id}/tags/{tag}",
      key: () => reader,
      send: () => ["DELETE", `/items/${note}/tags/x`],
      grant: typeWrite,
    },
    {
      door: "POST /folders",
      key: () => writer,
      send: () => ["POST", "/folders", { title: "x" }],
      grant: { kind: "type", name: "system.folder", level: "write" },
    },
    {
      door: "POST /edges",
      key: () => writer,
      send: () => [
        "POST",
        "/edges",
        { source_id: note, target_id: note, edge_type: "references" },
      ],
      grant: { kind: "edge_type", name: "references", level: "write" },
    },
    {
      door: "PATCH /items/{id} with inline edges",
      key: () => writer,
      send: () => [
        "PATCH",
        `/items/${note}`,
        { edges: { references: [] }, version: 1 },
      ],
      grant: { kind: "edge_type", name: "references", level: "write" },
    },
    {
      door: "GET /items/{id}/extensions/{namespace}",
      key: () => writer,
      send: () => ["GET", `/items/${note}/extensions/notes-app`],
      grant: { kind: "extension", name: "notes-app", level: "read" },
    },
    {
      door: "PUT /items/{id}/extensions/{namespace}",
      key: () => writer,
      send: () => ["PUT", `/items/${note}/extensions/notes-app`, { a: 1 }],
      grant: { kind: "extension", name: "notes-app", level: "write" },
    },
    {
      door: "DELETE /items/{id}/extensions/{namespace}",
      key: () => writer,
      send: () => ["DELETE", `/items/${note}/extensions/notes-app`],
      grant: { kind: "extension", name: "notes-app", level: "write" },
    },
  ];

  for (const { door, key, send, grant } of doors) {
    it(door, async () => {
      const [method, path, body] = send();
      const res = await request(ctx.app, method, path, {
        key: key(),
        ...(body !== undefined && { body }),
      });
      expect(res.status).toBe(403);
      const { error } = (await res.json()) as {
        error: { details?: { grant?: unknown } };
      };
      expect(error.details?.grant).toEqual(grant);
    });
  }

  it("PATCH /edges/{id}, a move of an edge the key may not write", async () => {
    const res = await request(ctx.app, "PATCH", `/edges/${edge}`, {
      key: writer,
      body: { properties: { a: 1 }, version: 1 },
    });
    // A key with no read on the edge type is not told the edge is there.
    expect([403, 404]).toContain(res.status);
    if (res.status === 403) {
      const { error } = (await res.json()) as {
        error: { details?: { grant?: unknown } };
      };
      expect(error.details?.grant).toEqual({
        kind: "edge_type",
        name: "references",
        level: "write",
      });
    }
  });
});
