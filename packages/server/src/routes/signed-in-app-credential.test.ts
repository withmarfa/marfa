/**
 * A signed-in app is one credential across its token refreshes: its app and
 * the person it signed in as. Anything a request leaves behind for the same
 * credential to come back to is owned by that pair, not by the access-token
 * row a refresh replaces, and a token naming no person names no credential.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateId } from "@withmarfa/shared";
import {
  createTestContext,
  request,
  seedOauthBearer,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const SCOPES = ["core.note:write"];

/** A new access token for an app and person, as a refresh mints one. */
async function refreshed(clientId: string, authUserId: string) {
  const raw = `marfa_at_${generateId()}`;
  await ctx.storage.oauthProvider!.mintTokenPair({
    accessTokenHash: hashApiKey(
      raw.slice("marfa_at_".length),
      TEST_API_KEY_SALT,
    ),
    refreshTokenHash: hashApiKey(generateId(), TEST_API_KEY_SALT),
    clientId,
    authUserId,
    scopes: SCOPES,
    accessTtlMs: 3600_000,
  });
  return raw;
}

async function personOf(grantId: string): Promise<string> {
  const grant = await ctx.storage.items.get(grantId);
  return grant!.properties.user_id as string;
}

async function sql(statement: string, params: unknown[]): Promise<void> {
  await (
    ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun(statement, params);
}

describe("a bulk-action job queued by a signed-in app", () => {
  it("belongs to its app and person across a token refresh", async () => {
    const first = await seedOauthBearer(ctx.storage, SCOPES);
    const person = await personOf(first.grantId);
    const tag = `owner-${generateId()}`;
    const key = `owner-key-${generateId()}`;
    const body = {
      action: "update_tags",
      add: ["done"],
      filter: { tags: [tag] },
    };

    const queued = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: first.token,
      headers: { "Idempotency-Key": key },
      body,
    });
    expect(queued.status).toBe(202);
    const job = (await queued.json()) as { id: string };

    const next = await refreshed(first.clientId, person);
    const retried = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: next,
      headers: { "Idempotency-Key": key },
      body,
    });
    expect(retried.headers.get("Idempotency-Replayed")).toBe("true");
    expect(((await retried.json()) as { id: string }).id).toBe(job.id);

    const read = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${job.id}`,
      { key: next },
    );
    expect(read.status).toBe(200);
    const cancel = await request(
      ctx.app,
      "DELETE",
      `/items/bulk-actions/jobs/${job.id}`,
      { key: next },
    );
    expect(cancel.status).toBe(200);

    // The witness: another person signed in to the same app is not its owner.
    const someoneElse = await seedOauthBearer(ctx.storage, SCOPES);
    const elsewhere = await refreshed(
      first.clientId,
      await personOf(someoneElse.grantId),
    );
    const refused = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${job.id}`,
      { key: elsewhere },
    );
    expect(refused.status).toBe(403);
  });
});

describe("a token naming no person", () => {
  it("is refused as no credential at all", async () => {
    const seeded = await seedOauthBearer(ctx.storage, SCOPES);
    // The witness: the same token, with its person, is a credential.
    const before = await request(ctx.app, "GET", "/items", {
      key: seeded.token,
    });
    expect(before.status).toBe(200);

    await sql(
      "UPDATE auth_oauth_access_token SET user_id = NULL WHERE token = ?",
      [hashApiKey(seeded.token.slice("marfa_at_".length), TEST_API_KEY_SALT)],
    );
    const after = await request(ctx.app, "POST", "/items", {
      key: seeded.token,
      headers: { "Idempotency-Key": `no-person-${generateId()}` },
      body: { type: "core.note", properties: { body: "nobody" } },
    });
    expect(after.status).toBe(401);
  });
});
