/**
 * Every state-changing door Marfa serves under `/auth` refuses a request from
 * another origin, or is named here as one no browser cookie reaches.
 *
 * **A census, because the guard is one middleware registered per door.** A
 * door added under `/auth` without it reads as finished from every angle a
 * test of that door alone can see. So the doors are read out of the app's own
 * route table and each has to be classified, and every guarded door is then
 * driven from a foreign origin, which is what the classification alone cannot
 * prove.
 */
import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";
import { BROWSER_FORM_DOORS } from "./_cross-origin.js";

vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const FOREIGN = "https://foreign.example";

/** Doors no browser cookie reaches, each with why. */
const BEARER_ONLY: Record<string, string> = {
  "DELETE /auth/grants/:id":
    "takes a bearer credential with grants.manage; the credential middleware reads no cookie",
};

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Marfa's own state-changing doors under `/auth`. The catch-all is Better
 *  Auth's, which checks the origin of what it serves itself, and the plugin
 *  fence answers `ALL` with a 404. */
function marfaAuthDoors(c: TestContext): string[] {
  return [
    ...new Set(
      c.app.routes
        .filter((r) => r.path.startsWith("/auth/") && r.path !== "/auth/*")
        .filter((r) => STATE_CHANGING.has(r.method))
        .map((r) => `${r.method} ${r.path}`),
    ),
  ].sort();
}

async function signIn(c: TestContext): Promise<string> {
  const { email, password } = c.owner;
  const res = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  expect(res.status).toBe(200);
  const match = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    res.headers.get("set-cookie") ?? "",
  );
  if (!match?.[1]) throw new Error("sign-in set no session cookie");
  return match[1];
}

describe("the cross-origin guard on Marfa's /auth doors", () => {
  it("classifies every state-changing door Marfa serves under /auth", async () => {
    ctx = await createTestContext();
    const doors = marfaAuthDoors(ctx);
    expect(doors.length).toBeGreaterThan(3);
    expect(doors).toEqual(
      [...BROWSER_FORM_DOORS, ...Object.keys(BEARER_ONLY)].sort(),
    );
  });

  for (const door of BROWSER_FORM_DOORS) {
    const [method, path] = door.split(" ") as [string, string];

    it(`${door} refuses a foreign Origin, and a foreign Referer when Origin is absent`, async () => {
      ctx = await createTestContext();
      const cookie = await signIn(ctx);
      const foreign: Record<string, string>[] = [
        { origin: FOREIGN },
        { referer: `${FOREIGN}/page` },
      ];
      for (const headers of foreign) {
        const res = await request(ctx.app, method, path, {
          form: { user_code: "ABCD2345", decision: "approve" },
          headers: { ...headers, cookie },
        });
        expect(res.status).toBe(403);
        expect(
          ((await res.json()) as { error: { code: string } }).error.code,
        ).toBe("forbidden");
      }
      // The witness: the same request from this origin is not refused by
      // the guard, whatever the door then makes of it.
      const same = await request(ctx.app, method, path, {
        form: { user_code: "ABCD2345", decision: "approve" },
        headers: { origin: ORIGIN, cookie },
      });
      expect(same.status).not.toBe(403);
    });
  }

  it("leaves a device code pending when the approval comes from a foreign origin", async () => {
    ctx = await createTestContext();
    const c = ctx;
    const registered = await request(c.app, "POST", "/auth/oauth2/register", {
      body: {
        client_name: "Guard Test Device",
        application_type: "native",
        grant_types: [DEVICE_CODE_GRANT_TYPE],
        token_endpoint_auth_method: "none",
        redirect_uris: [`${ORIGIN}/callback`],
        response_types: [],
      },
      headers: { origin: ORIGIN },
    });
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    const init = await request(c.app, "POST", "/auth/device/code", {
      form: { client_id, scope: "core.note:read" },
      headers: { origin: ORIGIN },
    });
    const { user_code } = (await init.json()) as { user_code: string };
    const cookie = await signIn(c);
    // Opening the consent screen claims the code for the signed-in person,
    // which is what a foreign page would be riding on.
    const screen = await request(
      c.app,
      "GET",
      `/auth/device/consent?user_code=${user_code}`,
      { headers: { cookie } },
    );
    expect(screen.status).toBe(200);

    const forged = await request(c.app, "POST", "/auth/device/consent", {
      form: { user_code, decision: "approve", scopes: ["core.note:read"] },
      headers: { origin: FOREIGN, cookie },
    });
    expect(forged.status).toBe(403);
    const grantsAfterForgery = await c.storage.items.list({
      type: "system.connection",
    });
    expect(grantsAfterForgery.data).toHaveLength(0);

    const approved = await request(c.app, "POST", "/auth/device/consent", {
      form: { user_code, decision: "approve", scopes: ["core.note:read"] },
      headers: { origin: ORIGIN, cookie },
    });
    expect(approved.status).toBe(200);
    const grants = await c.storage.items.list({ type: "system.connection" });
    expect(grants.data).toHaveLength(1);
  });
});
