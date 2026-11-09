import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { servedDocument } from "../../utils/openapi.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

/**
 * What each listing does with `limit`, on a server of the file's own: the bin
 * and the audit log are the instance's whole history, and other files empty
 * the bin of the shared server.
 */

interface Door {
  door: string;
  who: "working" | "management" | "owner" | "local";
  max: number;
  capped?: boolean;
  /** The page a request with no `limit` gets, where more rows than that are seeded. */
  size?: number;
  path: () => string;
}

interface Answer {
  status: number;
  rows: unknown[];
  nextCursor: string | null;
  code?: string;
  errors?: unknown;
}

const DEFAULT_ROWS = 51;
const TRASH_ROWS = 26;

let server: FreshServer;
let receiver: Receiver;
let word = "";
let hub = "";
let target = "";
let trail = "";
let hook = "";
let view = "";
let connector = "";

const doors: Door[] = [
  {
    door: "GET /items",
    who: "working",
    max: 500,
    capped: true,
    size: 50,
    path: () => "/items",
  },
  {
    door: "GET /edges",
    who: "working",
    max: 500,
    capped: true,
    size: 50,
    path: () => "/edges",
  },
  {
    door: "GET /items/{id}/edges",
    who: "working",
    max: 500,
    capped: true,
    size: 50,
    path: () => `/items/${hub}/edges`,
  },
  {
    door: "GET /items/{id}/backrefs",
    who: "working",
    max: 500,
    capped: true,
    size: 50,
    path: () => `/items/${target}/backrefs`,
  },
  {
    door: "GET /search",
    who: "working",
    max: 100,
    size: 20,
    path: () => `/search?q=${word}`,
  },
  {
    door: "GET /audit",
    who: "management",
    max: 200,
    size: 50,
    path: () => "/audit",
  },
  {
    door: "GET /webhooks/{id}/deliveries",
    who: "working",
    max: 200,
    size: 50,
    path: () => `/webhooks/${hook}/deliveries`,
  },
  {
    door: "GET /trash",
    who: "owner",
    max: 200,
    size: 25,
    path: () => "/trash",
  },
  {
    door: "GET /items/summaries",
    who: "owner",
    max: 200,
    size: 50,
    path: () => "/items/summaries",
  },
  {
    door: "GET /views/{id}/items",
    who: "working",
    max: 200,
    size: 50,
    path: () => `/views/${view}/items`,
  },
  {
    door: "GET /items/{id}/versions",
    who: "working",
    max: 200,
    path: () => `/items/${hub}/versions`,
  },
  {
    door: "GET /connectors/{id}/runs",
    who: "working",
    max: 200,
    path: () => `/connectors/${connector}/runs`,
  },
  {
    door: "GET /connectors/{id}/agreements",
    who: "working",
    max: 200,
    path: () => `/connectors/${connector}/agreements`,
  },
  {
    door: "GET /connectors/{id}/deliveries",
    who: "working",
    max: 200,
    path: () => `/connectors/${connector}/deliveries`,
  },
  { door: "GET /folders", who: "local", max: 200, path: () => "/folders" },
];
const sized = doors.filter((door) => door.size !== undefined);
const refusing = doors.filter((door) => door.capped !== true);

async function read(door: Door, query = ""): Promise<Answer> {
  const path = door.path();
  const url = `${server.apiUrl}${path}${path.includes("?") ? "&" : "?"}${query}`;
  if (door.who === "local") {
    const answered = await controlRequest(
      server.controlSocket,
      `${path}${path.includes("?") ? "&" : "?"}${query}`,
    );
    const body = answered.body as {
      data?: unknown[];
      next_cursor?: string | null;
      error?: { code: string; details?: { errors?: unknown } };
    };
    return {
      status: answered.status,
      rows: body.data ?? [],
      nextCursor: body.next_cursor ?? null,
      code: body.error?.code,
      errors: body.error?.details?.errors,
    };
  }
  const response = await fetch(url, {
    headers:
      door.who === "owner"
        ? {
            cookie: server.ownerCookie,
            origin: new URL(server.apiUrl).origin,
          }
        : {
            authorization: `Bearer ${
              door.who === "working" ? server.workingKey : server.managementKey
            }`,
          },
  });
  const body = (await response.json()) as {
    data?: unknown[];
    next_cursor?: string | null;
    error?: { code: string; details?: { errors?: unknown } };
  };
  return {
    status: response.status,
    rows: body.data ?? [],
    nextCursor: body.next_cursor ?? null,
    code: body.error?.code,
    errors: body.error?.details?.errors,
  };
}

function expectRefused(answer: Answer, label: string): void {
  expect(answer.status, label).toBe(400);
  expect(answer.code, label).toBe("validation_error");
  expect(answer.errors, label).toMatchObject([{ path: "limit" }]);
}

beforeAll(async () => {
  server = await bootFreshServer("page-limits");
  vi.stubEnv("MARFA_API_URL", server.apiUrl);
  receiver = await startReceiver();
  const working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  word = `pagelimits${String(Date.now())}`;
  const tag = `${word}-view`;

  const created = await working.createWebhook({
    url: receiver.hookUrl("page-limits"),
    events: ["item.created"],
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  hook = created.data.id;

  const bulk = async (count: number, fanout: boolean): Promise<string[]> => {
    const made = await working.bulkItems({
      enable_fanout: fanout,
      items: Array.from({ length: count }, (_, i) => ({
        type: "core.note",
        tags: [tag],
        properties: { title: word, body: `${word} ${String(i)}` },
      })),
    });
    expect(made.status, JSON.stringify(made.error)).toBe(200);
    return made.data.results.map((row) => String(row.id));
  };
  const notes = await bulk(DEFAULT_ROWS, true);

  // A delivery is logged after the receiver answers, so the log is read until
  // it holds them all, and the hook is retired before the other seeds write.
  await vi.waitFor(
    async () => {
      const logged = await working.listWebhookDeliveries(hook, { limit: 200 });
      expect(logged.data.data.length).toBeGreaterThanOrEqual(DEFAULT_ROWS);
    },
    { timeout: 30_000, interval: 250 },
  );
  expect((await working.updateWebhook(hook, { active: false })).ok).toBe(true);

  const [first, second, third] = await bulk(3, false);
  hub = first!;
  target = second!;
  trail = third!;
  const edges = await working.bulkEdges({
    edges: notes.flatMap((note) => [
      { source_id: hub, target_id: note, edge_type: "about" },
      { source_id: note, target_id: target, edge_type: "about" },
    ]),
  });
  expect(edges.status, JSON.stringify(edges.error)).toBe(200);

  for (let i = 0; i < DEFAULT_ROWS; i++) {
    const tagged = await working.addTags(trail, [`trail-${String(i)}`]);
    expect(tagged.ok, JSON.stringify(tagged.error)).toBe(true);
  }

  for (const id of await bulk(TRASH_ROWS, false)) {
    const trashed = await working.deleteItem(id);
    expect(trashed.ok, JSON.stringify(trashed.error)).toBe(true);
  }

  const saved = await working.createView({
    title: "Page limits",
    query: { filter: `tags contains "${tag}"` },
  });
  expect(saved.status, JSON.stringify(saved.error)).toBe(201);
  view = saved.data.item.id;

  const registered = await working.registerConnector({ name: "page limits" });
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  connector = registered.data.id;
}, 4 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await receiver?.close();
  await server?.stop();
  vi.unstubAllEnvs();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("the limit of a listing", () => {
  it("covers every operation that takes a limit", async () => {
    const document = await servedDocument();
    const published = Object.entries(document.paths).flatMap(
      ([path, methods]) =>
        Object.entries(methods)
          .filter(([, operation]) =>
            (
              (operation as { parameters?: { name: string; in: string }[] })
                .parameters ?? []
            ).some(
              ({ name, in: where }) => name === "limit" && where === "query",
            ),
          )
          .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(published.sort()).toEqual(doors.map(({ door }) => door).sort());
  });

  it.each(sized)(
    "$door answers its default page where it names no limit",
    async (door) => {
      const page = await read(door);
      expect(page.status).toBe(200);
      expect(page.rows).toHaveLength(door.size!);
      expect(page.nextCursor).not.toBeNull();
      // The witness: more rows are held than the default page.
      const wider = await read(door, `limit=${String(door.size! + 1)}`);
      expect(wider.status).toBe(200);
      expect(wider.rows).toHaveLength(door.size! + 1);
    },
  );

  it.each(doors)(
    "$door refuses a limit of 0, a negative and a non-number, naming limit",
    async (door) => {
      for (const limit of ["0", "-1", "abc"]) {
        expectRefused(await read(door, `limit=${limit}`), `limit=${limit}`);
      }
      // The witness: the same door answers a limit it takes.
      expect((await read(door, "limit=1")).status).toBe(200);
    },
  );

  it.each(refusing)(
    "$door takes its largest page and refuses a limit past it or a fraction",
    async (door) => {
      expect((await read(door, `limit=${String(door.max)}`)).status).toBe(200);
      const over = `limit=${String(door.max + 1)}`;
      expectRefused(await read(door, over), over);
      expectRefused(await read(door, "limit=1.5"), "limit=1.5");
    },
  );
});
