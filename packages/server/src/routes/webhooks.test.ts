import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request, waitForAudit } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

// Audit writes in the route handlers are fire-and-forget
// (`void storage.audit.log(...)`), so use the shared `waitForAudit`
// helper rather than reading once.
async function waitForAuditEntry(filter: {
  action: string;
  resource_id: string;
}): Promise<{
  data: { action: string; resource_id: string | null; resource_type: string }[];
}> {
  return waitForAudit(
    () => ctx.storage.audit.list(filter),
    (r) => r.data.length > 0,
  );
}

interface WebhookResponse {
  id: string;
  url: string;
  events: string[];
  type_filter: string | null;
  secret: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

async function createWebhook(overrides?: {
  url?: string;
  events?: string[];
}): Promise<WebhookResponse> {
  const res = await request(ctx.app, "POST", "/webhooks", {
    key: ctx.workingKey,
    body: {
      url: overrides?.url ?? "https://example.com/hook",
      events: overrides?.events ?? ["item.created"],
    },
  });
  return (await res.json()) as WebhookResponse;
}

describe("POST /webhooks", () => {
  it("creates a webhook on the happy path", async () => {
    const res = await request(ctx.app, "POST", "/webhooks", {
      key: ctx.workingKey,
      body: {
        url: "https://example.com/happy",
        events: ["item.created", "item.updated"],
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as WebhookResponse;
    expect(body.url).toBe("https://example.com/happy");
    expect(body.events).toEqual(["item.created", "item.updated"]);
    expect(body.active).toBe(true);
    // Full secret returned on create so caller can persist it.
    expect(body.secret.length).toBeGreaterThan(8);
    expect(body.secret.startsWith("****")).toBe(false);
  });

  it("rejects a malformed URL with 400", async () => {
    const res = await request(ctx.app, "POST", "/webhooks", {
      key: ctx.workingKey,
      body: {
        url: "not-a-url",
        events: ["item.created"],
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects an unknown event type with 400", async () => {
    const res = await request(ctx.app, "POST", "/webhooks", {
      key: ctx.workingKey,
      body: {
        url: "https://example.com/hook",
        events: ["item.created", "item.nonsense"],
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("requires auth — 401 without a credential", async () => {
    const res = await request(ctx.app, "POST", "/webhooks", {
      body: {
        url: "https://example.com/no-auth",
        events: ["item.created"],
      },
    });
    expect(res.status).toBe(401);
  });

  it("writes an audit-log entry for webhook.create", async () => {
    const created = await createWebhook({
      url: "https://example.com/audited",
    });
    // Audit is logged via `void storage.audit.log(...)` inside the handler.
    // Query directly through the storage to verify the side effect landed.
    const auditResult = await waitForAuditEntry({
      action: "webhook.create",
      resource_id: created.id,
    });
    expect(auditResult.data.length).toBeGreaterThanOrEqual(1);
    expect(auditResult.data[0]?.action).toBe("webhook.create");
    expect(auditResult.data[0]?.resource_id).toBe(created.id);
    expect(auditResult.data[0]?.resource_type).toBe("webhook");
  });
});

describe("GET /webhooks", () => {
  it("lists webhooks with secrets redacted", async () => {
    await createWebhook({ url: "https://example.com/list-test" });

    const res = await request(ctx.app, "GET", "/webhooks", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: WebhookResponse[] };
    expect(body.data.length).toBeGreaterThan(0);
    for (const w of body.data) {
      // redactSecret() prefixes with "****" when secret length > 4.
      expect(w.secret.startsWith("****")).toBe(true);
      expect(w.secret.length).toBe(8);
    }
  });

  it("requires auth — 401 without a credential", async () => {
    const res = await request(ctx.app, "GET", "/webhooks");
    expect(res.status).toBe(401);
  });
});

describe("GET /webhooks/:id", () => {
  it("returns a single webhook with secret redacted", async () => {
    const created = await createWebhook({
      url: "https://example.com/single",
    });

    const res = await request(ctx.app, "GET", `/webhooks/${created.id}`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WebhookResponse;
    expect(body.id).toBe(created.id);
    expect(body.secret.startsWith("****")).toBe(true);
  });

  it("returns 404 for a missing webhook", async () => {
    const res = await request(ctx.app, "GET", "/webhooks/does-not-exist-xyz", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("webhook_not_found");
  });
});

describe("PATCH /webhooks/:id", () => {
  it("partially updates url and events", async () => {
    const created = await createWebhook({
      url: "https://example.com/patch-me",
      events: ["item.created"],
    });

    const res = await request(ctx.app, "PATCH", `/webhooks/${created.id}`, {
      key: ctx.workingKey,
      body: {
        url: "https://example.com/updated",
        events: ["item.updated", "item.deleted"],
        active: false,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WebhookResponse;
    expect(body.url).toBe("https://example.com/updated");
    expect(body.events).toEqual(["item.updated", "item.deleted"]);
    expect(body.active).toBe(false);
    expect(body.secret.startsWith("****")).toBe(true);
  });

  it("rejects malformed URL on update with 400", async () => {
    const created = await createWebhook();
    const res = await request(ctx.app, "PATCH", `/webhooks/${created.id}`, {
      key: ctx.workingKey,
      body: { url: "not a url at all" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects unknown event type on update with 400", async () => {
    const created = await createWebhook();
    const res = await request(ctx.app, "PATCH", `/webhooks/${created.id}`, {
      key: ctx.workingKey,
      body: { events: ["item.created", "item.bogus"] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("returns 404 when patching a missing webhook", async () => {
    const res = await request(ctx.app, "PATCH", "/webhooks/missing-id", {
      key: ctx.workingKey,
      body: { active: false },
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /webhooks/:id", () => {
  it("deletes a webhook and records an audit entry", async () => {
    const created = await createWebhook({
      url: "https://example.com/delete-me",
    });

    const res = await request(ctx.app, "DELETE", `/webhooks/${created.id}`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Confirm it is actually gone.
    const getRes = await request(ctx.app, "GET", `/webhooks/${created.id}`, {
      key: ctx.workingKey,
    });
    expect(getRes.status).toBe(404);

    // Audit side effect.
    const auditResult = await waitForAuditEntry({
      action: "webhook.delete",
      resource_id: created.id,
    });
    expect(auditResult.data.length).toBeGreaterThanOrEqual(1);
    expect(auditResult.data[0]?.action).toBe("webhook.delete");
  });

  it("returns 404 when deleting a missing webhook", async () => {
    const res = await request(ctx.app, "DELETE", "/webhooks/nope-nope", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /webhooks/:id/deliveries", () => {
  it("returns an empty delivery list for a fresh webhook", async () => {
    const created = await createWebhook({
      url: "https://example.com/deliveries-fresh",
    });

    const res = await request(
      ctx.app,
      "GET",
      `/webhooks/${created.id}/deliveries`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(0);
  });

  it("respects the limit query parameter", async () => {
    const created = await createWebhook({
      url: "https://example.com/deliveries-limit",
    });

    for (let i = 0; i < 3; i++) {
      const id = await ctx.storage.outboundWebhookDeliveries.schedule({
        webhookId: created.id,
        eventType: "item.created",
        payload: "{}",
        webhookUrl: created.url,
        nextAttemptAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await ctx.storage.outboundWebhookDeliveries.markSuccess(id, 200, 1);
    }

    const res = await request(
      ctx.app,
      "GET",
      `/webhooks/${created.id}/deliveries?limit=2`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string }[];
      next_cursor: string | null;
    };
    expect(body.data.length).toBe(2);
    // A page cut by the limit says so, and the cursor reaches the rest.
    expect(body.next_cursor).not.toBeNull();
    const rest = await request(
      ctx.app,
      "GET",
      `/webhooks/${created.id}/deliveries?limit=2&cursor=${body.next_cursor!}`,
      { key: ctx.workingKey },
    );
    const next = (await rest.json()) as {
      data: { id: string }[];
      next_cursor: string | null;
    };
    expect(next.data).toHaveLength(1);
    expect(next.next_cursor).toBeNull();
    expect(new Set([...body.data, ...next.data].map((d) => d.id)).size).toBe(3);
  });

  it("returns 404 when the webhook does not exist", async () => {
    const res = await request(ctx.app, "GET", "/webhooks/ghost-id/deliveries", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(404);
  });
});

describe("a wildcard in an events array", () => {
  it("is refused on the way in, on both doors that take an event list", async () => {
    const created = await createWebhook();
    for (const res of [
      await request(ctx.app, "POST", "/webhooks", {
        key: ctx.workingKey,
        body: { url: "https://example.com/hook", events: ["*"] },
      }),
      await request(ctx.app, "PATCH", `/webhooks/${created.id}`, {
        key: ctx.workingKey,
        body: { events: ["*"] },
      }),
    ]) {
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: { errors?: { path: string }[] } };
      };
      expect(body.error.code).toBe("validation_error");
      // The entry rather than the body: a caller editing a list of ten has
      // to be told which one went.
      expect(body.error.details?.errors?.[0]?.path).toBe("events.0");
    }
  });
});

describe("an event name the vocabulary no longer carries", () => {
  // `WebhookSchema.events` stays `z.array(z.string())` where the request side
  // is the enum, and this is the case that decides it. Retiring a name does
  // not rewrite the rows that subscribed to it, so a read side typed to
  // today's vocabulary would make such a row impossible to serve — and leave
  // its owner unable to see the subscription in order to replace it.
  //
  // Written through the store, because the door is what refuses the name.
  it("reads back as written when a row already holds one", async () => {
    const current = await request(ctx.app, "GET", "/keys/current", {
      key: ctx.workingKey,
    });
    const { id: credentialId } = (await current.json()) as { id: string };
    const stored = await ctx.storage.outboundWebhooks.create({
      url: "https://example.com/retired",
      events: ["item.trashed"],
      owner: { kind: "key", keyId: credentialId },
    });

    const res = await request(ctx.app, "GET", `/webhooks/${stored.id}`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WebhookResponse;
    expect(body.events).toEqual(["item.trashed"]);
  });
});
