import { Hono } from "hono";
import { MymeError, ErrorCode } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

/** Redact secret to last 4 characters for list/get responses. */
function redactSecret(secret: string): string {
  if (secret.length <= 4) return secret;
  return "****" + secret.slice(-4);
}

const VALID_EVENTS = new Set([
  "item.created",
  "item.updated",
  "item.deleted",
  "item.restored",
  "item.transitioned",
  "*",
]);

export function webhookRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // POST /webhooks — create a new webhook
  router.post("/", async (c) => {
    const key = requireAdmin(c);
    const body = await c.req.json();

    if (!body.url || typeof body.url !== "string") {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "url is required");
    }

    try {
      new URL(body.url);
    } catch {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "url must be a valid URL",
      );
    }

    if (!Array.isArray(body.events) || body.events.length === 0) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "events must be a non-empty array of event types",
      );
    }

    for (const event of body.events) {
      if (typeof event !== "string" || !VALID_EVENTS.has(event)) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          `Invalid event type "${String(event)}". Valid types: ${[...VALID_EVENTS].join(", ")}`,
        );
      }
    }

    if (
      body.type_filter !== undefined &&
      body.type_filter !== null &&
      typeof body.type_filter !== "string"
    ) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "type_filter must be a string",
      );
    }

    const webhook = await storage.webhooks.create(
      {
        url: body.url,
        events: body.events,
        type_filter: body.type_filter ?? undefined,
        secret: body.secret ?? undefined,
      },
      key.tenant_id,
    );

    // Return full secret on creation so the caller can store it
    return c.json(webhook, 201);
  });

  // GET /webhooks — list all webhooks
  router.get("/", async (c) => {
    const key = requireAdmin(c);
    const webhooks = await storage.webhooks.list(key.tenant_id);
    return c.json({
      webhooks: webhooks.map((w) => ({ ...w, secret: redactSecret(w.secret) })),
    });
  });

  // GET /webhooks/:id — get a single webhook
  router.get("/:id", async (c) => {
    const key = requireAdmin(c);
    const id = c.req.param("id");
    const webhook = await storage.webhooks.get(id, key.tenant_id);
    if (!webhook) {
      throw new MymeError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }
    return c.json({ ...webhook, secret: redactSecret(webhook.secret) });
  });

  // PATCH /webhooks/:id — partial update
  router.patch("/:id", async (c) => {
    const key = requireAdmin(c);
    const id = c.req.param("id");
    const body = await c.req.json();

    const existing = await storage.webhooks.get(id, key.tenant_id);
    if (!existing) {
      throw new MymeError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }

    if (body.url !== undefined) {
      if (typeof body.url !== "string") {
        throw new MymeError(ErrorCode.VALIDATION_ERROR, "url must be a string");
      }
      try {
        new URL(body.url);
      } catch {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          "url must be a valid URL",
        );
      }
    }

    if (body.events !== undefined) {
      if (!Array.isArray(body.events) || body.events.length === 0) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          "events must be a non-empty array",
        );
      }
      for (const event of body.events) {
        if (typeof event !== "string" || !VALID_EVENTS.has(event)) {
          throw new MymeError(
            ErrorCode.VALIDATION_ERROR,
            `Invalid event type: ${String(event)}`,
          );
        }
      }
    }

    if (body.active !== undefined && typeof body.active !== "boolean") {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "active must be a boolean",
      );
    }

    const updated = await storage.webhooks.update(id, {
      url: body.url,
      events: body.events,
      type_filter: body.type_filter,
      active: body.active,
    });

    return c.json({ ...updated, secret: redactSecret(updated.secret) });
  });

  // DELETE /webhooks/:id
  router.delete("/:id", async (c) => {
    requireAdmin(c);
    const id = c.req.param("id");

    const existing = await storage.webhooks.get(id);
    if (!existing) {
      throw new MymeError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }

    await storage.webhooks.delete(id);
    return c.json({ ok: true });
  });

  return router;
}
