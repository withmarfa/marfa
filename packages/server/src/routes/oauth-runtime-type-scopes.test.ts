/**
 * A type registered while the server runs can be asked for and granted at
 * once, and deleting it again neither breaks an authorization that names it
 * nor the grants already issued.
 */

import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request, TEST_OWNER } from "../test-utils.js";

vi.setConfig({ testTimeout: 45_000 });

const BASE = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

async function registerClient(
  c: TestContext,
  scope?: string,
): Promise<{ status: number; clientId: string }> {
  const res = await request(c.app, "POST", "/auth/oauth2/register", {
    body: {
      application_type: "native",
      token_endpoint_auth_method: "none",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Runtime Type Client",
      ...(scope ? { scope } : {}),
    },
    headers: { cookie: c.owner.cookie, origin: BASE },
  });
  const body = (await res.json()) as { client_id?: string };
  return { status: res.status, clientId: body.client_id ?? "" };
}

async function registerType(c: TestContext, id: string): Promise<void> {
  const res = await request(c.app, "POST", "/types", {
    key: c.workingKey,
    body: { id, version: 1, fields: { title: { type: "string" } } },
  });
  expect(res.status).toBe(201);
}

/** The scopes the consent screen is asked to show, or null when the request
 *  did not reach it. */
async function scopesAtConsent(
  c: TestContext,
  clientId: string,
  scope: string,
  challenge: string,
): Promise<{ scopes: string[]; query: string } | null> {
  const res = await request(
    c.app,
    "GET",
    `/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "runtime-type",
      prompt: "consent",
      scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString()}`,
    { headers: { cookie: c.owner.cookie } },
  );
  const location = res.headers.get("location") ?? "";
  if (res.status !== 302 || !location.includes("/auth/authorize?")) return null;
  const query = location.slice(location.indexOf("?") + 1);
  return {
    scopes: (new URLSearchParams(query).get("scope") ?? "").split(" "),
    query,
  };
}

async function grant(
  c: TestContext,
  clientId: string,
  scope: string,
): Promise<Record<string, unknown>> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const consent = await scopesAtConsent(c, clientId, scope, challenge);
  expect(consent?.scopes).toEqual(scope.split(" "));
  const decision = await request(c.app, "POST", "/auth/authorize/decision", {
    form: {
      accept: "true",
      oauth_query: consent?.query ?? "",
      scopes: scope.split(" "),
    },
    headers: { cookie: c.owner.cookie, origin: BASE },
  });
  expect(decision.status).toBe(302);
  const code = new URL(decision.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  const token = await request(c.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code: code ?? "",
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
    },
  });
  const body = (await token.json()) as Record<string, unknown>;
  expect(token.status, JSON.stringify(body)).toBe(200);
  return body;
}

describe("a type registered while the server runs", () => {
  it("is granted to a client registered before it and to one registered after", async () => {
    ctx = await createTestContext({ authBaseUrl: BASE }, TEST_OWNER);
    const typeId = "rtscope.recipe";
    const scope = `${typeId}:read`;
    const earlier = await registerClient(ctx);
    expect(earlier.status).toBe(201);

    // The witness: before the type exists, the scope is not grantable.
    expect(
      (
        await scopesAtConsent(
          ctx,
          earlier.clientId,
          `${scope} core.note:read`,
          "x".repeat(43),
        )
      )?.scopes,
    ).toEqual(["core.note:read"]);

    await registerType(ctx, typeId);

    // The approval screen offers it as a row of its own.
    const shown = await scopesAtConsent(
      ctx,
      earlier.clientId,
      scope,
      "x".repeat(43),
    );
    const page = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${shown?.query ?? ""}`,
      { headers: { cookie: ctx.owner.cookie } },
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`value="${scope}"`);

    const fromEarlier = await grant(ctx, earlier.clientId, scope);
    expect(fromEarlier.scope).toBe(scope);
    const read = await request(ctx.app, "GET", `/items?type=${typeId}`, {
      key: String(fromEarlier.access_token),
    });
    expect(read.status).toBe(200);

    const later = await registerClient(ctx, scope);
    expect(later.status).toBe(201);
    expect((await grant(ctx, later.clientId, scope)).scope).toBe(scope);
  });

  it("is narrowed away once deleted, and the grant already issued keeps working", async () => {
    ctx = await createTestContext({ authBaseUrl: BASE }, TEST_OWNER);
    const typeId = "rtscope.deleted";
    const scope = `${typeId}:read`;
    const client = await registerClient(ctx);
    await registerType(ctx, typeId);
    const issued = await grant(
      ctx,
      client.clientId,
      `${scope} core.note:read offline_access`,
    );
    expect(typeof issued.refresh_token).toBe("string");

    const deleted = await request(ctx.app, "DELETE", `/types/${typeId}`, {
      key: ctx.workingKey,
    });
    expect(deleted.status).toBe(200);

    expect(
      (
        await scopesAtConsent(
          ctx,
          client.clientId,
          `${scope} core.note:read`,
          "x".repeat(43),
        )
      )?.scopes,
    ).toEqual(["core.note:read"]);

    const read = await request(ctx.app, "GET", "/items?type=core.note", {
      key: String(issued.access_token),
    });
    expect(read.status).toBe(200);

    const refreshed = await request(ctx.app, "POST", "/auth/oauth2/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: String(issued.refresh_token),
        client_id: client.clientId,
      },
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
  });
});
