import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackWebhook,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let receiver: Receiver;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "undeclared-body-keys",
  ));
  receiver = await startReceiver();
});

afterAll(async () => {
  await receiver.close();
  await cleanup(ctx);
});

async function makeNote(tags: string[] = []): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, tags, properties: { body: "closed" } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

/** One operation, set up with a body it takes and a way to read what it writes. */
interface Setup {
  method: string;
  path: string;
  body: Record<string, unknown>;
  seen: () => Promise<unknown>;
}

async function itemSetup(
  method: string,
  suffix: string,
  body: Record<string, unknown>,
): Promise<Setup> {
  const id = await makeNote(["kept"]);
  return {
    method,
    path: `/items/${id}${suffix}`,
    body,
    seen: async () => {
      const item = await client.getItem(id);
      const metadata = await client.rawRequest<unknown>(
        `/items/${id}/metadata`,
      );
      return [item.data, metadata.data];
    },
  };
}

const OPERATIONS: Record<string, () => Promise<Setup>> = {
  "POST /items/{id}/transition": () =>
    itemSetup("POST", "/transition", { state: "archived" }),
  "PUT /items/{id}/metadata": () =>
    itemSetup("PUT", "/metadata", { tags: ["replaced"] }),
  "POST /items/{id}/tags": () =>
    itemSetup("POST", "/tags", { tags: ["added"] }),
  "POST /items/bulk-get": async () => {
    const id = await makeNote();
    return {
      method: "POST",
      path: "/items/bulk-get",
      body: { ids: [id] },
      seen: async () => undefined,
    };
  },
  "POST /webhooks": async () => ({
    method: "POST",
    path: "/webhooks",
    body: { url: receiver.url, events: ["item.created"] },
    seen: async () => (await client.listWebhooks()).data,
  }),
  "PATCH /webhooks/{id}": async () => {
    const created = await client.createWebhook({
      url: receiver.url,
      events: ["item.created"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);
    return {
      method: "PATCH",
      path: `/webhooks/${created.data.id}`,
      body: { active: false },
      seen: async () => (await client.getWebhook(created.data.id)).data,
    };
  },
};

describe.each(Object.keys(OPERATIONS))("%s", (operation) => {
  it("takes its body without the key, so the refusals below are of a producible write", async () => {
    const setup = await OPERATIONS[operation]!();
    const before = await setup.seen();
    const r = await client.rawRequest<unknown>(setup.path, {
      method: setup.method,
      body: setup.body,
    });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    if (operation !== "POST /items/bulk-get") {
      expect(await setup.seen()).not.toEqual(before);
    }
  });

  it.each([[["bogus"]], [["_trace"]], [["bogus", "_trace"]]])(
    "refuses %j as undeclared, naming each key, and writes nothing",
    async (keys) => {
      const setup = await OPERATIONS[operation]!();
      const before = await setup.seen();
      const refused = await client.rawRequest<unknown>(setup.path, {
        method: setup.method,
        body: {
          ...setup.body,
          ...Object.fromEntries(keys.map((key) => [key, 1])),
        },
      });
      expect(
        refused.status,
        "a body naming a key the operation does not declare was answered as success",
      ).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.details?.unknown_body_fields).toEqual(
        [...keys].sort(),
      );
      expect(await setup.seen()).toEqual(before);
    },
  );
});

describe("the keys a refusal names", () => {
  it("come in ascending order, whatever order the body sent them in", async () => {
    const setup = await OPERATIONS["POST /items/{id}/tags"]!();
    const refused = await client.rawRequest<unknown>(setup.path, {
      method: setup.method,
      body: { zeta: 1, ...setup.body, alpha: 2, mid: 3 },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.details?.unknown_body_fields).toEqual([
      "alpha",
      "mid",
      "zeta",
    ]);
  });
});

describe("a body that is open by design", () => {
  it("PUT /items/{id}/extensions/{namespace} stores the extension's own document, whatever its keys", async () => {
    const id = await makeNote();
    const document = { bogus: 1, _trace: 2, nested: { anything: true } };
    const written = await client.rawRequest<unknown>(
      `/items/${id}/extensions/closed-body`,
      { method: "PUT", body: document },
    );
    expect(written.status, JSON.stringify(written.error)).toBe(200);
    const read = await client.rawRequest<{
      metadata: { extensions: Record<string, unknown> };
    }>(`/items/${id}/metadata`);
    expect(read.data.metadata.extensions["closed-body"]).toEqual(document);
  });

  it("POST /auth/oauth2/register ignores client metadata it does not understand", async () => {
    const registered = await fetch(`${apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "open-body",
        application_type: "native",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
        response_types: [],
        token_endpoint_auth_method: "none",
        bogus: 1,
        _trace: 2,
      }),
    });
    expect(registered.status).toBe(201);
  });
});
