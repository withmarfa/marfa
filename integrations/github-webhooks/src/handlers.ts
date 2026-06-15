/**
 * GitHub Webhooks handler.
 *
 * The control plane verifies the HMAC signature against the
 * subscription's stored secret using the `github` adapter, then
 * enqueues the verified delivery onto the per-Integration
 * `webhook-receipt` queue. This handler runs once per delivery,
 * post-verification.
 *
 * Per-delivery flow:
 *   1. Read X-GitHub-Delivery from the headers — the dedup key.
 *   2. Check + record in a bounded ring on the cursor store.
 *      Already-seen → no-op (defense-in-depth alongside the
 *      server-side external_delivery_id UNIQUE constraint).
 *   3. Read X-GitHub-Event to discriminate the payload shape.
 *      Currently handles `issues` and `pull_request` opened
 *      actions; other events are acked silently.
 *   4. Build a `core.bookmark` and create it.
 *   5. Emit a single `system.activity` summarizing the outcome.
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

interface IssuePayload {
  action: string;
  issue?: {
    id?: number;
    node_id?: string;
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    user?: { login?: string };
  };
  repository?: { full_name?: string; html_url?: string };
}

interface PullRequestPayload {
  action: string;
  pull_request?: {
    id?: number;
    node_id?: string;
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    user?: { login?: string };
  };
  repository?: { full_name?: string; html_url?: string };
}

export async function handleGithubWebhook(
  ctx: ConnectionContext,
  message: WebhookHandlerInput,
): Promise<HandlerResult> {
  const headers = message.headers;
  const event = getHeader(headers, "X-GitHub-Event");
  const deliveryId = getHeader(headers, "X-GitHub-Delivery");

  if (deliveryId !== undefined) {
    const ring = (await ctx.cursor.read(CURSOR_KEY)) as DeliveryRing | null;
    const ids = ring?.ids ?? [];
    if (ids.includes(deliveryId)) {
      await ctx.activity.emit({
        severity: "info",
        summary: `github-webhooks: duplicate delivery ${deliveryId} ignored`,
      });
      return { ok: true };
    }
  }

  let payload: unknown;
  try {
    payload = parseBody(message.body);
  } catch (err) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: "github-webhooks: failed to parse webhook body",
      detail: { error: errorMessage(err) },
    });
    // Don't retry — a malformed body won't repair itself.
    return { ok: false, retry: false, reason: "parse_failed" };
  }

  let bookmark: CreateItemInput | null = null;
  if (event === "issues") {
    bookmark = buildIssueBookmark(payload as IssuePayload);
  } else if (event === "pull_request") {
    bookmark = buildPullRequestBookmark(payload as PullRequestPayload);
  } else if (event === "ping") {
    // GitHub sends a `ping` on webhook setup. Verify-and-ack but
    // create no bookmark.
    await ctx.activity.emit({
      severity: "info",
      summary: "github-webhooks: ping received",
    });
    await recordDelivery(ctx, deliveryId);
    return { ok: true };
  }

  if (bookmark === null) {
    // Unhandled event type or unhandled action (e.g. issues.closed).
    // Ack and record so we don't reprocess on duplicate delivery.
    await ctx.activity.emit({
      severity: "info",
      summary: `github-webhooks: skipped event=${event ?? "unknown"} (no bookmark built)`,
    });
    await recordDelivery(ctx, deliveryId);
    return { ok: true };
  }

  try {
    const created = await ctx.marfa.createItem(bookmark);
    await ctx.activity.emit({
      severity: "info",
      summary: `github-webhooks: created ${event ?? "unknown"} bookmark ${created.id}`,
      detail: {
        item_id: created.id,
        delivery_id: deliveryId,
        event,
      },
    });
  } catch (err) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: `github-webhooks: failed to create ${event ?? "unknown"} bookmark`,
      detail: { error: errorMessage(err), delivery_id: deliveryId },
    });
    // Retry on server-side failures; the delivery is not yet
    // recorded so the next attempt re-tries.
    return { ok: false, retry: true, reason: "create_failed" };
  }

  await recordDelivery(ctx, deliveryId);
  return { ok: true };
}

export function registerHandlers(): void {
  registerWebhookHandler(handleGithubWebhook);
}

async function recordDelivery(
  ctx: ConnectionContext,
  deliveryId: string | undefined,
): Promise<void> {
  if (deliveryId === undefined) return;
  const ring = (await ctx.cursor.read(CURSOR_KEY)) as DeliveryRing | null;
  const ids = ring?.ids ?? [];
  ids.push(deliveryId);
  if (ids.length > DELIVERY_RING_SIZE) {
    ids.splice(0, ids.length - DELIVERY_RING_SIZE);
  }
  await ctx.cursor.write(CURSOR_KEY, { ids });
}

function buildIssueBookmark(payload: IssuePayload): CreateItemInput | null {
  if (payload.action !== "opened") return null;
  const issue = payload.issue;
  if (!issue || typeof issue.html_url !== "string") return null;
  const properties: Record<string, unknown> = {
    title: issue.title ?? `Issue #${String(issue.number ?? "")}`,
    url: issue.html_url,
  };
  if (issue.body !== null && issue.body !== undefined)
    properties.body = issue.body;
  if (issue.user?.login !== undefined) properties.author = issue.user.login;
  if (payload.repository?.html_url !== undefined) {
    properties.source_url = payload.repository.html_url;
  }
  if (payload.repository?.full_name !== undefined) {
    properties.source_title = `${payload.repository.full_name} / issues`;
  }
  // Prefer GraphQL global node_id (opaque, stable) over numeric id;
  // fall back to numeric id when the payload lacks node_id. Threads
  // the server's `(source, source_id)` natural-key contract so a
  // duplicate delivery can't produce two rows.
  const sourceId = pickSourceId(issue.node_id, issue.id);
  return sourceId === undefined
    ? { type: "core.bookmark", properties }
    : { type: "core.bookmark", source_id: sourceId, properties };
}

function buildPullRequestBookmark(
  payload: PullRequestPayload,
): CreateItemInput | null {
  if (payload.action !== "opened") return null;
  const pr = payload.pull_request;
  if (!pr || typeof pr.html_url !== "string") return null;
  const properties: Record<string, unknown> = {
    title: pr.title ?? `PR #${String(pr.number ?? "")}`,
    url: pr.html_url,
  };
  if (pr.body !== null && pr.body !== undefined) properties.body = pr.body;
  if (pr.user?.login !== undefined) properties.author = pr.user.login;
  if (payload.repository?.html_url !== undefined) {
    properties.source_url = payload.repository.html_url;
  }
  if (payload.repository?.full_name !== undefined) {
    properties.source_title = `${payload.repository.full_name} / pull_requests`;
  }
  const sourceId = pickSourceId(pr.node_id, pr.id);
  return sourceId === undefined
    ? { type: "core.bookmark", properties }
    : { type: "core.bookmark", source_id: sourceId, properties };
}

function pickSourceId(
  nodeId: string | undefined,
  numericId: number | undefined,
): string | undefined {
  if (typeof nodeId === "string" && nodeId.length > 0) return nodeId;
  if (typeof numericId === "number") return String(numericId);
  return undefined;
}

function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  // GitHub uses canonical title-case (X-GitHub-Event); Hono /
  // Cloudflare normalisations may lowercase. Accept either.
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
