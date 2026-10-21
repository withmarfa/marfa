import { afterAll, beforeAll, expect, it } from "vitest";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";
import { waitFor } from "../../utils/wait.js";
let server: FreshServer;
let receiver: Receiver;
let fail = true;
let ids: string[];
let second: string;
const privateBody = "owner-history-private-body";
function owner(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", server.ownerCookie);
  headers.set("origin", server.apiUrl);
  return fetch(server.apiUrl + path, { ...init, headers });
}
function credential(path: string, key: string, method = "GET", body?: unknown) {
  return fetch(server.apiUrl + path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeAll(async () => {
  server = await bootFreshServer("webhooks-owner");
  receiver = await startReceiver({ status: () => (fail ? 400 : 200) });
  const key = await owner("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "Second maker",
      source: "second-maker",
      permissions: ["webhooks.manage"],
      type_permissions: { "*": "read" },
      edge_permissions: {},
      extension_permissions: {},
    }),
  });
  expect(key.status).toBe(201);
  second = ((await key.json()) as { key: string }).key;
  const app = await approvedApp(server, ["core.note:read", "webhooks.manage"]);
  ids = [];
  for (const [i, key] of [server.workingKey, second, app.token].entries()) {
    const response = await credential("/webhooks", key, "POST", {
      url: receiver.hookUrl(String(i)),
      events: ["item.created"],
      secret: "private-signing-secret-0123456789xx",
    });
    expect(response.status).toBe(201);
    ids.push(((await response.json()) as { id: string }).id);
  }
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await receiver?.close();
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);
it("reads every maker through owner and local authority while ordinary keys stay isolated", async () => {
  const before = await (await owner("/keys")).json();
  for (const read of [
    owner,
    async (path: string, init?: RequestInit) => {
      const result = await controlRequest(server.controlSocket, path, {
        method: init?.method,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
      });
    },
  ]) {
    const listed = await read("/webhooks");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      data: {
        id: string;
        maker: { kind: string; id: string; name: string | null };
      }[];
      next_cursor: null;
    };
    expect(body.next_cursor).toBeNull();
    expect(body.data.map((w) => w.id).sort()).toEqual([...ids].sort());
    expect(body.data.map((w) => w.maker.kind).sort()).toEqual([
      "app",
      "key",
      "key",
    ]);
    expect(JSON.stringify(body)).not.toContain("private-signing-secret");
    for (const id of ids) {
      expect((await read(`/webhooks/${id}`)).status).toBe(200);
      expect((await read(`/webhooks/${id}/deliveries`)).status).toBe(200);
      expect((await read(`/webhooks/${id}`, { method: "DELETE" })).status).toBe(
        401,
      );
    }
  }
  expect(
    (
      (await (await credential("/webhooks", second)).json()) as {
        data: { id: string }[];
      }
    ).data.map((w) => w.id),
  ).toEqual([ids[1]]);
  expect((await credential(`/webhooks/${ids[0]!}`, second)).status).toBe(404);
  expect(await (await owner("/keys")).json()).toEqual(before);
});
it("retries a failed delivery through owner authority without exposing its frame", async () => {
  expect(
    (
      await credential("/items", server.workingKey, "POST", {
        type: "core.note",
        properties: { body: privateBody },
      })
    ).status,
  ).toBe(201);
  const path = `/webhooks/${ids[0]!}/deliveries`;
  const failed = await waitFor("failed delivery", async () => {
    const response = await owner(path);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(privateBody);
    const page = JSON.parse(body) as { data: { id: string; status: string }[] };
    return page.data.find((d) => d.status === "dead_letter");
  });
  expect(receiver.received.some((r) => r.body.includes(privateBody))).toBe(
    true,
  );
  const localFailed = await waitFor("second failed delivery", async () => {
    const page = (await (
      await owner(`/webhooks/${ids[1]!}/deliveries`)
    ).json()) as { data: { id: string; status: string }[] };
    return page.data.find((d) => d.status === "dead_letter");
  });
  fail = false;
  expect(
    (
      await controlRequest(
        server.controlSocket,
        `/webhooks/${ids[1]!}/deliveries/${localFailed.id}/redeliver`,
        { method: "POST" },
      )
    ).status,
  ).toBe(202);
  const response = await owner(`${path}/${failed.id}/redeliver`, {
    method: "POST",
  });
  expect(response.status).toBe(202);
  expect(await response.text()).not.toContain(privateBody);
  await waitFor(
    "retried delivery",
    async () => {
      const page = (await (await owner(path)).json()) as {
        data: { id: string; status: string }[];
      };
      return page.data.find(
        (d) => d.id === failed.id && d.status === "success",
      );
    },
    60_000,
  );
  expect(
    receiver.received.filter(
      (r) => r.path === "/hook/0" && r.body.includes(privateBody),
    ),
  ).toHaveLength(2);
});

it("reads a full last delivery page through owner authority", async () => {
  for (let i = 0; i < 11; i++)
    expect(
      (
        await credential("/items", server.workingKey, "POST", {
          type: "core.note",
          properties: { body: `page ${String(i)}` },
        })
      ).status,
    ).toBe(201);
  await waitFor("all delivery rows", async () => {
    const page = (await (
      await owner(`/webhooks/${ids[0]!}/deliveries?limit=20`)
    ).json()) as { data: unknown[] };
    return page.data.length === 12 ? true : undefined;
  });
  const first = (await (
    await owner(`/webhooks/${ids[0]!}/deliveries?limit=6`)
  ).json()) as { data: { id: string }[]; next_cursor: string };
  expect(first.data).toHaveLength(6);
  expect(first.next_cursor).toEqual(expect.any(String));
  const last = (await (
    await owner(
      `/webhooks/${ids[0]!}/deliveries?limit=6&cursor=${encodeURIComponent(first.next_cursor)}`,
    )
  ).json()) as { data: { id: string }[]; next_cursor: null };
  expect(last.data).toHaveLength(6);
  expect(last.next_cursor).toBeNull();
  expect(new Set([...first.data, ...last.data].map((d) => d.id)).size).toBe(12);
});
