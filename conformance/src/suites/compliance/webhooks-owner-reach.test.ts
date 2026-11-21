import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { BulkActionJob } from "../../client/types.js";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { HOUR_MS, movedClock } from "../../utils/moved-clock.js";

/**
 * A credential holding both `keys.manage` and `webhooks.manage` reaches every
 * maker's subscriptions to read and remove them, and changes only its own.
 */

let server: FreshServer;
/** An owner's key holding every permission and every map. */
let owner: string;
/** A key holding `webhooks.manage` alone. */
let maker: string;
let makerId: string;
let app: { token: string; clientId: string };
/** Each maker's subscription: the owner's, the plain key's and the app's. */
let own: string;
let keys: string;
let apps: string;

const EVERY_PERMISSION = [
  "schema.write",
  "keys.mint",
  "keys.manage",
  "items.purge",
  "webhooks.manage",
  "config.manage",
  "audit.read",
  "grants.manage",
  "instance.read",
  "instance.maintain",
  "connectors.manage",
  "blobs.manage",
  "backups.manage",
  "sign_ins.manage",
];

interface Hook {
  id: string;
  url: string;
  active: boolean;
  type_filter: string | null;
  maker: { kind: string; id: string; name: string | null };
}

function call(path: string, key: string, method = "GET", body?: unknown) {
  return fetch(server.apiUrl + path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function local(path: string, method = "GET", body?: unknown) {
  return controlRequest(server.controlSocket, path, {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

async function mint(body: Record<string, unknown>) {
  const minted = await local("/keys", "POST", body);
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return minted.body as { id: string; key: string };
}

async function register(key: string, label: string, typeFilter?: string) {
  const response = await call("/webhooks", key, "POST", {
    url: `http://receiver.invalid/${label}`,
    events: ["item.created"],
    ...(typeFilter === undefined ? {} : { type_filter: typeFilter }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function listed(key: string): Promise<Hook[]> {
  const response = await call("/webhooks", key);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: Hook[];
    next_cursor: unknown;
  };
  expect(body.next_cursor).toBeNull();
  return body.data;
}

beforeAll(async () => {
  server = await bootFreshServer("webhooks-owner-reach");
  owner = (
    await mint({
      label: "Owner",
      source: "owner-reach-owner",
      permissions: EVERY_PERMISSION,
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      extension_permissions: { "*": "write" },
      metadata_permissions: { "*": "write" },
      profile_permissions: { "*": "write" },
    })
  ).key;
  const plain = await mint({
    label: "Plain maker",
    source: "owner-reach-maker",
    permissions: ["webhooks.manage"],
    type_permissions: { "*": "read" },
  });
  maker = plain.key;
  makerId = plain.id;
  app = await approvedApp(server, ["core.note:read", "webhooks.manage"]);
  own = await register(owner, "own");
  keys = await register(maker, "key");
  apps = await register(app.token, "app");
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("a credential holding keys.manage and webhooks.manage", () => {
  it("lists and gets another key's and an app's subscriptions with their maker", async () => {
    const all = await listed(owner);
    expect(all.map((hook) => hook.id).sort()).toEqual([own, keys, apps].sort());
    const byId = new Map(all.map((hook) => [hook.id, hook]));
    expect(byId.get(keys)?.maker).toEqual({
      kind: "key",
      id: makerId,
      name: "Plain maker",
    });
    expect(byId.get(apps)?.maker).toMatchObject({
      kind: "app",
      id: app.clientId,
    });
    expect(JSON.stringify(all)).not.toMatch(/"secret":"[0-9a-f]{64}"/);
    for (const id of [keys, apps]) {
      const got = await call(`/webhooks/${id}`, owner);
      expect(got.status).toBe(200);
      expect(((await got.json()) as Hook).maker).toEqual(byId.get(id)?.maker);
      expect((await call(`/webhooks/${id}/deliveries`, owner)).status).toBe(
        200,
      );
    }
  });

  it("is refused an update and a redelivery of another maker's subscription with 403 forbidden, leaving it as it was", async () => {
    // The witness: the same body changes the owner's own subscription.
    expect(
      (await call(`/webhooks/${own}`, owner, "PATCH", { active: false }))
        .status,
    ).toBe(200);
    for (const id of [keys, apps]) {
      const refused = await call(`/webhooks/${id}`, owner, "PATCH", {
        active: false,
      });
      expect(refused.status, id).toBe(403);
      expect(refused.headers.get("x-error-code"), id).toBe("forbidden");
      const kept = (await (
        await call(`/webhooks/${id}`, owner)
      ).json()) as Hook;
      expect(kept.active, id).toBe(true);
      const redelivery = await call(
        `/webhooks/${id}/deliveries/whd_unknown/redeliver`,
        owner,
        "POST",
      );
      expect(redelivery.status, id).toBe(403);
    }
    // The witness: the owner's own subscription reaches the delivery lookup.
    expect(
      (
        await call(
          `/webhooks/${own}/deliveries/whd_unknown/redeliver`,
          owner,
          "POST",
        )
      ).status,
    ).toBe(404);
  });

  it("deletes another key's subscription, and the key's own list no longer holds it", async () => {
    const doomed = await register(maker, "doomed");
    expect((await listed(maker)).map((hook) => hook.id)).toContain(doomed);
    expect((await call(`/webhooks/${doomed}`, owner, "DELETE")).status).toBe(
      200,
    );
    expect((await call(`/webhooks/${doomed}`, maker)).status).toBe(404);
    expect((await call(`/webhooks/${doomed}`, owner)).status).toBe(404);
    expect((await listed(maker)).map((hook) => hook.id)).not.toContain(doomed);
  });

  it("deletes an app's subscription", async () => {
    const doomed = await register(app.token, "app-doomed");
    expect((await call(`/webhooks/${doomed}`, app.token)).status).toBe(200);
    expect((await call(`/webhooks/${doomed}`, owner, "DELETE")).status).toBe(
      200,
    );
    expect((await call(`/webhooks/${doomed}`, app.token)).status).toBe(404);
  });

  it("reaches every maker from an app that holds keys.manage and webhooks.manage", async () => {
    const reaching = await approvedApp(server, [
      "core.note:read",
      "webhooks.manage",
      "keys.manage",
    ]);
    expect((await listed(reaching.token)).map((hook) => hook.id)).toEqual(
      expect.arrayContaining([own, keys, apps]),
    );
    const doomed = await register(maker, "app-reached");
    expect(
      (await call(`/webhooks/${doomed}`, reaching.token, "DELETE")).status,
    ).toBe(200);
    expect((await call(`/webhooks/${doomed}`, maker)).status).toBe(404);
  });
});

describe("a credential without keys.manage", () => {
  it("keeps a webhooks.manage key to its own subscriptions, answering 404 on another's", async () => {
    // The witness: the key reaches its own on every door.
    const held = (await listed(maker)).map((hook) => hook.id);
    expect(held).toContain(keys);
    expect(held).not.toContain(own);
    expect(held).not.toContain(apps);
    expect((await call(`/webhooks/${keys}`, maker)).status).toBe(200);
    expect((await call(`/webhooks/${keys}/deliveries`, maker)).status).toBe(
      200,
    );
    for (const id of [own, apps]) {
      const doors: [string, string, unknown?][] = [
        ["GET", `/webhooks/${id}`],
        ["PATCH", `/webhooks/${id}`, { active: false }],
        ["DELETE", `/webhooks/${id}`],
        ["GET", `/webhooks/${id}/deliveries`],
        ["POST", `/webhooks/${id}/deliveries/whd_unknown/redeliver`],
      ];
      for (const [method, path, body] of doors) {
        const response = await call(path, maker, method, body);
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(response.headers.get("x-error-code"), `${method} ${path}`).toBe(
          "webhook_not_found",
        );
      }
    }
    expect((await listed(owner)).map((hook) => hook.id)).toEqual(
      expect.arrayContaining([own, keys, apps]),
    );
  });

  it("refuses a keys.manage key that does not hold webhooks.manage with 403 forbidden", async () => {
    const manager = await mint({
      label: "Key manager",
      source: `owner-reach-manager-${randomUUID()}`,
      permissions: ["keys.manage"],
    });
    const refused = await call("/webhooks", manager.key);
    expect(refused.status).toBe(403);
    expect(
      (await call(`/webhooks/${keys}`, manager.key, "DELETE")).status,
    ).toBe(403);
    expect((await call(`/webhooks/${keys}`, maker)).status).toBe(200);
  });
});

describe("local authority", () => {
  it("deletes any maker's subscription through local authority, and still refuses a create and an update", async () => {
    const doomed = await register(maker, "local-doomed");
    expect((await local(`/webhooks/${doomed}`)).status).toBe(200);
    expect(
      (await local(`/webhooks/${keys}`, "PATCH", { active: false })).status,
    ).toBe(401);
    expect(
      (
        await local("/webhooks", "POST", {
          url: "http://receiver.invalid/local",
          events: ["item.created"],
        })
      ).status,
    ).toBe(401);
    expect((await local(`/webhooks/${doomed}`, "DELETE")).status).toBe(200);
    expect((await local(`/webhooks/${doomed}`)).status).toBe(404);
    expect((await call(`/webhooks/${doomed}`, maker)).status).toBe(404);
    expect(
      ((await (await call(`/webhooks/${keys}`, maker)).json()) as Hook).active,
    ).toBe(true);
  });
});

describe("a maker that no longer stands", () => {
  it("deletes a revoked key's subscription, after which a type move it blocked goes through", async () => {
    const ownerClient = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: owner,
    });
    const ns = `ownerreach${randomUUID()
      .slice(0, 8)
      .replace(/[^a-z]/g, "x")}`;
    const from = `${ns}.receipt`;
    const to = `${ns}.invoice`;
    for (const id of [from, to]) {
      const registered = await ownerClient.registerType({
        id,
        fields: { name: { type: "string" } },
      } as never);
      expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    }
    const created = await ownerClient.createItem({
      type: from,
      properties: { name: "kept" },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const revoked = await mint({
      label: "Revoked maker",
      source: `owner-reach-revoked-${randomUUID()}`,
      permissions: ["webhooks.manage"],
      type_permissions: { "*": "read" },
    });
    const hook = await register(revoked.key, "revoked", from);
    expect((await local(`/keys/${revoked.id}`, "DELETE")).status).toBe(200);
    expect((await call("/keys/current", revoked.key)).status).toBe(401);

    const held = (await listed(owner)).find((h) => h.id === hook);
    expect(held?.maker).toMatchObject({ kind: "key", id: revoked.id });
    const blocked = await ownerClient.moveType(from, { to, dry_run: true });
    expect(blocked.status).toBe(409);
    expect(blocked.error?.error.code).toBe("type_move_blocked");
    expect(
      (
        blocked.error as unknown as {
          error: { details: { settings: Record<string, unknown>[] } };
        }
      ).error.details.settings,
    ).toEqual([
      expect.objectContaining({
        kind: "webhook",
        id: hook,
        field: "type_filter",
        reason: "not_permitted",
      }),
    ]);

    expect((await call(`/webhooks/${hook}`, owner, "DELETE")).status).toBe(200);
    expect((await call(`/webhooks/${hook}`, owner)).status).toBe(404);
    const moved = await ownerClient.moveType(from, { to });
    expect(moved.status, JSON.stringify(moved.error)).toBe(202);
    const job = await ownerClient.pollBulkActionToTerminal(
      (moved.data as BulkActionJob).id,
    );
    expect(job.status, job.error).toBe("completed");
    const item = await ownerClient.getItem(created.data.item.id);
    expect(item.data.item.type).toBe(to);
  });

  it("deletes an expired key's subscription", async () => {
    const clock = movedClock(server);
    const expiring = await call("/keys", owner, "POST", {
      label: "Expiring maker",
      source: `owner-reach-expiring-${randomUUID()}`,
      permissions: ["webhooks.manage"],
      type_permissions: { "*": "read" },
      expires_at: new Date(clock.now() + HOUR_MS).toISOString(),
    });
    expect(expiring.status).toBe(201);
    const key = ((await expiring.json()) as { key: string }).key;
    const hook = await register(key, "expiring");
    await clock.advance(2 * HOUR_MS);
    expect((await call("/keys/current", key)).status).toBe(401);
    expect((await call(`/webhooks/${hook}`, owner)).status).toBe(200);
    expect((await call(`/webhooks/${hook}`, owner, "DELETE")).status).toBe(200);
    expect((await call(`/webhooks/${hook}`, owner)).status).toBe(404);
    expect((await local(`/webhooks/${hook}`)).status).toBe(404);
  });
});
