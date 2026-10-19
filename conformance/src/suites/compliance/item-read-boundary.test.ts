import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let server: FreshServer;
let reader: string;

async function call(
  method: string,
  path: string,
  body?: unknown,
  key = server.workingKey,
): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  server = await bootFreshServer("item-read-boundary");
  const minted = await fetch(`${server.apiUrl}/keys`, {
    method: "POST",
    headers: {
      Cookie: server.ownerCookie,
      Origin: new URL(server.apiUrl).origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      label: "Read boundary",
      source: "read-boundary",
      type_permissions: { "core.note": "read", "core.event": "read" },
      extension_permissions: { "*": "read" },
      edge_permissions: { "*": "read" },
      permissions: [],
    }),
  });
  expect(minted.status).toBe(201);
  reader = ((await minted.json()) as { key: string }).key;
  expect(
    (
      await call("POST", "/types", {
        id: "fixture.private",
        version: 1,
        fields: {},
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call("POST", "/types", {
        id: "fixture.private_event",
        parent: "core.event",
        version: 1,
        fields: {},
      })
    ).status,
  ).toBe(201);
}, FRESH_SERVER_TIMEOUT_MS);
afterEach(async () => {
  await server.clearFault();
});
afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function note(
  tier = "library",
): Promise<{ id: string; version: number }> {
  const created = await call("POST", "/items", {
    type: "core.note",
    properties: { body: "public" },
    tags: ["public"],
    tier,
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { item: { id: string; version: number } })
    .item;
}

async function makePrivate(
  item: { id: string; version: number },
  type = "fixture.private",
): Promise<void> {
  expect(
    (
      await call("PATCH", `/items/${item.id}`, {
        version: item.version,
        type,
        retype: true,
        properties: { body: "private-body" },
      })
    ).status,
  ).toBe(200);
  expect(
    (await call("PUT", `/items/${item.id}/metadata`, { tags: ["private-tag"] }))
      .status,
  ).toBe(200);
}

it("keeps item and metadata reads in the state that authorized them during a retype", async () => {
  for (const surface of ["item", "metadata", "list", "feed", "bulk"] as const) {
    const item = await note(surface === "feed" ? "feed" : "library");
    const path =
      surface === "item"
        ? `/items/${item.id}`
        : surface === "metadata"
          ? `/items/${item.id}/metadata`
          : surface === "bulk"
            ? "/items/bulk-get"
            : `/items?include=metadata,edges,extensions${surface === "feed" ? "&tier=feed" : ""}`;
    const read = () =>
      call(
        surface === "bulk" ? "POST" : "GET",
        path,
        surface === "bulk"
          ? { ids: [item.id], include: ["metadata", "edges", "extensions"] }
          : undefined,
        reader,
      );
    expect((await read()).status, surface).toBe(200);
    await server.setFault("hold:read-hydration");
    const pending = read();
    try {
      await server.waitForHold("hold:read-hydration");
      await makePrivate(item);
    } finally {
      await server.clearFault();
    }
    const response = await pending;
    expect(response.status, surface).toBe(200);
    const body = await response.text();
    expect(body, surface).toContain('"public"');
    expect(body, surface).not.toContain("private-tag");
    expect(
      (await call("GET", `/items/${item.id}`, undefined, reader)).status,
    ).toBe(404);
    const witness = await call("GET", `/items/${item.id}`);
    expect(witness.status).toBe(200);
    expect(await witness.text()).toContain("private-tag");
  }
});

it("authorizes hydrated occurrences after a concurrent retype", async () => {
  const created = await call("POST", "/items", {
    type: "core.event",
    properties: {
      title: "public-event",
      starts_at: "2028-03-01T10:00:00Z",
      ends_at: "2028-03-01T11:00:00Z",
    },
  });
  expect(created.status).toBe(201);
  const { item } = (await created.json()) as {
    item: { id: string; version: number };
  };
  const read = () =>
    call(
      "GET",
      "/occurrences?from=2028-03-01T00:00:00Z&to=2028-03-02T00:00:00Z",
      undefined,
      reader,
    );
  expect(await (await read()).text()).toContain("public-event");
  await server.setFault("hold:read-hydration");
  const pending = read();
  try {
    await server.waitForHold("hold:read-hydration");
    await makePrivate(item, "fixture.private_event");
  } finally {
    await server.clearFault();
  }
  const response = await pending;
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain("private-body");
  expect(body).not.toContain(item.id);
  expect(await (await read()).text()).not.toContain(item.id);
  const witness = await call("GET", `/items/${item.id}`);
  expect(witness.status).toBe(200);
  expect(await witness.text()).toContain("private-body");
});

it("authorizes occurrence parent relationships with their source state", async () => {
  const createEvent = async (properties: Record<string, unknown>) => {
    const response = await call("POST", "/items", {
      type: "core.event",
      properties,
    });
    expect(response.status).toBe(201);
    return (
      (await response.json()) as { item: { id: string; version: number } }
    ).item;
  };
  const series = await createEvent({
    title: "public series",
    starts_at: "2028-04-01T10:00:00Z",
    recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
  });
  const exception = await createEvent({
    title: "public exception",
    starts_at: "2028-04-02T12:00:00Z",
    original_starts_at: "2028-04-02T10:00:00Z",
  });
  const read = (key = reader) =>
    call(
      "GET",
      "/occurrences?from=2028-04-01T00:00:00Z&to=2028-04-03T00:00:00Z",
      undefined,
      key,
    );
  const baseline = await read();
  expect(baseline.status).toBe(200);
  expect(await baseline.text()).toContain(series.id);
  await server.setFault("hold:read-hydration");
  const pending = read();
  try {
    await server.waitForHold("hold:read-hydration");
    await makePrivate(series, "fixture.private_event");
    const created = await call("POST", "/edges", {
      source_id: series.id,
      target_id: exception.id,
      edge_type: "parent-of",
    });
    expect(created.status).toBe(201);
    const { edge } = (await created.json()) as { edge: { id: string } };
    expect(
      (await call("GET", `/edges/${edge.id}`, undefined, reader)).status,
    ).toBe(404);
  } finally {
    await server.clearFault();
  }
  const exceptionRow = async (response: Response) => {
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { item: { id: string }; series_id?: string; replaces?: string }[];
    };
    return body.data.find((row) => row.item.id === exception.id);
  };
  for (const response of [await pending, await read()]) {
    const row = await exceptionRow(response);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("series_id");
    expect(row).not.toHaveProperty("replaces");
  }
  expect(await exceptionRow(await read(server.workingKey))).toMatchObject({
    series_id: series.id,
    replaces: "2028-04-02T10:00:00.000Z",
  });
});

it("withholds occurrence fields derived from an unreadable relationship", async () => {
  const minted = await fetch(`${server.apiUrl}/keys`, {
    method: "POST",
    headers: {
      Cookie: server.ownerCookie,
      Origin: new URL(server.apiUrl).origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      label: "Events without relationships",
      source: "events-only",
      type_permissions: { "core.event": "read" },
      edge_permissions: {},
      permissions: [],
    }),
  });
  expect(minted.status).toBe(201);
  const noEdges = ((await minted.json()) as { key: string }).key;
  const items: string[] = [];
  for (const properties of [
    {
      title: "readable series",
      starts_at: "2028-05-01T10:00:00Z",
      recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
    },
    {
      title: "readable exception",
      starts_at: "2028-05-02T12:00:00Z",
      original_starts_at: "2028-05-02T10:00:00Z",
    },
  ]) {
    const created = await call("POST", "/items", {
      type: "core.event",
      properties,
    });
    expect(created.status).toBe(201);
    items.push(((await created.json()) as { item: { id: string } }).item.id);
  }
  const [seriesId, exceptionId] = items;
  const created = await call("POST", "/edges", {
    source_id: seriesId,
    target_id: exceptionId,
    edge_type: "parent-of",
  });
  expect(created.status).toBe(201);
  const { edge } = (await created.json()) as { edge: { id: string } };
  expect(
    (await call("GET", `/edges/${edge.id}`, undefined, noEdges)).status,
  ).toBe(404);
  const exceptionRow = async (key: string) => {
    const response = await call(
      "GET",
      "/occurrences?from=2028-05-01T00:00:00Z&to=2028-05-03T00:00:00Z",
      undefined,
      key,
    );
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as {
      data: { item: { id: string }; series_id?: string; replaces?: string }[];
    };
    return data.find((row) => row.item.id === exceptionId);
  };
  expect(await exceptionRow(reader)).toMatchObject({
    series_id: seriesId,
    replaces: "2028-05-02T10:00:00.000Z",
  });
  const row = await exceptionRow(noEdges);
  expect(row).toBeDefined();
  expect(row).not.toHaveProperty("series_id");
  expect(row).not.toHaveProperty("replaces");
});

it("keeps extensions, history, lookup and edge hydration in the authorized state", async () => {
  for (const surface of [
    "extensions",
    "extension",
    "history",
    "lookup",
    "outbound",
    "backrefs",
    "edges",
  ] as const) {
    const item = await note();
    const target = await note();
    const path = `/items/${item.id}`;
    expect(
      (
        await call("PUT", `${path}/extensions/fixture.data`, {
          data: { value: "public-extension" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("POST", "/edges", {
          source_id: item.id,
          target_id: target.id,
          edge_type: "about",
        })
      ).status,
    ).toBe(201);
    // Extension writes advance the item version.
    const current = await call("GET", path);
    const { item: beforeItem } = (await current.json()) as {
      item: { id: string; version: number };
    };
    const readPath =
      surface === "extensions"
        ? `${path}/extensions`
        : surface === "extension"
          ? `${path}/extensions/fixture.data`
          : surface === "history"
            ? `${path}/versions`
            : surface === "outbound"
              ? `${path}/edges`
              : surface === "backrefs"
                ? `${path}/backrefs`
                : surface === "edges"
                  ? "/edges"
                  : "/items/lookup";
    const read = () =>
      call(
        surface === "lookup" ? "POST" : "GET",
        readPath,
        surface === "lookup"
          ? { type: "core.note", ids: [item.id], include: ["edges"] }
          : undefined,
        reader,
      );
    const baseline = await read();
    expect(baseline.status, surface).toBe(200);
    const expected: unknown = await baseline.json();
    await server.setFault("hold:read-hydration");
    const pending = read();
    try {
      await server.waitForHold("hold:read-hydration");
      await makePrivate(beforeItem);
      expect(
        (
          await call("PUT", `${path}/extensions/fixture.data`, {
            data: { value: "private-extension" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call("POST", "/edges", {
            source_id: target.id,
            target_id: item.id,
            edge_type: "about",
            properties: { detail: "private-relation" },
          })
        ).status,
      ).toBe(201);
    } finally {
      await server.clearFault();
    }
    const response = await pending;
    expect(response.status, surface).toBe(200);
    expect(await response.json(), surface).toEqual(expected);
    expect((await call("GET", path, undefined, reader)).status).toBe(404);
    const witness = await call("GET", `${path}?include=backrefs`);
    expect(witness.status).toBe(200);
    const visible = await witness.text();
    expect(visible).toContain("private-extension");
    expect(visible).toContain("private-relation");
  }
});
