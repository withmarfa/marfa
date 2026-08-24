/**
 * marfa/inbox webhook handler.
 *
 * The substrate verifies the HMAC against the per-connection
 * subscription secret using the `cloudflare-email` adapter, then
 * enqueues the verified delivery onto the per-Integration
 * `webhook-receipt` queue. This handler runs once per delivery,
 * post-verification.
 *
 * Per-delivery flow:
 *   1. Decode the JSON envelope produced by the in-tree Email
 *      Worker (`email-worker/src/index.ts`).
 *   2. Defense-in-depth idempotency — check the Message-ID against
 *      the bounded ring on the cursor store. The server's own
 *      `connection.runtime.idempotency` map is the primary defense;
 *      this is the second wall, mirroring github-webhooks.
 *   3. Build a `marfa.captured_email` item:
 *      - `source_id = Message-ID` (or the harness-supplied delivery
 *        id when Message-ID is absent, e.g. from a CC-only message
 *        synthesized at relay time)
 *      - `body` mirrors `text_body` so `core.note.body` is satisfied
 *        for cross-app readers.
 *   4. Emit a single `system.activity` summarizing the outcome.
 */
import {
  registerWebhookHandler,
  type ConnectionContext,
  type WebhookHandlerInput,
  type HandlerResult,
  type CreateItemInput,
} from "@withmarfa/runtime-sdk";
import { DELIVERY_RING_SIZE } from "./manifest.js";

const CURSOR_KEY = "delivery_ring";

interface DeliveryRing {
  ids: string[];
}

/** Wire shape produced by the in-tree Email Worker (`email-worker/src/index.ts`).
 *  Kept loose with optional fields — empty / absent headers are
 *  common (no Message-ID on synthesized messages, no `text_body` on
 *  HTML-only emails, etc.). */
interface EmailEnvelope {
  from?: { address?: string; name?: string };
  to?: string;
  subject?: string;
  text_body?: string;
  html_body?: string;
  sent_at?: string;
  message_id?: string;
  in_reply_to?: string;
  references?: string[];
  headers?: Record<string, string>;
  attachments?: {
    filename?: string;
    mime_type?: string;
    size_bytes?: number;
  }[];
}

export async function handleInboxWebhook(
  ctx: ConnectionContext,
  message: WebhookHandlerInput,
): Promise<HandlerResult> {
  const headers = message.headers;
  const deliveryIdHeader =
    getHeader(headers, "X-Marfa-Delivery-Id") ?? message.delivery_id;

  let envelope: EmailEnvelope;
  try {
    envelope = parseBody(message.body) as EmailEnvelope;
  } catch (err) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: "marfa/inbox: failed to parse webhook body",
      detail: { error: errorMessage(err) },
    });
    // Don't retry — a malformed body won't repair itself.
    return { ok: false, retry: false, reason: "parse_failed" };
  }

  // The Message-ID is the upstream-truth idempotency key. Fall back
  // to the envelope-level delivery id when Message-ID is absent
  // (e.g. synthesized relay messages with no `Message-ID:` header).
  // `message.delivery_id` is always set by the substrate, so the
  // fallback is always a non-empty string.
  const idempotencyKey = envelope.message_id ?? deliveryIdHeader;
  if (idempotencyKey.length > 0) {
    const ring = (await ctx.cursor.read(CURSOR_KEY)) as DeliveryRing | null;
    const ids = ring?.ids ?? [];
    if (ids.includes(idempotencyKey)) {
      await ctx.activity.emit({
        severity: "info",
        summary: `marfa/inbox: duplicate delivery ${idempotencyKey} ignored`,
      });
      return { ok: true };
    }
  }

  // Validate the minimum-viable shape. An envelope without a
  // `from.address` and a `to` is malformed and would fail the type
  // schema's `required` check anyway — surface a clear activity row
  // up front rather than letting it fall through.
  const fromAddress = envelope.from?.address;
  const toAddress = envelope.to;
  if (
    typeof fromAddress !== "string" ||
    fromAddress.length === 0 ||
    typeof toAddress !== "string" ||
    toAddress.length === 0
  ) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: "marfa/inbox: envelope missing required `from`/`to`",
      detail: {
        delivery_id: idempotencyKey,
        from_present: typeof fromAddress === "string",
        to_present: typeof toAddress === "string",
      },
    });
    return { ok: false, retry: false, reason: "envelope_invalid" };
  }

  const item = buildCapturedEmail(envelope, fromAddress, toAddress);

  try {
    const created = await ctx.marfa.createItem(item);
    // `properties.subject` is `unknown` from the indexed lookup —
    // narrow with a typeof guard before interpolating into the log
    // template.
    const subjectRaw = item.properties?.subject;
    const subjectText = typeof subjectRaw === "string" ? subjectRaw : "";
    await ctx.activity.emit({
      severity: "info",
      summary: `marfa/inbox: captured email ${created.id} (subject: ${subjectText})`,
      detail: {
        item_id: created.id,
        delivery_id: idempotencyKey,
        from: fromAddress,
        subject: envelope.subject,
      },
    });
  } catch (err) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: "marfa/inbox: failed to create captured_email",
      detail: {
        error: errorMessage(err),
        delivery_id: idempotencyKey,
      },
    });
    // Retry on Marfa-side failures; the delivery is not yet recorded
    // so the next attempt re-tries.
    return { ok: false, retry: true, reason: "create_failed" };
  }

  await recordDelivery(ctx, idempotencyKey);
  return { ok: true };
}

export function registerHandlers(): void {
  registerWebhookHandler(handleInboxWebhook);
}

function buildCapturedEmail(
  envelope: EmailEnvelope,
  fromAddress: string,
  toAddress: string,
): CreateItemInput {
  const properties: Record<string, unknown> = {
    from_address: fromAddress,
    to_address: toAddress,
    // Written unconditionally, empty string included, so a generic note
    // reader always finds a body where it expects one. Also what will
    // eventually let the type declare `core.note` compatibility: that claim
    // requires `body`, and the requirement can only land once no capture
    // is missing it.
    body: typeof envelope.text_body === "string" ? envelope.text_body : "",
  };
  if (envelope.from?.name !== undefined) {
    properties.from_name = envelope.from.name;
  }
  if (typeof envelope.subject === "string") {
    properties.subject = envelope.subject;
  }
  if (typeof envelope.text_body === "string" && envelope.text_body.length > 0) {
    properties.text_body = envelope.text_body;
  }
  if (typeof envelope.html_body === "string" && envelope.html_body.length > 0) {
    properties.html_body = envelope.html_body;
  }
  if (typeof envelope.sent_at === "string" && envelope.sent_at.length > 0) {
    properties.sent_at = envelope.sent_at;
  }
  if (
    typeof envelope.message_id === "string" &&
    envelope.message_id.length > 0
  ) {
    properties.message_id = envelope.message_id;
  }
  if (
    typeof envelope.in_reply_to === "string" &&
    envelope.in_reply_to.length > 0
  ) {
    properties.in_reply_to = envelope.in_reply_to;
  }
  if (Array.isArray(envelope.references) && envelope.references.length > 0) {
    properties.references = envelope.references;
  }
  if (
    envelope.headers !== undefined &&
    Object.keys(envelope.headers).length > 0
  ) {
    properties.headers = envelope.headers;
  }
  if (Array.isArray(envelope.attachments) && envelope.attachments.length > 0) {
    properties.attachments = envelope.attachments
      .filter(
        (a): a is { filename: string; mime_type: string; size_bytes: number } =>
          typeof a.filename === "string" &&
          typeof a.mime_type === "string" &&
          typeof a.size_bytes === "number",
      )
      .map((a) => ({
        filename: a.filename,
        mime_type: a.mime_type,
        size_bytes: a.size_bytes,
      }));
  }

  // `source_id = Message-ID` aligns the natural-key with the
  // upstream truth — a re-delivered email resolves to the same item
  // via the server's `(source, source_id)` upsert path.
  const sourceId =
    typeof envelope.message_id === "string" && envelope.message_id.length > 0
      ? envelope.message_id
      : undefined;

  return sourceId === undefined
    ? { type: "marfa.captured_email", properties }
    : { type: "marfa.captured_email", source_id: sourceId, properties };
}

async function recordDelivery(
  ctx: ConnectionContext,
  deliveryId: string | undefined,
): Promise<void> {
  if (deliveryId === undefined || deliveryId.length === 0) return;
  const ring = (await ctx.cursor.read(CURSOR_KEY)) as DeliveryRing | null;
  const ids = ring?.ids ?? [];
  ids.push(deliveryId);
  if (ids.length > DELIVERY_RING_SIZE) {
    ids.splice(0, ids.length - DELIVERY_RING_SIZE);
  }
  await ctx.cursor.write(CURSOR_KEY, { ids });
}

function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function parseBody(body: ArrayBuffer): unknown {
  const text = new TextDecoder().decode(body);
  return JSON.parse(text);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const __internals = { buildCapturedEmail };
