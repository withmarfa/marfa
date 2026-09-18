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
    key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webhooks: WebhookResponse[] };
    expect(body.webhooks.length).toBeGreaterThan(0);
    for (const w of body.webhooks) {
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
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WebhookResponse;
    expect(body.id).toBe(created.id);
    expect(body.secret.startsWith("****")).toBe(true);
  });

  it("returns 404 for a missing webhook", async () => {
    const res = await request(ctx.app, "GET", "/webhooks/does-not-exist-xyz", {
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
      body: { url: "not a url at all" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects unknown event type on update with 400", async () => {
    const created = await createWebhook();
    const res = await request(ctx.app, "PATCH", `/webhooks/${created.id}`, {
      key: ctx.spaceKey,
      body: { events: ["item.created", "item.bogus"] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("returns 404 when patching a missing webhook", async () => {
    const res = await request(ctx.app, "PATCH", "/webhooks/missing-id", {
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Confirm it is actually gone.
    const getRes = await request(ctx.app, "GET", `/webhooks/${created.id}`, {
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deliveries: unknown[] };
    expect(Array.isArray(body.deliveries)).toBe(true);
    expect(body.deliveries.length).toBe(0);
  });

  it("respects the limit query parameter", async () => {
    const created = await createWebhook({
      url: "https://example.com/deliveries-limit",
    });

    // Seed three delivery attempts directly through the store.
    for (let i = 0; i < 3; i++) {
      await ctx.storage.outboundWebhookDeliveries.log({
        webhookId: created.id,
        event: "item.created",
        statusCode: 200,
        attempt: 1,
        succeeded: true,
      });
    }

    const res = await request(
      ctx.app,
      "GET",
      `/webhooks/${created.id}/deliveries?limit=2`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deliveries: unknown[] };
    expect(body.deliveries.length).toBe(2);
  });

  it("returns 404 when the webhook does not exist", async () => {
    const res = await request(ctx.app, "GET", "/webhooks/ghost-id/deliveries", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(404);
  });
});
