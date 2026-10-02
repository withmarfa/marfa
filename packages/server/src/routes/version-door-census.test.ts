/**
 * Every door that can answer a version snapshot's content, and the credential
 * it answers.
 *
 * **A snapshot is read under the type it was written under, not the row's
 * type now.** A row moved from a type a key may not read into one it may
 * keeps the snapshots it left behind, and those carry the old type's
 * properties. So the doors are read out of the app's own OpenAPI document,
 * every operation whose answer can carry a snapshot (a version row, or a
 * conflict's `ancestor`), each has to be classified below before this file
 * goes green, and each is then driven twice against a row moved from
 * `core.task` into `core.note`: by a key reading both, the witness that the
 * old snapshot is there to be leaked, and by a key reading `core.note`
 * alone, which must be answered without it.
 *
 * A stale write is held to the same rule because it is a read of the
 * snapshot it names: merged against it, or answered with it as `ancestor`.
 * One the key may not read answers `ancestor_unavailable`, as a thinned one
 * does.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
} from "../openapi-finalize.js";
import {
  createTestContext,
  inlineOpenApiRefs,
  mintWorkingKey,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let bothKey: string;
let noteKey: string;

const SOURCE = "version-census";
const OLD_MARK = "written-while-a-task";

beforeAll(async () => {
  ctx = await createTestContext();
  bothKey = await mintWorkingKey(ctx, { source: SOURCE });
  noteKey = await mintWorkingKey(ctx, {
    source: `${SOURCE}-notes`,
    sources: [SOURCE],
    type_permissions: { "core.note": "write" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/** Whether a schema reaches a snapshot: a version row or an `ancestor`. */
function namesSnapshot(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(namesSnapshot);
  if (node === null || typeof node !== "object") return false;
  const record = node as Record<string, unknown>;
  const properties = record.properties as Record<string, unknown> | undefined;
  if (
    properties !== undefined &&
    ("ancestor" in properties ||
      ("item_id" in properties &&
        "version" in properties &&
        "properties" in properties))
  ) {
    return true;
  }
  return Object.values(record).some(namesSnapshot);
}

function snapshotDoors(): string[] {
  const document = finalizeOpenAPISpec(
    ctx.app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: OPENAPI_DOCUMENT_INFO,
    }),
  ) as unknown as Record<string, unknown>;
  const paths = inlineOpenApiRefs(document.paths, document) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const out: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      if (namesSnapshot(operation.responses)) {
        out.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return out.sort();
}

/**
 * A row created as a task carrying `OLD_MARK`, edited once as a task, moved
 * into `core.note` and edited once as a note: version 1 is a task snapshot
 * holding the mark, and version 3 a note snapshot.
 */
async function seedMovedRow(): Promise<{ id: string; sourceId: string }> {
  const sourceId = `moved-${Math.random().toString(36).slice(2)}`;
  const created = await request(ctx.app, "POST", "/items", {
    key: bothKey,
    body: {
      type: "core.task",
      source_id: sourceId,
      properties: { title: OLD_MARK },
    },
  });
  expect(created.status).toBe(201);
  const { item } = (await created.json()) as { item: { id: string } };
  const steps: Record<string, unknown>[] = [
    { properties: { title: "still a task" }, version: 1 },
    {
      type: "core.note",
      retype: true,
      properties: { title: "now a note", body: "a note body" },
      version: 2,
    },
    { properties: { title: "a note, edited" }, version: 3 },
  ];
  for (const body of steps) {
    const res = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: bothKey,
      body,
    });
    expect(res.status, await res.clone().text()).toBe(200);
  }
  return { id: item.id, sourceId };
}

interface Answer {
  status: number;
  text: string;
}

async function answer(res: Response): Promise<Answer> {
  return { status: res.status, text: await res.text() };
}

type Driver = (key: string) => Promise<Answer>;

/** A stale write naming version 1, the task snapshot, that collides on the
 *  title changed since. */
const STALE = { properties: { title: "mine" }, version: 1 };

const ANSWERING: Record<string, Driver> = {
  "GET /items/{id}/versions": async (key) => {
    const { id } = await seedMovedRow();
    return answer(
      await request(ctx.app, "GET", `/items/${id}/versions`, { key }),
    );
  },
  "GET /items/{id}": async (key) => {
    const { id } = await seedMovedRow();
    return answer(
      await request(ctx.app, "GET", `/items/${id}?include=versions`, { key }),
    );
  },
  "PATCH /items/{id}": async (key) => {
    const { id } = await seedMovedRow();
    return answer(
      await request(ctx.app, "PATCH", `/items/${id}`, { key, body: STALE }),
    );
  },
  "POST /items": async (key) => {
    const { sourceId } = await seedMovedRow();
    return answer(
      await request(ctx.app, "POST", "/items", {
        key,
        body: {
          type: "core.note",
          source: SOURCE,
          source_id: sourceId,
          ...STALE,
        },
      }),
    );
  },
};

/** Doors with a rule of their own, each with what that rule is. */
const OWN_RULE: Record<string, string> = {
  "PATCH /folders/{id}":
    "a folder is `system.folder` at every version, and the door is gated on that type; its stale write passes the same reader to the store",
};

/**
 * Every module reading a snapshot without a reader, and why. A door reads
 * through `versions.list`, which takes one.
 */
const UNFILTERED_HISTORY: Record<string, string> = {
  "storage/sqlite/item-store.ts":
    "the update, which reads the base snapshot and merges against it only where the writer's may_read_type admits its type",
  "storage/version-thinner.ts":
    "the thinner, which decides what to keep for no credential and answers nobody",
};

function unfilteredHistoryReaders(): string[] {
  const root = join(import.meta.dirname, "..");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        /\bversion(s|Store)\.(all|getByVersion)\(/.test(
          readFileSync(join(root, rel), "utf8"),
        )
      ) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out.sort();
}

describe("every door answering a snapshot is held to the key's type reach", () => {
  it("names every module reading a snapshot without a reader", () => {
    expect(unfilteredHistoryReaders()).toEqual(
      Object.keys(UNFILTERED_HISTORY).sort(),
    );
  });

  it("classifies every door whose answer can carry a snapshot", () => {
    expect(snapshotDoors()).toEqual(
      [...Object.keys(ANSWERING), ...Object.keys(OWN_RULE)].sort(),
    );
  });

  for (const [door, drive] of Object.entries(ANSWERING)) {
    it(`answers ${door} without a snapshot of a type the key may not read`, async () => {
      const seen = await drive(bothKey);
      expect(seen.text, `${door}, the witness`).toContain(OLD_MARK);

      const hidden = await drive(noteKey);
      expect(hidden.text, `${door}, the note key`).not.toContain(OLD_MARK);
      expect(hidden.text).not.toContain('"core.task"');
    });
  }

  it("answers a stale write naming an unreadable snapshot as ancestor_unavailable, never merged", async () => {
    const { id } = await seedMovedRow();
    const witness = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: bothKey,
      body: STALE,
    });
    expect(witness.status).toBe(409);
    expect(witness.headers.get("X-Error-Code")).toBe("version_conflict");

    // Collides with nothing, so a key reading the snapshot would merge it.
    const merging = { properties: { notes: "added" }, version: 1 };
    const merged = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: bothKey,
      body: merging,
    });
    expect(merged.status).toBe(200);

    const { id: other } = await seedMovedRow();
    const refused = await request(ctx.app, "PATCH", `/items/${other}`, {
      key: noteKey,
      body: merging,
    });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as {
      error: { code: string };
      requested_version: number;
      ancestor?: unknown;
    };
    expect(body.error.code).toBe("ancestor_unavailable");
    expect(body.requested_version).toBe(1);
    expect(body.ancestor).toBeUndefined();
  });

  it("answers a bulk entry naming an unreadable snapshot as ancestor_unavailable", async () => {
    const codeFor = async (key: string): Promise<string | undefined> => {
      const { sourceId } = await seedMovedRow();
      const res = await request(ctx.app, "POST", "/items/bulk", {
        key,
        body: {
          atomic: false,
          items: [
            {
              type: "core.note",
              source: SOURCE,
              source_id: sourceId,
              ...STALE,
            },
          ],
        },
      });
      expect(res.status).toBe(200);
      const { results } = (await res.json()) as {
        results: { error?: { code: string } }[];
      };
      return results[0]?.error?.code;
    };
    expect(await codeFor(bothKey)).toBe("version_conflict");
    expect(await codeFor(noteKey)).toBe("ancestor_unavailable");
  });
});
