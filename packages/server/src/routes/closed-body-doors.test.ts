/**
 * Every JSON write body refuses a top-level key its door does not declare,
 * in one shape, and writes nothing.
 *
 * **A census rather than a test per door, because the gap is in how the
 * library validates a body and a door added later falls into it unseen.** The
 * doors are found in the app's own OpenAPI document: an operation with a
 * JSON request body. Each one's body has to be marked as accepting no other
 * keys, or be named below with why its body is open.
 *
 * Below the census, the doors that used to drop a key are driven with a
 * valid body, first alone to show the write is producible, then with a key
 * the door does not declare, which has to answer `400 validation_error` with
 * the key in `details.unknown_body_fields` and leave the store as it was. A
 * key starting with an underscore is refused like any other.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
} from "../openapi-finalize.js";
import {
  createTestContext,
  inlineOpenApiRefs,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { createClaimTestApp } from "../auth/claim-test-app.js";
import { issueSetupCode } from "../auth/instance-claim.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/**
 * Doors whose body is open by design, each with why. A door is never listed
 * here because closing it was inconvenient.
 */
const OPEN_BODY: Record<string, string> = {
  "PUT /items/{id}/extensions/{namespace}":
    "the body is the extension's own document, whose keys the namespace's owner decides",
  "POST /auth/oauth2/register":
    "RFC 7591 registration: a server ignores client metadata it does not understand",
};

interface Schema {
  type?: string;
  additionalProperties?: unknown;
  oneOf?: Schema[];
  anyOf?: Schema[];
}

interface Operation {
  requestBody?: { content?: Record<string, { schema?: Schema }> };
}

/** Every write operation the published document carries. */
function documentedWrites(): Set<string> {
  const document = finalizeOpenAPISpec(
    ctx.app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: OPENAPI_DOCUMENT_INFO,
    }),
  ) as unknown as { paths: Record<string, Record<string, unknown>> };
  const out = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) {
      if (["post", "put", "patch"].includes(method)) {
        out.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return out;
}

/**
 * Write routes the app serves that the document does not carry, each with
 * how its body is read. The census finds them from the route table, so a
 * handler added without a place in the document has to be classified here
 * before this file goes green.
 */
const UNPUBLISHED_WRITES: Record<string, string> = {
  "POST /setup/exchange":
    "JSON, closed: refused here by the handler (tested below)",
  "POST /setup/claim":
    "JSON is closed: refused here by the handler (tested below); a form submission is read by field name and is not a JSON body",
  "POST /auth/owner/password": "a same-origin form post, not a JSON body",
  "POST /inbound/{token}":
    "a sender's delivery, whatever bytes it sent, recorded as it arrived",
  "POST /auth/sign-in": "a form post, not a JSON body",
  "POST /auth/authorize/decision": "a form post, not a JSON body",
  "POST /auth/device": "a form post, not a JSON body",
  "POST /auth/device/consent": "a form post, not a JSON body",
  "POST /auth/{wildcard}":
    "the sign-in library's own protocol endpoints, which answer in their own shapes; its registration follows RFC 7591 and is open by design",
  "ALL /{wildcard}":
    "middleware registered for every path, ahead of the handlers; it answers no request of its own and reads no body into a write",
  "ALL /owner/{wildcard}":
    "the guard in front of the owner routes, which the document carries; it reads no body",
  "ALL /setup/{wildcard}":
    "the guard in front of the setup routes, whose handlers are classified above; it reads no body",
  "ALL /auth/owner/{wildcard}":
    "the guard in front of the owner's browser pages, whose writes are classified above; it reads no body",
};

function servedWrites(): Set<string> {
  const out = new Set<string>();
  for (const route of ctx.app.routes) {
    // `ALL` is what Hono records for `app.all` and `app.mount` as well as for
    // middleware, so none can be told from a handler by its method.
    if (!["POST", "PUT", "PATCH", "ALL"].includes(route.method)) continue;
    const path = route.path
      .replace(/\/\*$/, "/{wildcard}")
      .replace(/:([A-Za-z_]+)/g, "{$1}");
    out.add(`${route.method} ${path}`);
  }
  return out;
}

function jsonBodies(): Map<string, Schema> {
  const document = finalizeOpenAPISpec(
    ctx.app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: OPENAPI_DOCUMENT_INFO,
    }),
  ) as unknown as Record<string, unknown>;
  const paths = inlineOpenApiRefs(document.paths, document) as Record<
    string,
    Record<string, Operation>
  >;
  const out = new Map<string, Schema>();
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const content = operation.requestBody?.content ?? {};
      const type = Object.keys(content).find((t) =>
        /^application\/([a-z-.]+\+)?json/i.test(t),
      );
      const schema = type === undefined ? undefined : content[type]?.schema;
      if (schema !== undefined) {
        out.set(`${method.toUpperCase()} ${path}`, schema);
      }
    }
  }
  return out;
}

/** Whether a body schema says it accepts no key it does not declare. */
function closed(schema: Schema): boolean {
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants !== undefined) return variants.every(closed);
  return schema.type === "object" && schema.additionalProperties === false;
}

describe("the JSON write bodies", () => {
  it("are found, among them one that is open and one that is closed", () => {
    const bodies = jsonBodies();
    expect(bodies.size).toBeGreaterThan(30);
    expect(closed(bodies.get("POST /items")!)).toBe(true);
    expect(closed(bodies.get("PUT /items/{id}/extensions/{namespace}")!)).toBe(
      false,
    );
  });

  it("all accept no other keys, or are named as open with why", () => {
    const open = [...jsonBodies()]
      .filter(([door, schema]) => !closed(schema) && !(door in OPEN_BODY))
      .map(([door]) => door);
    expect(open).toEqual([]);
  });

  it("name no exemption that is stale or closed", () => {
    const bodies = jsonBodies();
    for (const door of Object.keys(OPEN_BODY)) {
      const schema = bodies.get(door);
      expect(schema, `stale: ${door} is not a JSON door`).toBeDefined();
      expect(closed(schema!), `${door} is closed`).toBe(false);
    }
  });
});

/** The served write routes nothing in the document or the table accounts for. */
function unclassified(
  served: Iterable<string>,
  documented: ReadonlySet<string>,
): string[] {
  return [...served].filter(
    (door) => !documented.has(door) && !(door in UNPUBLISHED_WRITES),
  );
}

describe("the write routes the app serves", () => {
  it("are the document's, or are classified here with how their body is read", () => {
    const documented = documentedWrites();
    // The witness: the route table holds both kinds, so a door missing from
    // the document would be seen.
    expect(servedWrites()).toContain("POST /items");
    expect(servedWrites()).toContain("POST /setup/claim");
    expect(unclassified(servedWrites(), documented)).toEqual([]);
  });

  it("find a handler mounted for every method, which the route table records as ALL", () => {
    const documented = documentedWrites();
    expect([...servedWrites()].some((door) => door.startsWith("ALL "))).toBe(
      true,
    );
    expect(
      unclassified([...servedWrites(), "ALL /mounted/{wildcard}"], documented),
    ).toEqual(["ALL /mounted/{wildcard}"]);
  });

  it("name no classification that is stale", () => {
    const served = servedWrites();
    const documented = documentedWrites();
    for (const door of Object.keys(UNPUBLISHED_WRITES)) {
      expect(served.has(door), `stale: ${door} is not served`).toBe(true);
      expect(documented.has(door), `${door} is in the document`).toBe(false);
    }
  });
});

describe("the setup doors", () => {
  const origin = "http://localhost:8600";
  const post = (
    app: { request: (path: string, init: RequestInit) => unknown },
    path: string,
    body: unknown,
  ) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify(body),
    }) as Promise<Response>;

  it("POST /setup/exchange refuses a key it does not declare and keeps the setup code unspent", async () => {
    const fresh = await createClaimTestApp(origin);
    try {
      const { code } = await issueSetupCode(fresh.storage);
      for (const key of ["bogus", "_trace"]) {
        const refused = await post(fresh.app, "/setup/exchange", {
          code,
          [key]: 1,
        });
        const text = await refused.text();
        expect(refused.status, text).toBe(400);
        const refusal = JSON.parse(text) as Refusal;
        expect(refusal.error.code).toBe("validation_error");
        expect(refusal.error.details?.unknown_body_fields).toEqual([key]);
        expect(refused.headers.get("set-cookie")).toBeNull();
      }
      const exchanged = await post(fresh.app, "/setup/exchange", { code });
      expect(exchanged.status, await exchanged.clone().text()).toBe(200);
    } finally {
      await fresh.cleanup();
    }
  });

  it("POST /setup/claim refuses a key it does not declare in a JSON body and claims nothing", async () => {
    const fresh = await createClaimTestApp(origin);
    try {
      const { code } = await issueSetupCode(fresh.storage);
      const body = {
        email: "someone@example.test",
        password: "a password for the owner",
        code,
      };
      for (const key of ["bogus", "_trace"]) {
        const refused = await post(fresh.app, "/setup/claim", {
          ...body,
          [key]: 1,
        });
        const text = await refused.text();
        expect(refused.status, text).toBe(400);
        const refusal = JSON.parse(text) as Refusal;
        expect(refusal.error.details?.unknown_body_fields).toEqual([key]);
      }
      const claimed = await post(fresh.app, "/setup/claim", body);
      expect(claimed.status, await claimed.clone().text()).toBe(201);
    } finally {
      await fresh.cleanup();
    }
  });
});

interface Refusal {
  error: {
    code: string;
    details?: { unknown_body_fields?: string[]; errors?: unknown };
  };
}

/** One door, set up with a body it accepts and a way to read what it wrote. */
interface Setup {
  method: string;
  path: string;
  body: Record<string, unknown>;
  /** What the store holds that the door would change. */
  seen: () => Promise<unknown>;
  /** The status the valid body is answered with. */
  ok: number;
}

async function note(tags: string[] = []): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "a note" }, tags },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function read(path: string): Promise<unknown> {
  const res = await request(ctx.app, "GET", path, { key: ctx.workingKey });
  const body: unknown = await res.json();
  return { status: res.status, body };
}

async function itemDoor(
  method: string,
  suffix: string,
  body: Record<string, unknown>,
): Promise<Setup> {
  const id = await note(["kept"]);
  return {
    method,
    path: `/items/${id}${suffix}`,
    body,
    seen: async () => [
      await read(`/items/${id}`),
      await read(`/items/${id}/metadata`),
    ],
    ok: 200,
  };
}

const DOORS: Record<string, () => Promise<Setup>> = {
  "POST /items/{id}/transition": () =>
    itemDoor("POST", "/transition", { state: "archived" }),
  "PUT /items/{id}/metadata": () =>
    itemDoor("PUT", "/metadata", { tags: ["replaced"] }),
  "PATCH /items/{id}/metadata": () =>
    itemDoor("PATCH", "/metadata", { tags: ["merged"] }),
  "POST /items/{id}/tags": () => itemDoor("POST", "/tags", { tags: ["added"] }),
  "POST /items/bulk-get": async () => {
    const id = await note();
    return {
      method: "POST",
      path: "/items/bulk-get",
      body: { ids: [id] },
      seen: () => Promise.resolve(undefined),
      ok: 200,
    };
  },
  "POST /webhooks": () =>
    Promise.resolve({
      method: "POST",
      path: "/webhooks",
      body: { url: "https://example.com/closed", events: ["item.created"] },
      seen: () => read("/webhooks"),
      ok: 201,
    }),
  "PATCH /webhooks/{id}": async () => {
    const created = await request(ctx.app, "POST", "/webhooks", {
      key: ctx.workingKey,
      body: { url: "https://example.com/patched", events: ["item.created"] },
    });
    const { id } = (await created.json()) as { id: string };
    return {
      method: "PATCH",
      path: `/webhooks/${id}`,
      body: { active: false },
      seen: () => read(`/webhooks/${id}`),
      ok: 200,
    };
  },
};

describe.each(Object.keys(DOORS))("%s", (door) => {
  const KEYS = [["bogus"], ["_trace"], ["_trace", "bogus"]];

  it("takes a valid body, so the refusals below are of a producible write", async () => {
    const setup = await DOORS[door]!();
    const res = await request(ctx.app, setup.method, setup.path, {
      key: ctx.workingKey,
      body: setup.body,
    });
    expect(res.status, await res.clone().text()).toBe(setup.ok);
  });

  for (const keys of KEYS) {
    it(`refuses ${keys.join(" and ")}, naming ${keys.length === 1 ? "it" : "both"}, and writes nothing`, async () => {
      const setup = await DOORS[door]!();
      const before = await setup.seen();
      const res = await request(ctx.app, setup.method, setup.path, {
        key: ctx.workingKey,
        body: {
          ...setup.body,
          ...Object.fromEntries(keys.map((key) => [key, 1])),
        },
      });
      const text = await res.text();
      expect(res.status, text).toBe(400);
      const refusal = JSON.parse(text) as Refusal;
      expect(refusal.error.code).toBe("validation_error");
      expect(refusal.error.details?.unknown_body_fields).toEqual(keys);
      expect(refusal.error.details?.errors).toBeUndefined();
      expect(await setup.seen()).toEqual(before);
    });
  }
});

describe("a body carrying many undeclared keys", () => {
  it("names every one in details and only the first few in the message", async () => {
    const setup = await DOORS["POST /items/bulk-get"]!();
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `extra_${String(i).padStart(2, "0")}`,
        1,
      ]),
    );
    const res = await request(ctx.app, setup.method, setup.path, {
      key: ctx.workingKey,
      body: { ...setup.body, ...many },
    });
    expect(res.status).toBe(400);
    const refusal = (await res.json()) as {
      error: { message: string; details: { unknown_body_fields: string[] } };
    };
    expect(refusal.error.details.unknown_body_fields).toEqual(
      Object.keys(many).sort(),
    );
    expect(refusal.error.message).toContain("and 10 more");
    expect(refusal.error.message).not.toContain("extra_29");
  });
});

describe("POST /owner", () => {
  it("refuses a key it does not declare and claims nothing, where the same body claims", async () => {
    const fresh = await createClaimTestApp();
    try {
      const { code } = await issueSetupCode(fresh.storage);
      const body = {
        email: "someone@example.test",
        password: "a password for the owner",
        code,
      };
      const send = (extra: Record<string, unknown>) =>
        fresh.app.request("/owner", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, ...extra }),
        });
      for (const key of ["bogus", "_trace"]) {
        const refused = await send({ [key]: 1 });
        const text = await refused.text();
        expect(refused.status, text).toBe(400);
        const refusal = JSON.parse(text) as Refusal;
        expect(refusal.error.code).toBe("validation_error");
        expect(refusal.error.details?.unknown_body_fields).toEqual([key]);
      }
      // The refused attempts left the setup code unspent.
      const claimed = await send({});
      expect(claimed.status, await claimed.clone().text()).toBe(201);
    } finally {
      await fresh.cleanup();
    }
  });
});
