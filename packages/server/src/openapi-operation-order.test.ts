/**
 * The reference lists every operation once, under its own group.
 *
 * Each tag in the committed `openapi.json` carries `x-operation-order`, the
 * group's operations in reading order, and the document orders `paths` by
 * the first appearance of their operations in those lists. A failure names
 * each operation that is missing, repeated, filed under another group or
 * not published.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const COMMITTED = new URL("../../../openapi.json", import.meta.url);

type Json = Record<string, unknown>;

const document = JSON.parse(readFileSync(COMMITTED, "utf8")) as Json;

const METHODS = ["get", "put", "post", "patch", "delete"];

interface Published {
  id: string;
  where: string;
  tags: string[];
}

function published(doc: Json): Published[] {
  const out: Published[] = [];
  const sources: [string, unknown][] = [
    ["", doc.paths],
    ["webhook ", doc.webhooks],
  ];
  for (const [prefix, entries] of sources) {
    for (const [name, methods] of Object.entries(
      (entries ?? {}) as Record<string, Json>,
    )) {
      for (const method of METHODS) {
        const operation = methods[method] as Json | undefined;
        if (operation === undefined) continue;
        out.push({
          id: (operation.operationId as string | undefined) ?? "",
          where: `${prefix}${method.toUpperCase()} ${name}`,
          tags: (operation.tags ?? []) as string[],
        });
      }
    }
  }
  return out;
}

/** Every way the lists can disagree with the operations, each naming its operation. */
function problems(doc: Json): string[] {
  const found: string[] = [];
  const lists = new Map<string, string[]>();
  for (const tag of (doc.tags ?? []) as Json[]) {
    const name = String(tag.name);
    const order = tag["x-operation-order"];
    if (!Array.isArray(order)) {
      found.push(`The group ${name} has no x-operation-order.`);
      continue;
    }
    lists.set(name, order as string[]);
  }

  const listedUnder = new Map<string, string[]>();
  for (const [group, order] of lists) {
    for (const id of order) {
      listedUnder.set(id, [...(listedUnder.get(id) ?? []), group]);
    }
  }

  const operations = published(doc);
  const publishedIds = new Set(operations.map(({ id }) => id));
  for (const { id, where, tags } of operations) {
    const listed = listedUnder.get(id) ?? [];
    const tag = tags[0];
    if (tags.length !== 1 || tag === undefined) {
      found.push(
        `${id} (${where}) carries ${String(tags.length)} tags, not one.`,
      );
    }
    if (listed.length === 0) {
      found.push(
        `${id} (${where}) is in no group's x-operation-order: add it to its group's operations in PUBLIC_TAGS.`,
      );
    } else if (listed.length > 1) {
      found.push(
        `${id} (${where}) is listed ${String(listed.length)} times: ${listed.join(", ")}.`,
      );
    } else if (listed[0] !== tag) {
      found.push(
        `${id} (${where}) carries the tag ${String(tag)} but is listed under ${String(listed[0])}.`,
      );
    }
  }
  for (const [group, order] of lists) {
    for (const id of order) {
      if (!publishedIds.has(id)) {
        found.push(`${group} lists ${id}, which nothing publishes.`);
      }
    }
  }

  // `paths` follows the lists: each path stands where its earliest
  // operation does.
  const rank = new Map<string, number>();
  for (const order of lists.values()) {
    for (const id of order) if (!rank.has(id)) rank.set(id, rank.size);
  }
  let previous = -1;
  let previousPath = "";
  for (const [path, methods] of Object.entries(
    (doc.paths ?? {}) as Record<string, Json>,
  )) {
    const ranks = METHODS.map((m) =>
      rank.get(String((methods[m] as Json | undefined)?.operationId)),
    ).filter((r): r is number => r !== undefined);
    if (ranks.length === 0) continue;
    const first = Math.min(...ranks);
    if (first < previous) {
      found.push(
        `The path ${path} stands after ${previousPath}, but its operations come first in the lists.`,
      );
    }
    previous = Math.max(previous, first);
    previousPath = path;
  }
  return found;
}

describe("the reference lists every operation once, in its group", () => {
  it("holds in the committed document", () => {
    // The witness: there are operations and webhooks to compare.
    expect(published(document).length).toBeGreaterThan(100);
    expect(
      published(document).some(({ where }) => where.startsWith("webhook ")),
    ).toBe(true);
    expect(problems(document), "These break the lists in PUBLIC_TAGS").toEqual(
      [],
    );
  });

  it("names what breaks each rule", () => {
    const operation = (operationId: string, tag: string) => ({
      operationId,
      tags: [tag],
    });
    const broken = {
      tags: [
        {
          name: "Things",
          "x-operation-order": ["getThing", "getThing", "ghost"],
        },
        { name: "Parts", "x-operation-order": ["listParts", "getThing"] },
        { name: "Bare" },
      ],
      paths: {
        "/things": {
          get: operation("getThing", "Things"),
          post: operation("createThing", "Things"),
        },
        "/parts": { get: operation("listParts", "Parts") },
        "/parts/{id}": { get: operation("getPart", "Parts") },
      },
      webhooks: { event: { post: operation("receive", "Parts") } },
    };
    expect(problems(broken)).toEqual([
      "The group Bare has no x-operation-order.",
      "getThing (GET /things) is listed 3 times: Things, Things, Parts.",
      "createThing (POST /things) is in no group's x-operation-order: add it to its group's operations in PUBLIC_TAGS.",
      "getPart (GET /parts/{id}) is in no group's x-operation-order: add it to its group's operations in PUBLIC_TAGS.",
      "receive (webhook POST event) is in no group's x-operation-order: add it to its group's operations in PUBLIC_TAGS.",
      "Things lists ghost, which nothing publishes.",
    ]);
  });

  it("names an operation filed under another group", () => {
    const broken = {
      tags: [
        { name: "A", "x-operation-order": ["first"] },
        { name: "B", "x-operation-order": ["second"] },
      ],
      paths: {
        "/first": { get: { operationId: "first", tags: ["B"] } },
        "/second": { get: { operationId: "second", tags: ["B"] } },
      },
    };
    expect(problems(broken)).toEqual([
      "first (GET /first) carries the tag B but is listed under A.",
    ]);
  });

  it("names a path that stands after one whose operations come later", () => {
    const tag = { name: "A", "x-operation-order": ["a", "b"] };
    const path = (operationId: string) => ({
      get: { operationId, tags: ["A"] },
    });
    expect(
      problems({ tags: [tag], paths: { "/a": path("a"), "/b": path("b") } }),
    ).toEqual([]);
    expect(
      problems({ tags: [tag], paths: { "/b": path("b"), "/a": path("a") } }),
    ).toEqual([
      "The path /a stands after /b, but its operations come first in the lists.",
    ]);
  });
});
