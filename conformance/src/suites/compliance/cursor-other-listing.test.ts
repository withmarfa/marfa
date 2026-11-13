import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const ABSENT = "01a1bf41-0000-7000-8000-000000000000";

let server: FreshServer;

const send = async (
  key: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const answer = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await answer.text();
  return { status: answer.status, body: text === "" ? {} : JSON.parse(text) };
};

const made = async (path: string, body: unknown): Promise<string> => {
  const answer = await send(server.workingKey, path, "POST", body);
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  const found = [
    answer.body.id,
    (answer.body.item as { id?: string } | undefined)?.id,
  ]
    .concat((answer.body.edge as { id?: string } | undefined)?.id)
    .find((id): id is string => typeof id === "string");
  expect(found).toEqual(expect.any(String));
  return found as string;
};

const withCursor = (path: string, cursor: string) =>
  `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;

interface Listing {
  name: string;
  path: string;
  key: () => string;
}

const listings: Listing[] = [];

beforeAll(async () => {
  server = await bootFreshServer("cursor-other-listing");
  const notes: string[] = [];
  for (const at of [0, 1, 2]) {
    notes.push(
      await made("/items", {
        type: "core.note",
        properties: { body: `findable note ${String(at)}` },
      }),
    );
  }
  const [first, second, third] = notes as [string, string, string];
  for (const version of [1, 2]) {
    const changed = await send(server.workingKey, `/items/${first}`, "PATCH", {
      properties: { body: `findable again ${String(version)}` },
      version,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  }
  for (const target of [second, third]) {
    await made("/edges", {
      source_id: first,
      target_id: target,
      edge_type: "about",
    });
  }
  await made("/edges", {
    source_id: third,
    target_id: second,
    edge_type: "about",
  });
  const view = await made("/views", { title: "every note" });
  const working = () => server.workingKey;
  const managing = () => server.managementKey;
  listings.push(
    { name: "items", path: "/items?limit=1", key: working },
    { name: "search", path: "/search?q=findable&limit=1", key: working },
    {
      name: "versions",
      path: `/items/${first}/versions?limit=1`,
      key: working,
    },
    { name: "edges", path: "/edges?limit=1", key: working },
    {
      name: "outbound edges",
      path: `/items/${first}/edges?limit=1`,
      key: working,
    },
    {
      name: "backrefs",
      path: `/items/${second}/backrefs?limit=1`,
      key: working,
    },
    { name: "view items", path: `/views/${view}/items?limit=1`, key: working },
    { name: "audit", path: "/audit?limit=1", key: managing },
  );
}, FRESH_SERVER_TIMEOUT_MS);

describe("a cursor", () => {
  it("is short and made only of characters a URL carries as they are", async () => {
    for (const listing of listings) {
      const page = await send(listing.key(), listing.path);
      const cursor = page.body.next_cursor as string;
      expect(cursor, listing.name).toEqual(expect.any(String));
      expect(cursor, listing.name).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
      expect(cursor.length, `${listing.name}: ${cursor}`).toBeLessThanOrEqual(
        100,
      );
    }
  });

  it("is refused at every listing but the one that issued it, naming cursor", async () => {
    const issued: { from: string; cursor: string }[] = [];
    for (const listing of listings) {
      const page = await send(listing.key(), listing.path);
      expect(page.status, `${listing.name}: ${JSON.stringify(page.body)}`).toBe(
        200,
      );
      const cursor = page.body.next_cursor;
      expect(cursor, listing.name).toEqual(expect.any(String));
      const next = await send(
        listing.key(),
        withCursor(listing.path, cursor as string),
      );
      expect(next.status, `${listing.name} continues`).toBe(200);
      issued.push({ from: listing.name, cursor: cursor as string });
    }

    const taking: Listing[] = [
      ...listings,
      {
        name: "connector runs",
        path: `/connectors/${ABSENT}/runs?limit=1`,
        key: () => server.managementKey,
      },
      {
        name: "connector agreements",
        path: `/connectors/${ABSENT}/agreements?limit=1`,
        key: () => server.managementKey,
      },
    ];
    const taken: string[] = [];
    for (const listing of taking) {
      for (const { from, cursor } of issued) {
        if (from === listing.name) continue;
        const answer = await send(
          listing.key(),
          withCursor(listing.path, cursor),
        );
        const error = answer.body.error as
          { code?: string; details?: { field?: string } } | undefined;
        if (
          answer.status !== 400 ||
          error?.code !== "validation_error" ||
          error.details?.field !== "cursor"
        ) {
          taken.push(
            `${listing.name} given a cursor from ${from}: ${String(answer.status)} ${JSON.stringify(answer.body)}`,
          );
        }
      }
    }
    expect(taken).toEqual([]);
  });
});
