/**
 * Regression suite for the two fences that stop a credential reaching past
 * the authority it was given.
 *
 * 1. **A mint never exceeds its caller.** `POST /keys` takes the new key's
 *    permissions from the request body, so a credential asking for one
 *    it does not hold itself would widen by minting. The clamp refuses by
 *    name; a peer mint of what the caller already holds is permitted, because
 *    privilege travels sideways or down.
 *
 * 2. **The operator tier is a flag on the row and nothing else.**
 *    `checkOperatorKey` reads `is_operator`, so a working credential reaches
 *    none of the operator doors however it came to exist.
 *
 * Each layer is tested on its own, because either fence holding says nothing
 * about the other.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { ApiKey, Permission } from "@withmarfa/shared";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import { checkOperatorKey, hashApiKey } from "./auth.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { readInstanceConfig } from "../storage/instance-config.js";

// ---------------------------------------------------------------------------
// Unit — checkOperatorKey reads the flag
// ---------------------------------------------------------------------------

function fakeKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key-test",
    label: "test",
    source: "test",
    is_operator: false,
    default_tier: "library",
    type_permissions: {},
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: new Date().toISOString(),
    last_used_at: null,
    ...overrides,
  };
}

describe("checkOperatorKey (unit)", () => {
  it("admits an unbound operator key", () => {
    const key = fakeKey({ is_operator: true });
    expect(checkOperatorKey(key)).toBe(key);
  });

  it("rejects a credential without the operator flag", () => {
    expect(() => checkOperatorKey(fakeKey({ is_operator: false }))).toThrow(
      MarfaError,
    );
    expect(() => checkOperatorKey(fakeKey())).toThrow(MarfaError);
  });

  it("rejects undefined with UNAUTHORIZED", () => {
    try {
      checkOperatorKey(undefined);
      expect.unreachable(
        "checkOperatorKey must throw for a missing credential",
      );
    } catch (e) {
      expect((e as MarfaError).code).toBe(ErrorCode.UNAUTHORIZED);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

async function mintKey(
  ctx: TestContext,
  opts: {
    label: string;
    permissions?: Permission[];
    is_operator?: boolean;
  },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_escalation_test_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: opts.label,
      source: `${opts.label}-${suffix}`,
      permissions: opts.permissions ?? [],
      default_tier: "library",
      type_permissions: {},
      is_operator: opts.is_operator ?? false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return raw;
}

describe("the mint never exceeds the caller", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("refuses a permission the caller does not hold, by name", async () => {
    ctx = await createTestContext();
    const caller = await mintKey(ctx, {
      label: "clamp-caller",
      permissions: ["keys.mint", "webhooks.manage"],
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: caller,
      body: {
        label: "escalated",
        source: `escalated-${Math.random().toString(36).slice(2, 10)}`,
        default_tier: "library",
        permissions: ["config.manage"],
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details?: { required_scope?: string } };
    };
    expect(body.error.code).toBe("forbidden");
    // The refusal names the literal, so a client can narrow toward something
    // it could actually be granted.
    expect(body.error.details?.required_scope).toBe("config.manage");
  });

  it("permits a peer mint of what the caller already holds", async () => {
    ctx = await createTestContext();
    const caller = await mintKey(ctx, {
      label: "peer-caller",
      permissions: ["keys.mint", "webhooks.manage"],
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: caller,
      body: {
        label: "peer",
        source: `peer-${Math.random().toString(36).slice(2, 10)}`,
        default_tier: "library",
        permissions: ["webhooks.manage"],
      },
    });

    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };

    // Read back from the store rather than from the response: the stored row
    // is what the credential actually holds, and it is what a later gate asks.
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.permissions).toEqual(["webhooks.manage"]);
  });
});

describe("instance config is self-service behind config.manage", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("a holder of config.manage reads and writes the instance config", async () => {
    ctx = await createTestContext();
    const caller = await mintKey(ctx, {
      label: "config-holder",
      permissions: ["config.manage"],
    });

    const put = await request(ctx.app, "PUT", "/config", {
      key: caller,
      body: { trash_retention_days: 7 },
    });
    expect(put.status).toBe(200);

    const get = await request(ctx.app, "GET", "/config", {
      key: caller,
    });
    expect(get.status).toBe(200);
    expect((await get.json()) as Record<string, unknown>).toMatchObject({
      trash_retention_days: 7,
    });

    // The write landed on the instance config.
    const stored = await readInstanceConfig(ctx.storage.settings);
    expect(stored?.trash_retention_days).toBe(7);
  });

  it("refuses a credential that does not hold config.manage", async () => {
    ctx = await createTestContext();
    const caller = await mintKey(ctx, {
      label: "config-none",
    });

    const res = await request(ctx.app, "GET", "/config", {
      key: caller,
    });
    expect(res.status).toBe(403);
  });
});
