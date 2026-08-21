/**
 * Handler-level tests for the GitHub Webhooks integration.
 *
 * Builds ConnectionContext inline; HMAC verification is exercised
 * server-side (the `github` adapter has its own test in
 * @withmarfa/server). These tests assume verification has already
 * passed and the delivery has reached the handler.
 */
import { describe, it, expect } from "vitest";
import {
  createCursorStore,
  createActivitySink,
  createEchoSuppression,
  type ConnectionContext,
  type ConnectionClient,
  type CreateItemInput,
  type WebhookHandlerInput,
  familyOnlyMappingResolver,
} from "@withmarfa/runtime-sdk";
import { handleGithubWebhook } from "./handlers.js";
import { DELIVERY_RING_SIZE } from "./manifest.js";

interface InMemoryStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

function createMemoryStorage(): InMemoryStorage {
  const data = new Map<string, unknown>();
  return {
    get(key) {
      return Promise.resolve(data.get(key));
    },
    put(key, value) {
      data.set(key, value);
      return Promise.resolve();
    },
    delete(key) {
      return Promise.resolve(data.delete(key));
    },
  };
}

interface CapturedActivity {
  type: string;
  properties?: Record<string, unknown>;
}

interface BuildOpts {
  /** Make createItem reject the first call. */
  failCreate?: boolean;
}

interface BuiltContext {
  ctx: ConnectionContext;
  emitted: CapturedActivity[];
  created: CreateItemInput[];
}

function buildContext(opts: BuildOpts = {}): BuiltContext {
  const storage = createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const created: CreateItemInput[] = [];
  let bookmarkAttempts = 0;
  const connectionId = "conn_gh_test";

  const client = {
    createItem: (input: CreateItemInput) => {
      if (input.type === "system.activity") {
        emitted.push({ type: input.type, properties: input.properties });
        return Promise.resolve({ id: "act_x", type: input.type });
      }
      bookmarkAttempts += 1;
      if (opts.failCreate === true && bookmarkAttempts === 1) {
        return Promise.reject(new Error("server 500"));
      }
      created.push(input);
      return Promise.resolve({
        id: `itm_${String(created.length)}`,
        type: input.type,
      });
    },
    getItem: () => Promise.resolve(null),
  } as unknown as ConnectionClient;

  const ctx: ConnectionContext = {
    connection_id: connectionId,
    integration_name: "marfa/github-webhooks",
    marfa: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, connectionId),
    echo: createEchoSuppression(storage, { echo_ttl_seconds: 60 }),
    mapping: familyOnlyMappingResolver(),
    cycle: null,
  };
  return { ctx, emitted, created };
}

const ISSUES_OPENED = {
  action: "opened",
  issue: {
    id: 1234567890,
    node_id: "I_kwDOABCDEFG12345",
    number: 42,
    title: "Repro: integration misses ping",
    body: "Steps to reproduce…",
    html_url: "https://github.com/withmarfa/marfa/issues/42",
    user: { login: "octocat" },
  },
  repository: {
    full_name: "withmarfa/marfa",
    html_url: "https://github.com/withmarfa/marfa",
  },
};

const PR_OPENED = {
  action: "opened",
  pull_request: {
    id: 9876543210,
    node_id: "PR_kwDOABCDEFG67890",
    number: 7,
    title: "Add Layer-3 RSS integration",
    body: "First Layer-3 PR.",
    html_url: "https://github.com/withmarfa/marfa/pull/7",
    user: { login: "augustcayzer" },
  },
  repository: {
    full_name: "withmarfa/marfa",
    html_url: "https://github.com/withmarfa/marfa",
  },
};

const PR_CLOSED = {
  action: "closed",
  pull_request: {
    number: 7,
    title: "Add Layer-3 RSS integration",
    html_url: "https://github.com/withmarfa/marfa/pull/7",
  },
  repository: { full_name: "withmarfa/marfa" },
};

const PING = { zen: "Non-blocking is better than blocking." };

function makeWebhookMessage(
  body: unknown,
  event: string,
  deliveryId: string,
  headerCase: "title" | "lower" = "title",
): WebhookHandlerInput {
  const headers: Record<string, string> =
    headerCase === "title"
      ? {
          "X-GitHub-Event": event,
          "X-GitHub-Delivery": deliveryId,
          "Content-Type": "application/json",
        }
      : {
          "x-github-event": event,
          "x-github-delivery": deliveryId,
          "content-type": "application/json",
        };
  const bodyBuffer = new TextEncoder().encode(JSON.stringify(body)).buffer;
  return {
    delivery_id: deliveryId,
    headers,
    body: bodyBuffer,
    verified_at_ms: Date.now(),
  };
}

describe("github-webhooks handler", () => {
  it("creates a core.bookmark on issues.opened", async () => {
    const { ctx, created, emitted } = buildContext();
    const result = await handleGithubWebhook(
      ctx,
      makeWebhookMessage(ISSUES_OPENED, "issues", "delivery_001"),
    );
    expect(result).toEqual({ ok: true });
    expect(created).toHaveLength(1);
    expect(created[0]!.properties).toMatchObject({
      title: "Repro: integration misses ping",
      url: "https://github.com/withmarfa/marfa/issues/42",
      author: "octocat",
      source_url: "https://github.com/withmarfa/marfa",
      source_title: "withmarfa/marfa / issues",
    });
    // source_id is populated from the GraphQL node_id, threading the
    // server's `(source, source_id)` natural-key contract.
    expect(created[0]!.source_id).toBe("I_kwDOABCDEFG12345");
    // Activity summary references the real bookmark id, not the
    // literal string "undefined".
    const summary = emitted.at(-1);
    expect(summary?.properties?.summary).toMatch(
      /created issues bookmark itm_\d+$/,
    );
    expect(summary?.properties?.summary).not.toContain("undefined");
  });

  it("creates a core.bookmark on pull_request.opened", async () => {
    const { ctx, created } = buildContext();
    await handleGithubWebhook(
      ctx,
      makeWebhookMessage(PR_OPENED, "pull_request", "delivery_002"),
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.properties).toMatchObject({
      title: "Add Layer-3 RSS integration",
      url: "https://github.com/withmarfa/marfa/pull/7",
      author: "augustcayzer",
      source_title: "withmarfa/marfa / pull_requests",
    });
    expect(created[0]!.source_id).toBe("PR_kwDOABCDEFG67890");
  });

  it("falls back to numeric id for source_id when node_id is missing", async () => {
    const { ctx, created } = buildContext();
    const noNodeId = {
      action: "opened",
      issue: {
        id: 555,
        // node_id intentionally absent
        number: 99,
        title: "No node id",
        html_url: "https://github.com/withmarfa/marfa/issues/99",
      },
      repository: { full_name: "withmarfa/marfa" },
    };
    await handleGithubWebhook(
      ctx,
      makeWebhookMessage(noNodeId, "issues", "delivery_no_node"),
    );
    expect(created[0]!.source_id).toBe("555");
  });

  it("does not create a bookmark for pull_request.closed (action filtered)", async () => {
    const { ctx, created, emitted } = buildContext();
    await handleGithubWebhook(
      ctx,
      makeWebhookMessage(PR_CLOSED, "pull_request", "delivery_003"),
    );
    expect(created).toHaveLength(0);
    expect(emitted.at(-1)?.properties?.summary).toMatch(/skipped event=/);
  });

  it("ack-and-records ping deliveries without creating a bookmark", async () => {
    const { ctx, created, emitted } = buildContext();
    await handleGithubWebhook(
      ctx,
      makeWebhookMessage(PING, "ping", "delivery_004"),
    );
    expect(created).toHaveLength(0);
    expect(emitted.at(-1)?.properties?.summary).toBe(
      "github-webhooks: ping received",
    );
  });

  it("dedupes duplicate deliveries via the bounded ring", async () => {
    const { ctx, created, emitted } = buildContext();
    await handleGithubWebhook(
      ctx,
      makeWebhookMessage(ISSUES_OPENED, "issues", "delivery_dup"),
    );
    expect(created).toHaveLength(1);
    await handleGithubWebhook(
      ctx,
      makeWebhookMessage(ISSUES_OPENED, "issues", "delivery_dup"),
    );
    // Second delivery skipped — still only 1 bookmark.
    expect(created).toHaveLength(1);
    const dupSummary = emitted.at(-1);
    expect(dupSummary?.properties?.summary).toBe(
      "github-webhooks: duplicate delivery delivery_dup ignored",
    );
  });

  it("accepts headers in lowercase form (Hono normalization)", async () => {
    const { ctx, created } = buildContext();
    await handleGithubWebhook(
      ctx,
      makeWebhookMessage(ISSUES_OPENED, "issues", "delivery_lc", "lower"),
    );
    expect(created).toHaveLength(1);
  });

  it("retries on Marfa-side createItem failure (delivery NOT recorded)", async () => {
    const { ctx, created, emitted } = buildContext({ failCreate: true });
    const r1 = await handleGithubWebhook(
      ctx,
      makeWebhookMessage(ISSUES_OPENED, "issues", "delivery_fail"),
    );
    expect(r1).toEqual({
      ok: false,
      retry: true,
      reason: "create_failed",
    });
    expect(created).toHaveLength(0);
    expect(
      emitted.some((e) => e.properties?.severity === "action_required"),
    ).toBe(true);

    // A retry attempt should NOT be deduped — the delivery wasn't
    // recorded on the failed run.
    const r2 = await handleGithubWebhook(
      ctx,
      makeWebhookMessage(ISSUES_OPENED, "issues", "delivery_fail"),
    );
    expect(r2).toEqual({ ok: true });
    expect(created).toHaveLength(1);
  });

  it("returns parse_failed (no retry) on malformed body", async () => {
    const { ctx, emitted } = buildContext();
    const broken: WebhookHandlerInput = {
      delivery_id: "delivery_bad",
      headers: {
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "delivery_bad",
      },
      body: new TextEncoder().encode("not-json").buffer,
      verified_at_ms: Date.now(),
    };
    const r = await handleGithubWebhook(ctx, broken);
    expect(r).toEqual({
      ok: false,
      retry: false,
      reason: "parse_failed",
    });
    expect(emitted[0]?.properties?.severity).toBe("action_required");
  });

  it("delivery ring stays bounded at DELIVERY_RING_SIZE", async () => {
    const { ctx } = buildContext();
    // Pre-seed ring near capacity, then add a fresh delivery.
    const seeded = Array.from(
      { length: DELIVERY_RING_SIZE },
      (_, i) => `seed_${String(i)}`,
    );
    await ctx.cursor.write("delivery_ring", { ids: seeded });

    await handleGithubWebhook(
      ctx,
      makeWebhookMessage(ISSUES_OPENED, "issues", "delivery_new"),
    );
    const ring = (await ctx.cursor.read("delivery_ring")) as { ids: string[] };
    expect(ring.ids).toHaveLength(DELIVERY_RING_SIZE);
    expect(ring.ids.includes("seed_0")).toBe(false);
    expect(ring.ids.at(-1)).toBe("delivery_new");
  });
});
