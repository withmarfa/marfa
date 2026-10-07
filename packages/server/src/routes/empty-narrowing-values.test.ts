/**
 * A narrowing parameter sent with no value is refused on every door that
 * declares it, rather than read as no filter.
 *
 * The doors are read from the app's own published description, so a door
 * that starts to declare `type`, `source`, `tags` or `filter` is held to the
 * rule without being named here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { NARROWING_KEYS } from "../middleware/empty-narrowing-values.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  const made = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "one" }, tags: ["kept"] },
  });
  expect(made.status).toBe(201);
});

afterAll(async () => {
  await ctx.cleanup();
});

const WITH_VALUE: Record<string, string> = {
  type: "core.note",
  source: "empty-narrowing-test",
  tags: "kept",
  filter: 'properties.body eq "one"',
};

/** Keys a door needs besides the one under test. */
const REQUIRED: Record<string, string> = {
  "/occurrences": "from=2030-01-01T00:00:00Z&to=2030-01-02T00:00:00Z",
};

interface Door {
  path: string;
  operationId: string;
  keys: string[];
}

async function doors(): Promise<Door[]> {
  const res = await request(ctx.app, "GET", "/openapi.json");
  expect(res.status).toBe(200);
  const spec = (await res.json()) as {
    paths: Record<
      string,
      {
        get?: {
          operationId: string;
          parameters?: { name: string; in: string }[];
        };
      }
    >;
  };
  const found: Door[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    const operation = item.get;
    if (operation === undefined) continue;
    const keys = (operation.parameters ?? [])
      .filter((p) => p.in === "query" && NARROWING_KEYS.includes(p.name))
      .map((p) => p.name);
    if (keys.length > 0)
      found.push({ path, operationId: operation.operationId, keys });
  }
  return found;
}

async function get(door: Door, query: string): Promise<Response> {
  const required = REQUIRED[door.path];
  const joined = [required, query].filter(Boolean).join("&");
  return request(ctx.app, "GET", `${door.path}?${joined}`, {
    key: ctx.workingKey,
  });
}

describe("an empty type, source, tags or filter", () => {
  it("is found on the doors that list items, search, count, export and stream", async () => {
    const found = (await doors()).map((d) => d.operationId).sort();
    expect(found).toEqual(
      [
        "exportData",
        "getItemStats",
        "listItems",
        "listOccurrences",
        "searchItems",
        "streamEvents",
      ].sort(),
    );
  });

  it("is refused 400 validation_error naming the key, on every door that declares it", async () => {
    for (const door of await doors()) {
      for (const key of door.keys) {
        const query = door.path === "/search" ? "q=one&" : "";
        const res = await get(door, `${query}${key}=`);
        const body = (await res.json()) as {
          error: { code: string; details?: { empty_parameters?: string[] } };
        };
        expect(res.status, `${door.operationId} ${key}`).toBe(400);
        expect(body.error.code).toBe("validation_error");
        expect(body.error.details?.empty_parameters).toEqual([key]);
      }
    }
  });

  it("is refused when it holds only blanks, or a list of blank entries, on every door that declares it", async () => {
    const shapes: Record<string, string[]> = {
      type: ["%20", "%20%20", ",", ", ", ",,", "%20,%20"],
      tags: ["%20", ",", ", ", ",,"],
      source: ["%20", "%20%20"],
      filter: ["%20", "%20%20"],
    };
    for (const door of await doors()) {
      for (const key of door.keys) {
        for (const shape of shapes[key] ?? []) {
          const query = door.path === "/search" ? "q=one&" : "";
          const res = await get(door, `${query}${key}=${shape}`);
          const body = (await res.json()) as {
            error: { code: string; details?: { empty_parameters?: string[] } };
          };
          const where = `${door.operationId} ${key}=${shape}`;
          expect(res.status, where).toBe(400);
          expect(body.error.code, where).toBe("validation_error");
          expect(body.error.details?.empty_parameters, where).toEqual([key]);
        }
      }
    }
  });

  it("is not refused as empty when a list holds a real entry beside blanks", async () => {
    // The door may still refuse the value for another reason; what matters
    // is that it is not read as nothing to narrow by.
    for (const query of ["type=core.note,", "tags=kept,"]) {
      const res = await request(ctx.app, "GET", `/items?${query}`, {
        key: ctx.workingKey,
      });
      const body = (await res.json()) as {
        error?: { details?: { empty_parameters?: unknown } };
      };
      expect(body.error?.details?.empty_parameters, query).toBeUndefined();
    }
    const stream = await request(ctx.app, "GET", "/events?type=core.note,%20", {
      key: ctx.workingKey,
    });
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
  });

  it("is refused once for every empty key, and a filled one beside it is not named", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=&source=&tags=kept",
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { details: { empty_parameters: string[] } };
    };
    expect(body.error.details.empty_parameters).toEqual(["type", "source"]);
  });

  it("is refused when a repeated key is empty the second time", async () => {
    const res = await request(ctx.app, "GET", "/items?type=core.note&type=", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(400);
  });

  it("is answered 200 on the same door with a value, so the refusal is the empty value", async () => {
    for (const door of await doors()) {
      for (const key of door.keys) {
        const query = door.path === "/search" ? "q=one&" : "";
        const res = await get(
          door,
          `${query}${key}=${encodeURIComponent(WITH_VALUE[key] ?? "")}`,
        );
        expect(res.status, `${door.operationId} ${key}`).toBe(200);
        // A stream never ends; the status is the whole answer.
        await res.body?.cancel();
      }
    }
  });

  it("is refused after the credential, so a bare request learns nothing about its query", async () => {
    const res = await request(ctx.app, "GET", "/items?type=");
    expect(res.status).toBe(401);
  });
});
