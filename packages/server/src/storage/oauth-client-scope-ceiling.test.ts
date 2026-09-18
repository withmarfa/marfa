/**
 * Round-trip tests for the client scope ceiling, across both dialects.
 *
 * The plugin resolves the set it validates against as
 * `client.scopes ?? opts.scopes`. That is null-coalescing, so exactly one
 * stored value means "track the live allowlist" — SQL NULL — and every other
 * value, empty array included, is a frozen ceiling that wins outright.
 *
 * Three distinct values therefore have to survive the write and the read
 * without collapsing into each other:
 *
 *   NULL  → no ceiling; the client tracks whatever the server advertises
 *   []    → a real ceiling permitting nothing
 *   [...] → a real ceiling permitting exactly those
 *
 * The failure mode this file exists to catch: `scopes` is JSON in a `text`
 * column, where `JSON.stringify(null)` is the four-character string
 * `"null"`, a present value the plugin then reads as a ceiling.
 *
 * **These assertions read the raw column, not `getClient`.** A first version
 * of this file round-tripped through the store's own reader and passed
 * against the broken write on SQLite, because that reader parses `"null"`
 * back to `null` and hid the defect it was meant to catch. It is also the
 * wrong instrument on principle: the plugin never calls Marfa's reader, it
 * goes through Better Auth's own adapter to the same column, so the column
 * is the contract and anything softer measures the wrong side of it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

let counter = 0;
function nextClientId(): string {
  counter += 1;
  return `ceiling-test-${String(counter)}-${String(Date.now())}`;
}

/**
 * Create a client, then read `scopes` straight out of the table.
 *
 * Returns the raw column: SQL NULL surfaces as `null`, a JSON payload as
 * the string that was stored. The
 * caller asserts on that, so a value that only *looks* absent after parsing
 * cannot pass.
 */
async function createAndReadRawColumn(
  c: TestContext,
  scopes: readonly string[] | null,
): Promise<unknown> {
  const oauth = c.storage.oauthProvider;
  if (!oauth) throw new Error("storage.oauthProvider missing");
  const clientId = nextClientId();
  await oauth.createClient({
    clientId,
    name: "Ceiling Test Client",
    isPublic: true,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    scopes,
    redirectUris: ["https://example.test/auth/callback"],
    postLogoutRedirectUris: ["https://example.test/"],
    referenceId: null,
  });

  const query = sql`SELECT scopes FROM auth_oauth_client WHERE client_id = ${clientId}`;
  const db = c.storage.betterAuthDb as {
    execute?: (q: unknown) => Promise<unknown>;
    all?: (q: unknown) => Promise<unknown>;
  };
  const result = await db.all?.(query);
  const row = (result as Record<string, unknown>[] | undefined)?.[0];
  if (!row) throw new Error(`client ${clientId} did not persist`);
  return row.scopes;
}

/** True only for SQL NULL — never for `"null"`, `"[]"` or `[]`. */
function isAbsent(stored: unknown): boolean {
  return stored === null || stored === undefined;
}

describe("oauth client scope ceiling", () => {
  it("writes SQL NULL for no ceiling, on either dialect", async () => {
    ctx = await createTestContext({});
    const stored = await createAndReadRawColumn(ctx, null);
    // The near-miss this rules out: writing the string `"null"` from
    // `JSON.stringify(null)`. That is a present value, so the plugin's
    // `client.scopes ?? opts.scopes` stops falling through and the client
    // is pinned to a ceiling nobody meant to give it.
    expect(stored).not.toBe("null");
    expect(stored).not.toEqual([]);
    expect(isAbsent(stored)).toBe(true);
  });

  it("keeps an empty ceiling as a present, empty value", async () => {
    ctx = await createTestContext({});
    const stored = await createAndReadRawColumn(ctx, []);
    // `??` does not fall through on `[]`. If this ever became NULL, a client
    // registered for nothing would silently gain the whole allowlist.
    expect(isAbsent(stored)).toBe(false);
    expect(JSON.parse(String(stored))).toEqual([]);
  });

  it("preserves a real ceiling verbatim", async () => {
    ctx = await createTestContext({});
    const scopes = ["openid", "core.note:read", "core.task:write"];
    const stored = await createAndReadRawColumn(ctx, scopes);
    expect(isAbsent(stored)).toBe(false);
    expect(JSON.parse(String(stored))).toEqual(scopes);
  });

  it("the three values stay mutually distinguishable in the column", async () => {
    ctx = await createTestContext({});
    // Asserted together because the defect is always a collapse of one into
    // another, and each case passing alone does not prove they stayed apart.
    const absent = await createAndReadRawColumn(ctx, null);
    const empty = await createAndReadRawColumn(ctx, []);
    const real = await createAndReadRawColumn(ctx, ["openid"]);

    expect(isAbsent(absent)).toBe(true);
    expect(isAbsent(empty)).toBe(false);
    expect(isAbsent(real)).toBe(false);
    expect(empty).not.toEqual(real);
  });

  it("the store's reader reports the column faithfully", async () => {
    ctx = await createTestContext({});
    const oauth = ctx.storage.oauthProvider;
    if (!oauth) throw new Error("storage.oauthProvider missing");

    // The reader is deliberately forgiving about unparseable values, which
    // is right at runtime and wrong as an oracle — it is what let a broken
    // write look correct. Pinned here separately, against writes already
    // proven correct at the column above, so the two cannot drift.
    const mk = async (scopes: readonly string[] | null): Promise<string> => {
      const clientId = nextClientId();
      await oauth.createClient({
        clientId,
        name: "Ceiling Reader Client",
        isPublic: true,
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        scopes,
        redirectUris: ["https://example.test/auth/callback"],
        postLogoutRedirectUris: ["https://example.test/"],
        referenceId: null,
      });
      return clientId;
    };

    expect((await oauth.getClient(await mk(null)))?.scopes).toBeNull();
    expect((await oauth.getClient(await mk([])))?.scopes).toEqual([]);
    expect((await oauth.getClient(await mk(["openid"])))?.scopes).toEqual([
      "openid",
    ]);
  });
});
