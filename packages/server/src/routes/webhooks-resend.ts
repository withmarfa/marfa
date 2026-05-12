/**
 * `POST /webhooks/resend` — Resend webhook receiver.
 *
 * Wave C PR1. Public route (no bearer auth) — Resend's signed webhook
 * is the gate. Mounted BEFORE `authMiddleware` in app.ts so the
 * unauthenticated path resolves cleanly.
 *
 * Signature verification uses Resend's svix-style HMAC. Three headers
 * (`svix-id`, `svix-timestamp`, `svix-signature`) plus the raw request
 * body. Body MUST be read via `c.req.text()` — JSON-parsed bodies
 * change byte-equality and break verification.
 *
 * Events we act on:
 * - `email.bounced` (with `bounce.type === "Permanent"`) → upsert
 *   suppression row (`reason: hard_bounce`).
 * - `email.complained` → upsert suppression row (`reason: complaint`).
 * - Soft bounces (`bounce.type === "Temporary"`) and other events
 *   (delivered / opened / clicked) → log + ack only. The transport
 *   doesn't track delivery state today; if we wire that later the
 *   write goes here.
 *
 * Tenant scope: Resend doesn't carry our tenant_id. Suppressions
 * mirror at the platform-level (empty-string sentinel) — same as the
 * pre-send check default. When the hosted product wires per-tenant
 * email tagging (Resend supports tags), we can re-route suppression
 * scope based on the tag.
 */
import { Hono } from "hono";
import { ErrorCode, MymeError } from "@mymehq/shared";
import type { Storage } from "../storage/interface.js";
import { log } from "../middleware/logger.js";

interface ResendWebhookEvent {
  type: string;
  created_at: string;
  data: {
    email_id?: string;
    to?: string[] | string;
    from?: string;
    subject?: string;
    bounce?: {
      type?: "Permanent" | "Temporary";
      subType?: string;
      message?: string;
    };
    tags?: { name: string; value: string }[];
  };
}

export function resendWebhookRoutes(
  storage: Storage,
  webhookSecret: string,
): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    // 1. Verify signature
    const svixId = c.req.header("svix-id");
    const svixTimestamp = c.req.header("svix-timestamp");
    const svixSignature = c.req.header("svix-signature");

    if (!svixId || !svixTimestamp || !svixSignature) {
      log("warn", "Resend webhook rejected: missing svix headers");
      throw new MymeError(
        ErrorCode.WEBHOOK_SIGNATURE_MISSING,
        "Resend webhook request is missing one or more svix signature headers",
      );
    }

    if (!webhookSecret) {
      // Misconfiguration — return 503 so Resend retries once we configure.
      log(
        "error",
        "Resend webhook called but RESEND_WEBHOOK_SECRET_MYME unset",
      );
      throw new MymeError(
        ErrorCode.WEBHOOK_SECRET_NOT_CONFIGURED,
        "Resend webhook secret is not configured on this instance",
      );
    }

    const rawBody = await c.req.text();

    try {
      // Dynamic import — keeps svix an optional dep at the bundle layer.
      const { Webhook } = (await import("svix")) as {
        Webhook: new (secret: string) => {
          verify(payload: string, headers: Record<string, string>): unknown;
        };
      };
      const wh = new Webhook(webhookSecret);
      wh.verify(rawBody, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      });
    } catch (err) {
      log("warn", "Resend webhook signature verification failed", {
        error: err instanceof Error ? err.message : String(err),
        svix_id: svixId,
      });
      throw new MymeError(
        ErrorCode.WEBHOOK_SIGNATURE_INVALID,
        "Resend webhook signature failed verification",
      );
    }

    // 2. Parse event
    let event: ResendWebhookEvent;
    try {
      event = JSON.parse(rawBody) as ResendWebhookEvent;
    } catch {
      throw new MymeError(
        ErrorCode.WEBHOOK_PAYLOAD_INVALID,
        "Resend webhook body is not valid JSON",
      );
    }

    // 3. Process — upserts only on bounce-permanent / complaint. Other
    //    event types are acknowledged but not acted on yet.
    const recipient = normaliseRecipient(event.data.to);
    const eventType = event.type;

    if (!storage.emailSuppressions) {
      // Storage misconfigured — accept (200) so Resend doesn't retry,
      // log loud so the operator notices.
      log("error", "Resend webhook: storage.emailSuppressions unwired");
      return c.json({ ok: true, action: "noop_storage_unwired" });
    }

    if (eventType === "email.bounced") {
      const bounceType = event.data.bounce?.type;
      if (bounceType === "Permanent" && recipient) {
        await storage.emailSuppressions.upsert({
          tenantId: "",
          email: recipient,
          reason: "hard_bounce",
          sourceEmailId: event.data.email_id ?? null,
        });
        await storage.audit.log({
          action: "email.suppressed",
          resource_type: "email_suppression",
          resource_id: recipient,
          tenant_id: null,
          details: {
            reason: "hard_bounce",
            source_email_id: event.data.email_id ?? null,
            bounce_subtype: event.data.bounce?.subType ?? null,
          },
        });
        log("info", "Suppression added (hard bounce)", {
          email: recipient,
          source_email_id: event.data.email_id,
        });
      } else {
        log("info", "Resend webhook: soft bounce ignored", {
          email: recipient,
          subtype: event.data.bounce?.subType,
        });
      }
      return c.json({ ok: true });
    }

    if (eventType === "email.complained" && recipient) {
      await storage.emailSuppressions.upsert({
        tenantId: "",
        email: recipient,
        reason: "complaint",
        sourceEmailId: event.data.email_id ?? null,
      });
      await storage.audit.log({
        action: "email.suppressed",
        resource_type: "email_suppression",
        resource_id: recipient,
        tenant_id: null,
        details: {
          reason: "complaint",
          source_email_id: event.data.email_id ?? null,
        },
      });
      log("info", "Suppression added (complaint)", {
        email: recipient,
        source_email_id: event.data.email_id,
      });
      return c.json({ ok: true });
    }

    // delivered / opened / clicked / sent / delivery_delayed / suppressed —
    // ack only. Not logged at info to keep volume down; raise to a
    // structured event-log if/when we wire delivery-state tracking.
    void eventType;
    return c.json({ ok: true, action: "ack_only" });
  });

  return app;
}

/** Resend's `data.to` may be string or string[]. Normalise to a single
 *  lowercase address. Returns null when absent. */
function normaliseRecipient(to: string | string[] | undefined): string | null {
  if (!to) return null;
  const value = Array.isArray(to) ? to[0] : to;
  return value ? value.toLowerCase() : null;
}
