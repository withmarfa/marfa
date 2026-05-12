import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Webhook } from "svix";
import { createTestContext, request, type TestContext } from "../test-utils.js";

interface ErrorBody {
  error: { code: string; message: string };
}

// Resend webhook receiver fixtures. svix-sign uses the same secret on both
// sides; for tests we sign with a deterministic value the server accepts.
const TEST_SECRET = "whsec_dGVzdC1zZWNyZXQtdmFsdWUtZm9yLXJlc2VuZA==";

function signPayload(secret: string, payload: string) {
  const msgId = "msg_test_" + Math.random().toString(36).slice(2, 12);
  const timestamp = new Date();
  const wh = new Webhook(secret);
  const signature = wh.sign(msgId, timestamp, payload);
  return {
    "svix-id": msgId,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": signature,
  };
}

describe("POST /webhooks/resend — verification gate", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext({ resendWebhookSecret: TEST_SECRET });
  });
  afterEach(() => {
    ctx.cleanup();
  });

  it("rejects requests missing svix signature headers with webhook_signature_missing", async () => {
    const res = await request(ctx.app, "POST", "/webhooks/resend", {
      body: { type: "email.delivered", created_at: "2026-05-12T00:00:00Z" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("webhook_signature_missing");
    expect(body.error.message).toBeTruthy();
  });

  it("rejects requests with bad signature with webhook_signature_invalid (401)", async () => {
    const payload = JSON.stringify({
      type: "email.delivered",
      created_at: "2026-05-12T00:00:00Z",
      data: {},
    });
    const res = await request(ctx.app, "POST", "/webhooks/resend", {
      body: { type: "email.delivered", created_at: "2026-05-12T00:00:00Z" },
      headers: {
        "svix-id": "msg_test_bad",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,deadbeef",
      },
    });
    void payload;
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("webhook_signature_invalid");
  });
});

describe("POST /webhooks/resend — secret-unconfigured", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    // Empty string is the runtime sentinel — the route is still mounted,
    // but verification short-circuits to 503.
    ctx = await createTestContext({ resendWebhookSecret: "" });
  });
  afterEach(() => {
    ctx.cleanup();
  });

  it("returns webhook_secret_not_configured (503) when secret is unset", async () => {
    const res = await request(ctx.app, "POST", "/webhooks/resend", {
      body: { type: "email.delivered", created_at: "2026-05-12T00:00:00Z" },
      headers: {
        "svix-id": "msg_test_unset",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,placeholder",
      },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("webhook_secret_not_configured");
  });
});

describe("POST /webhooks/resend — event handling", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext({ resendWebhookSecret: TEST_SECRET });
  });
  afterEach(() => {
    ctx.cleanup();
  });

  it("acks a delivered event without writing suppression", async () => {
    const payload = JSON.stringify({
      type: "email.delivered",
      created_at: "2026-05-12T00:00:00Z",
      data: { email_id: "em_1", to: "alice@example.com" },
    });
    const res = await request(ctx.app, "POST", "/webhooks/resend", {
      headers: signPayload(TEST_SECRET, payload),
      body: JSON.parse(payload),
    });
    expect(res.status).toBe(200);
    if (!ctx.storage.emailSuppressions) {
      throw new Error("emailSuppressions store unwired in test storage");
    }
    const existing = await ctx.storage.emailSuppressions.isSuppressed(
      "",
      "alice@example.com",
    );
    expect(existing).toBeNull();
  });

  it("upserts a suppression on a permanent bounce", async () => {
    const payload = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-05-12T00:00:00Z",
      data: {
        email_id: "em_bounce_1",
        to: "Bouncy@Example.com",
        bounce: { type: "Permanent", subType: "General" },
      },
    });
    const res = await request(ctx.app, "POST", "/webhooks/resend", {
      headers: signPayload(TEST_SECRET, payload),
      body: JSON.parse(payload),
    });
    expect(res.status).toBe(200);
    if (!ctx.storage.emailSuppressions) {
      throw new Error("emailSuppressions store unwired in test storage");
    }
    const row = await ctx.storage.emailSuppressions.isSuppressed(
      "",
      "bouncy@example.com",
    );
    expect(row?.reason).toBe("hard_bounce");
    expect(row?.source_email_id).toBe("em_bounce_1");
  });

  it("upserts a suppression on a complaint", async () => {
    const payload = JSON.stringify({
      type: "email.complained",
      created_at: "2026-05-12T00:00:00Z",
      data: {
        email_id: "em_complaint_1",
        to: "claimant@example.com",
      },
    });
    const res = await request(ctx.app, "POST", "/webhooks/resend", {
      headers: signPayload(TEST_SECRET, payload),
      body: JSON.parse(payload),
    });
    expect(res.status).toBe(200);
    if (!ctx.storage.emailSuppressions) {
      throw new Error("emailSuppressions store unwired in test storage");
    }
    const row = await ctx.storage.emailSuppressions.isSuppressed(
      "",
      "claimant@example.com",
    );
    expect(row?.reason).toBe("complaint");
  });

  it("ignores soft bounces (Temporary type) without writing suppression", async () => {
    const payload = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-05-12T00:00:00Z",
      data: {
        email_id: "em_soft_1",
        to: "soft@example.com",
        bounce: { type: "Temporary", subType: "MailboxFull" },
      },
    });
    const res = await request(ctx.app, "POST", "/webhooks/resend", {
      headers: signPayload(TEST_SECRET, payload),
      body: JSON.parse(payload),
    });
    expect(res.status).toBe(200);
    if (!ctx.storage.emailSuppressions) {
      throw new Error("emailSuppressions store unwired in test storage");
    }
    const row = await ctx.storage.emailSuppressions.isSuppressed(
      "",
      "soft@example.com",
    );
    expect(row).toBeNull();
  });
});
