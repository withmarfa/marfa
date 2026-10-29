import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  approvedAppToken,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

interface Overview {
  instance: { name: string; version: string; release?: string };
  credential: {
    kind: string;
    label?: string;
    type_permissions?: Record<string, string[]>;
    permissions?: string[];
  };
  types?: { id: string; description?: string; count: number }[];
  total?: number;
  edge_types?: { id: string; description?: string; access: string }[];
  tags?: { tag: string; count: number }[];
  views?: { id: string; title: string }[];
  folders?: { id: string; title: string }[];
  truncated?: Record<string, number>;
}

let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("overview");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function send(
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function overview(token: string): Promise<Overview> {
  const response = await send(token, "GET", "/overview");
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Overview;
}

async function mintKey(
  source: string,
  grant: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`${server.apiUrl}/keys`, {
    method: "POST",
    headers: {
      cookie: server.ownerCookie,
      origin: new URL(server.apiUrl).origin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ label: source, source, ...grant }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { key: string }).key;
}

async function create(
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await send(server.workingKey, "POST", path, body);
  expect(response.status, await response.clone().text()).toBe(201);
}

describe("GET /overview", () => {
  it("answers the instance, the key, and what it reads with counts, tags, edge types, views and folders", async () => {
    await create("/items", {
      type: "core.note",
      properties: { body: "one" },
      tags: ["alpha"],
    });
    await create("/items", {
      type: "core.note",
      properties: { body: "two" },
      tags: ["alpha", "beta"],
    });
    await create("/items", {
      type: "core.bookmark",
      properties: { url: "https://example.test/" },
    });
    await create("/views", { title: "Reading list" });
    await create("/views", { title: "Archive" });
    await create("/folders", {
      title: "Project",
      query: { types: ["core.note"] },
    });
    await create("/folders", {
      title: "Inbox",
      query: { types: ["core.note"] },
    });
    await create("/types", {
      id: "user.overview_runtime",
      version: 1,
      label: "Runtime",
      description: "Registered while the server runs.",
      fields: { name: { type: "string" } },
    });
    await create("/items", {
      type: "user.overview_runtime",
      properties: { name: "x" },
    });

    const answer = await overview(server.workingKey);
    await expectMatchesSchema("GET", "/overview", 200, answer);

    expect(answer.instance).toMatchObject({
      name: expect.any(String),
      version: expect.any(String),
    });
    expect(answer.credential).toMatchObject({
      kind: "key",
      label: expect.any(String),
      type_permissions: { write: ["*"] },
    });
    expect(answer.credential.permissions).toContain("schema.write");
    const types = answer.types ?? [];
    expect(types.find((t) => t.id === "core.note")?.count).toBe(2);
    expect(types.find((t) => t.id === "core.bookmark")?.count).toBe(1);
    expect(types.find((t) => t.id === "user.overview_runtime")).toEqual({
      id: "user.overview_runtime",
      description: "Registered while the server runs.",
      count: 1,
    });
    expect(types.map((t) => t.count)).toEqual(
      types.map((t) => t.count).sort((a, b) => b - a),
    );
    expect(types.some((t) => t.id.startsWith("system."))).toBe(false);
    expect(answer.total).toBe(types.reduce((sum, t) => sum + t.count, 0));
    expect(answer.tags).toEqual([
      { tag: "alpha", count: 2 },
      { tag: "beta", count: 1 },
    ]);
    expect(answer.views).toEqual([
      { id: expect.any(String), title: "Archive" },
      { id: expect.any(String), title: "Reading list" },
    ]);
    expect(answer.folders).toEqual([
      { id: expect.any(String), title: "Inbox" },
      { id: expect.any(String), title: "Project" },
    ]);
    expect(answer.edge_types?.length).toBeGreaterThan(0);
    for (const edgeType of answer.edge_types ?? []) {
      expect(edgeType.access).toBe("write");
    }
    expect(answer.edge_types?.map((e) => e.id)).toEqual(
      (answer.edge_types ?? []).map((e) => e.id).sort(),
    );
    expect(answer.truncated).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain("null");
  });

  it("leaves out a type the key cannot read and everything counted from it", async () => {
    await create("/items", {
      type: "core.bookmark",
      properties: { url: "https://example.test/private" },
      tags: ["only-on-bookmarks"],
    });
    const narrow = await mintKey("overview-narrow", {
      permissions: [],
      type_permissions: { "core.note": "read" },
    });

    const answer = await overview(narrow);

    expect(answer.types?.map((t) => t.id)).toEqual(["core.note"]);
    expect(answer.total).toBe(2);
    expect(answer.tags?.map((t) => t.tag)).toEqual(["alpha", "beta"]);
    expect(answer.views).toBeUndefined();
    expect(answer.folders).toBeUndefined();
    expect(answer.credential.type_permissions).toEqual({
      read: ["core.note"],
    });
    expect(answer.credential.permissions).toBeUndefined();
    const witness = await overview(server.workingKey);
    expect(witness.types?.map((t) => t.id)).toContain("core.bookmark");
    expect(witness.total).toBeGreaterThan(2);
    expect(witness.tags?.map((t) => t.tag)).toContain("only-on-bookmarks");
  });

  it("answers a key that reaches no type with the instance and itself only", async () => {
    const none = await mintKey("overview-none", {
      permissions: [],
      type_permissions: {},
      edge_permissions: { "*": "write" },
    });
    const answer = await overview(none);
    expect(Object.keys(answer).sort()).toEqual(["credential", "instance"]);
    expect(answer.credential.kind).toBe("key");
    const witness = await overview(
      await mintKey("overview-edges-only", {
        permissions: [],
        type_permissions: { "core.note": "read" },
        edge_permissions: { "*": "write" },
      }),
    );
    expect(witness.edge_types?.length).toBeGreaterThan(0);
  });

  it("reports a signed-in app as an app with the scopes it was granted", async () => {
    const token = await approvedAppToken(server, ["core.note:read"]);
    const answer = await overview(token);
    expect(answer.credential.kind).toBe("app");
    expect(answer.credential.label).toBeUndefined();
    expect(answer.credential.type_permissions).toEqual({
      read: ["core.note"],
    });
    expect(answer.types?.map((t) => t.id)).toEqual(["core.note"]);
  });

  it("refuses a request with no credential, the owner's browser session and the private command, and answers a key", async () => {
    expect((await send(undefined, "GET", "/overview")).status).toBe(401);
    const browser = await fetch(`${server.apiUrl}/overview`, {
      headers: {
        cookie: server.ownerCookie,
        origin: new URL(server.apiUrl).origin,
      },
    });
    expect(browser.status).toBe(401);
    const privateCommand = await controlRequest(
      server.controlSocket,
      "/overview",
    );
    expect(privateCommand.status).toBe(401);
    expect((await send(server.workingKey, "GET", "/overview")).status).toBe(
      200,
    );
  });

  it("holds each list to its cap, says what was cut and keeps the answer small", async () => {
    const long = "d".repeat(2000);
    const body = (id: string) => ({
      id,
      version: 1,
      label: id,
      description: long,
      fields: { name: { type: "string" } },
    });
    for (let i = 0; i < 60; i++) {
      await create("/types", body(`user.bulk_${String(i).padStart(2, "0")}`));
    }
    for (let i = 0; i < 55; i++) {
      await create("/edge-types", {
        id: `bulk.edge_${String(i).padStart(2, "0")}`,
        label: `Edge ${String(i)}`,
        description: long,
        cardinality: "many-to-many",
        cascade_on_delete: "orphan",
      });
    }
    for (let i = 0; i < 40; i++) {
      await create("/items", {
        type: "core.note",
        properties: { body: `tagged ${String(i)}` },
        tags: [`bulk-tag-${String(i).padStart(2, "0")}`],
      });
      await create("/views", {
        title: `${String(i).padStart(2, "0")} view ${long.slice(0, 120)}`,
      });
      await create("/folders", {
        title: `${String(i).padStart(2, "0")} folder ${long.slice(0, 120)}`,
        query: { types: ["core.note"] },
      });
    }
    const patterns = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `user.bulk_${String(i).padStart(2, "0")}`,
        "read",
      ]),
    );
    const key = await mintKey("overview-wide", {
      permissions: [],
      type_permissions: { "*": "read", ...patterns },
      edge_permissions: { "*": "read" },
    });

    const response = await send(key, "GET", "/overview");
    expect(response.status).toBe(200);
    const text = await response.text();
    const answer = JSON.parse(text) as Overview;

    expect(answer.types).toHaveLength(50);
    expect(answer.truncated?.types).toBeGreaterThanOrEqual(61);
    expect(answer.edge_types).toHaveLength(50);
    expect(answer.truncated?.edge_types).toBeGreaterThanOrEqual(55);
    expect(answer.edge_types?.every((e) => e.access === "read")).toBe(true);
    for (const entry of answer.edge_types ?? []) {
      expect(Array.from(entry.description ?? "").length).toBeLessThanOrEqual(
        100,
      );
    }
    expect(answer.tags).toHaveLength(30);
    expect(answer.truncated?.tags).toBeGreaterThanOrEqual(40);
    expect(answer.views).toHaveLength(30);
    expect(answer.truncated?.views).toBe(42);
    expect(answer.folders).toHaveLength(30);
    expect(answer.truncated?.folders).toBe(42);
    for (const list of [answer.views ?? [], answer.folders ?? []]) {
      for (const entry of list) {
        expect(Array.from(entry.title).length).toBeLessThanOrEqual(100);
      }
      const titles = list.map((entry) => entry.title);
      expect(titles).toEqual([...titles].sort());
    }
    expect(answer.credential.type_permissions?.read).toHaveLength(30);
    expect(answer.truncated?.["credential.type_permissions.read"]).toBe(41);
    for (const entry of answer.types ?? []) {
      expect(Array.from(entry.description ?? "").length).toBeLessThanOrEqual(
        100,
      );
    }
    expect(text.length).toBeLessThan(30_000);
    const witness = await overview(server.workingKey);
    expect(witness.truncated?.types).toBeGreaterThanOrEqual(61);
  });
});
