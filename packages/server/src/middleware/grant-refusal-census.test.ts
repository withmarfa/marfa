/**
 * A refusal caused by a grant the key lacks is built in one place and names
 * the grant.
 *
 * A client holding a write a narrowed key had refused reads `details.grant`
 * to know it may send the write again once the grant is back. A door that
 * builds its own `type_not_permitted`, `edge_permission_denied` or extension
 * refusal reads as covered from every test of the doors that do not, so this
 * reads the source: every module that references one of those codes is named here
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

const REFERENCES = /ErrorCode\.(TYPE_NOT_PERMITTED|EDGE_PERMISSION_DENIED)\b/;

const CODE_REFERENCES: Record<string, string> = {
  "middleware/auth.ts":
    "the grant checks, through `grantRefusal`, and the refusals no grant opens: the reserved fence, a map reaching no type, a natural key resolving an unreadable row",
  "middleware/read-view.ts":
    "observes existing route refusals to certify their read view after successful snapshot closure; it builds no grant refusal",
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
  it("accounts for every module referencing a grant code", () => {
    const references = sources().filter((rel) =>
      REFERENCES.test(readFileSync(join(root, rel), "utf8")),
    );
    expect(references).toEqual(Object.keys(CODE_REFERENCES).sort());
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
  /** Write on notes, read on `references` edges. */
  let edgeReader: string;
  let note: string;
  let binned: string;
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
    edgeReader = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write" },
      edge_permissions: { references: "read" },
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
    binned = await made();
    await request(ctx.app, "DELETE", `/items/${binned}`, {
      key: ctx.workingKey,
    });
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
      door: "POST /items/{id}/restore",
      key: () => reader,
      send: () => ["POST", `/items/${binned}/restore`],
      grant: typeWrite,
    },
    {
      door: "DELETE /items/{id}/purge",
      key: () => reader,
      send: () => ["DELETE", `/items/${binned}/purge`],
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
      door: "PATCH /edges/{id}",
      key: () => edgeReader,
      send: () => [
        "PATCH",
        `/edges/${edge}`,
        { properties: { a: 1 }, version: 1 },
      ],
      grant: { kind: "edge_type", name: "references", level: "write" },
    },
    {
      door: "DELETE /edges/{id}",
      key: () => edgeReader,
      send: () => ["DELETE", `/edges/${edge}`],
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

  // The bulk doors carry the grant where each carries an inner refusal:
  // inside `details` of the rollback under `atomic`, on the entry otherwise.
  const bulkEdge = (): {
    source_id: string;
    target_id: string;
    edge_type: string;
  } => ({
    source_id: note,
    target_id: note,
    edge_type: "references",
  });
  const edgeWrite = { kind: "edge_type", name: "references", level: "write" };

  it("POST /edges/bulk, atomic", async () => {
    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: writer,
      body: { edges: [bulkEdge()], atomic: true },
    });
    expect(res.status).toBe(403);
    const { error } = (await res.json()) as {
      error: { code: string; details?: { details?: { grant?: unknown } } };
    };
    expect(error.code).toBe("bulk_atomic_rollback");
    expect(error.details?.details?.grant).toEqual(edgeWrite);
  });

  it("POST /edges/bulk, best effort", async () => {
    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: writer,
      body: { edges: [bulkEdge()], atomic: false },
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: { error?: { details?: { grant?: unknown } } }[];
    };
    expect(results[0]?.error?.details?.grant).toEqual(edgeWrite);
  });

  it("POST /items/bulk, atomic and best effort", async () => {
    const entry = { type: "core.note", properties: { body: "x" } };
    const atomic = await request(ctx.app, "POST", "/items/bulk", {
      key: reader,
      body: { items: [entry] },
    });
    expect(atomic.status).toBe(403);
    const rolled = (await atomic.json()) as {
      error: { details?: { details?: { grant?: unknown } } };
    };
    expect(rolled.error.details?.details?.grant).toEqual(typeWrite);
    const loose = await request(ctx.app, "POST", "/items/bulk", {
      key: reader,
      body: { items: [entry], atomic: false },
    });
    expect(loose.status).toBe(200);
    const { results } = (await loose.json()) as {
      results: { error?: { details?: { grant?: unknown } } }[];
    };
    expect(results[0]?.error?.details?.grant).toEqual(typeWrite);
  });
});
