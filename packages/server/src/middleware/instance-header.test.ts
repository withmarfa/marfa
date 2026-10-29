import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId } from "@withmarfa/shared";
import {
  createTestContext,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";

let ctx: TestContext;
let own: string;
/** Well formed, and the id of no instance this test boots. */
const OTHER = "019537a0-7b80-7000-8000-0000000000ff";
const HEADER = "X-Marfa-Instance-Id";

beforeAll(async () => {
  ctx = await createTestContext();
  const root = await ctx.app.request("/", {
    headers: { Accept: "application/json" },
  });
  own = ((await root.json()) as { instance_id: string }).instance_id;
});

afterAll(async () => {
  await cleanupTestContext(ctx);
});

async function write(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    key?: string | null;
  } = {},
): Promise<Response> {
  const key = init.key === undefined ? ctx.workingKey : init.key;
  return await ctx.app.request(path, {
    method: init.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key === null ? {} : { Authorization: `Bearer ${key}` }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

const note = (body: string) => ({
  type: "core.note",
  properties: { body },
});

async function notes(body: string): Promise<number> {
  const listed = await ctx.app.request(`/items?type=core.note&limit=200`, {
    headers: { Authorization: `Bearer ${ctx.workingKey}` },
  });
  const page = (await listed.json()) as {
    data: { properties: { body?: string } }[];
  };
  return page.data.filter((row) => row.properties.body === body).length;
}

describe("a write that names an instance", () => {
  it("is taken when it names this instance, and refused 409 instance_changed, unwritten, when it names another", async () => {
    const taken = await write("/items", {
      body: note("named own"),
      headers: { [HEADER]: own },
    });
    expect(taken.status).toBe(201);

    const refused = await write("/items", {
      body: note("named other"),
      headers: { [HEADER]: OTHER },
    });
    expect(refused.status).toBe(409);
    expect(refused.headers.get("X-Error-Code")).toBe("instance_changed");
    expect(await codeOf(refused)).toBe("instance_changed");
    expect(await notes("named other")).toBe(0);
    // The witness: the same body without the header is written.
    expect((await write("/items", { body: note("named other") })).status).toBe(
      201,
    );
    expect(await notes("named other")).toBe(1);
  });

  it("refuses a value that is not one lowercase UUIDv7 400 validation_error", async () => {
    for (const value of [
      "",
      "not-an-id",
      own.toUpperCase(),
      generateId().replace(/^(.{14})7/, "$14"),
      `${own}, ${own}`,
    ]) {
      const res = await write("/items", {
        body: note(`malformed ${value}`),
        headers: { [HEADER]: value },
      });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(await codeOf(res), value).toBe("validation_error");
    }
  });

  it("answers 401 to a write with no credential before it judges the header", async () => {
    for (const value of [OTHER, "not-an-id"]) {
      const res = await write("/items", {
        body: note("no credential"),
        key: null,
        headers: { [HEADER]: value },
      });
      expect(res.status, value).toBe(401);
      expect(await codeOf(res)).toBe("unauthorized");
    }
  });

  it("refuses another instance before the write's own validation", async () => {
    const res = await write("/items", {
      body: { properties: { body: "no type" } },
      headers: { [HEADER]: OTHER },
    });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("instance_changed");
    // The witness: without the header the body is refused for its shape.
    const plain = await write("/items", {
      body: { properties: { body: "no type" } },
    });
    expect(plain.status).toBe(400);
  });

  it("refuses another instance before a body nested too deep, and the depth before a missing credential", async () => {
    let deep: unknown = "x";
    for (let level = 0; level < 70; level++) deep = [deep];
    const body = { type: "core.note", properties: { body: "deep", deep } };
    const elsewhere = await write("/items", {
      body,
      headers: { [HEADER]: OTHER },
    });
    expect(elsewhere.status).toBe(409);
    expect(await codeOf(elsewhere)).toBe("instance_changed");
    // The witnesses: the same body is refused for its depth naming this
    // instance or none, and before the credential when there is none.
    for (const headers of [{ [HEADER]: own }, {}] as Record<string, string>[]) {
      const res = await write("/items", { body, headers });
      expect(res.status, JSON.stringify(headers)).toBe(400);
      expect(await codeOf(res)).toBe("validation_error");
    }
    const anonymous = await write("/items", {
      body,
      key: null,
      headers: { [HEADER]: OTHER },
    });
    expect(anonymous.status).toBe(400);
    expect(await codeOf(anonymous)).toBe("validation_error");
  });

  it("keeps no refusal under an Idempotency-Key, and replays an answer whatever instance header the repeat carries", async () => {
    const key = `instance-${generateId()}`;
    const body = note(`keyed ${key}`);
    const refused = await write("/items", {
      body,
      headers: { "Idempotency-Key": key, [HEADER]: OTHER },
    });
    expect(refused.status).toBe(409);
    expect(await codeOf(refused)).toBe("instance_changed");

    // Not stored under the key: the same write to this instance writes.
    const first = await write("/items", {
      body,
      headers: { "Idempotency-Key": key, [HEADER]: own },
    });
    expect(first.status).toBe(201);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();
    const written = await first.json();

    // Not in the fingerprint: a repeat with no header is the same request.
    const again = await write("/items", {
      body,
      headers: { "Idempotency-Key": key },
    });
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await again.json()).toEqual(written);

    // Judged before the record is read: another instance is refused, not
    // replayed.
    const elsewhere = await write("/items", {
      body,
      headers: { "Idempotency-Key": key, [HEADER]: OTHER },
    });
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await notes(`keyed ${key}`)).toBe(1);
  });

  it("refuses another instance on the two reads sent as a POST", async () => {
    const bulkGet = await write("/items/bulk-get", {
      body: { ids: [generateId()] },
      headers: { [HEADER]: OTHER },
    });
    expect(bulkGet.status).toBe(409);
    expect(await codeOf(bulkGet)).toBe("instance_changed");
    const lookup = await write("/items/lookup", {
      body: { type: "core.note", ids: [generateId()] },
      headers: { [HEADER]: OTHER },
    });
    expect(lookup.status).toBe(409);
    expect(await codeOf(lookup)).toBe("instance_changed");
  });

  it("ignores the header on a GET", async () => {
    for (const value of [OTHER, "not-an-id"]) {
      const res = await ctx.app.request("/items?type=core.note", {
        headers: {
          Authorization: `Bearer ${ctx.workingKey}`,
          [HEADER]: value,
        },
      });
      expect(res.status, value).toBe(200);
    }
  });

  it("ignores the header under /auth", async () => {
    const register = (headers: Record<string, string>) =>
      ctx.app.request("/auth/oauth2/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ redirect_uris: ["not a uri"] }),
      });
    const plain = await register({});
    const named = await register({ [HEADER]: OTHER });
    expect(named.status).toBe(plain.status);
    expect(named.headers.get("X-Error-Code")).not.toBe("instance_changed");
  });
});

describe("the doors that judge the header", () => {
  it("refuses another instance on every write door served after the credential gate, outside /auth", async () => {
    const doors = [
      ...new Set(
        ctx.app.routes
          .filter((route) =>
            ["POST", "PUT", "PATCH", "DELETE"].includes(route.method),
          )
          .filter((route) => route.path !== "/*" && route.path !== "*")
          .filter((route) => !/^\/auth(\/|$)/.test(route.path))
          .filter((route) => !route.path.startsWith("/inbound"))
          .map((route) => `${route.method} ${route.path}`),
      ),
    ];
    // The positive control: an empty walk would pass the loop below.
    expect(doors.length).toBeGreaterThan(50);
    const missed: string[] = [];
    for (const door of doors) {
      const [method, path] = door.split(" ") as [string, string];
      const concrete = path.replace(/:[^/]+/g, generateId());
      const res = await write(concrete, {
        method,
        body: {},
        headers: { [HEADER]: OTHER },
      });
      const code = res.status === 409 ? await codeOf(res) : undefined;
      if (code !== "instance_changed")
        missed.push(`${door} answered ${String(res.status)}`);
    }
    expect(missed).toEqual([]);
  });
});
