import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaimTestApp } from "../auth/claim-test-app.js";
import {
  issueSetupCode,
  issueSetupTicket,
  recoverOwnerPassword,
  requireOwnerSession,
} from "../auth/instance-claim.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(origin = "http://localhost:8600") {
  const ctx = await createClaimTestApp(origin);
  cleanups.push(ctx.cleanup);
  return ctx;
}
const details = {
  email: "owner@example.com",
  password: "correct horse battery",
};
const origin = "http://localhost:8600";
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("owner and setup routes", () => {
  it("claims through terminal JSON and refuses unauthenticated owner reads", async () => {
    const { app, storage } = await fixture();
    const { code } = await issueSetupCode(storage);
    expect((await app.request("/owner")).status).toBe(401);
    const claimed = await app.request("/owner", json({ ...details, code }));
    expect(claimed.status).toBe(201);
    const login = await app.request(
      `${origin}/auth/sign-in/email`,
      json(details, { origin }),
    );
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect((await app.request("/owner", { headers: { cookie } })).status).toBe(
      200,
    );
    expect(
      (
        await app.request("/owner", {
          headers: { cookie, authorization: "Bearer app-token" },
        })
      ).status,
    ).toBe(401);
  });
  it("spends handoff, protects cookie, keeps refresh usable, and refuses cross-origin requests", async () => {
    const { app, storage } = await fixture();
    await issueSetupCode(storage);
    const { ticket } = await issueSetupTicket(storage);
    expect(
      (
        await app.request(
          "/setup/exchange",
          json({ ticket }, { origin: "https://elsewhere.example" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await app.request("/setup/exchange", json({ ticket }))).status,
    ).toBe(403);
    const exchange = await app.request(
      "/setup/exchange",
      json({ ticket }, { origin }),
    );
    expect(exchange.status).toBe(200);
    const setCookie = exchange.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";")[0]!;
    const page = await app.request("/setup", { headers: { cookie } });
    expect(page.headers.get("cache-control")).toContain("no-store");
    expect(await page.text()).toContain('<form id="owner-form">');
    expect(
      (await app.request("/setup/exchange", json({ ticket }, { origin })))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request(
          "/owner",
          json(details, { cookie, origin: "https://elsewhere.example" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await app.request("/owner", json(details, { cookie, origin }))).status,
    ).toBe(201);
  });
  it("refuses insecure public transport and never logs submitted secrets", async () => {
    const unsafe = await fixture("http://public.example");
    const { code } = await issueSetupCode(unsafe.storage);
    expect(
      (await unsafe.app.request("/owner", json({ ...details, code }))).status,
    ).toBe(403);
    const { app, storage } = await fixture();
    const issued = await issueSetupCode(storage);
    const { ticket } = await issueSetupTicket(storage);
    const logs = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await app.request("/setup/exchange", json({ ticket }, { origin }));
    await app.request("/owner", json({ ...details, code: issued.code }));
    const lines = JSON.stringify(logs.mock.calls);
    expect(lines).toContain("/owner");
    expect(lines).not.toContain(issued.code);
    expect(lines).not.toContain(ticket);
    expect(lines).not.toContain(details.password);
  });
  it("forces other browser sessions to end even when the provider flag is false", async () => {
    const { app, storage, auth } = await fixture();
    const { code } = await issueSetupCode(storage);
    await app.request("/owner", json({ ...details, code }));
    async function signIn() {
      const response = await app.request(
        `${origin}/auth/sign-in/email`,
        json(details, { origin }),
      );
      expect(response.status).toBe(200);
      return response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    }
    const first = await signIn(),
      second = await signIn();
    expect(
      await auth.getSession(new Headers({ cookie: second })),
    ).not.toBeNull();
    const changed = await app.request(
      `${origin}/auth/change-password`,
      json(
        {
          currentPassword: details.password,
          newPassword: "replacement password",
          revokeOtherSessions: false,
        },
        { origin, cookie: first },
      ),
    );
    expect(changed.status).toBe(200);
    expect(
      await auth.getSession(new Headers({ cookie: first }), { readOnly: true }),
    ).not.toBeNull();
    expect(
      await auth.getSession(new Headers({ cookie: second }), {
        readOnly: true,
      }),
    ).toBeNull();
    await recoverOwnerPassword(storage, auth, {
      password: "recovery password",
    });
    expect(
      await auth.getSession(new Headers({ cookie: first }), { readOnly: true }),
    ).toBeNull();
  });
  it("bases recent authentication on creation, and read-only lookup never cleans expired rows", async () => {
    const { app, storage, auth } = await fixture();
    const { code } = await issueSetupCode(storage);
    await app.request("/owner", json({ ...details, code }));
    const login = await app.request(
      `${origin}/auth/sign-in/email`,
      json(details, { origin }),
    );
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const headers = new Headers({ cookie });
    await requireOwnerSession(storage, auth, headers, { recent: true });
    await storage.__sqliteRun(
      "UPDATE auth_session SET created_at = created_at - 301",
      [],
    );
    await expect(
      requireOwnerSession(storage, auth, headers, { recent: true }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await storage.__sqliteRun("UPDATE auth_session SET expires_at = 1", []);
    const audit = vi
      .spyOn(storage.audit, "log")
      .mockRejectedValue(new Error("write unavailable"));
    expect(await auth.getSession(headers, { readOnly: true })).toBeNull();
    expect(audit).not.toHaveBeenCalled();
    expect(
      await storage.__sqliteAll("SELECT id FROM auth_session"),
    ).toHaveLength(1);
  });
  it("refuses mixed browser credentials and requires recent session administration", async () => {
    const { app, storage } = await fixture();
    const { code } = await issueSetupCode(storage);
    await app.request("/owner", json({ ...details, code }));
    const login = await app.request(
      `${origin}/auth/sign-in/email`,
      json(details, { origin }),
    );
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(
      (
        await app.request(`${origin}/auth/list-sessions`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
    for (const path of [
      "/auth/list-sessions",
      "/auth/get-session",
      "/auth/oauth2/authorize?prompt=none",
    ]) {
      expect(
        (
          await app.request(`${origin}${path}`, {
            headers: { cookie, authorization: "Bearer application-token" },
          })
        ).status,
      ).toBe(403);
    }
    await storage.__sqliteRun(
      "UPDATE auth_session SET created_at = created_at - 301",
      [],
    );
    expect(
      (
        await app.request(`${origin}/auth/list-sessions`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          `${origin}/auth/revoke-sessions`,
          json({}, { cookie, origin }),
        )
      ).status,
    ).toBe(401);
    const page = await app.request(
      `${origin}/auth/sign-in?prompt=login&return_to=/auth/owner/restore`,
      { headers: { cookie } },
    );
    expect(await page.text()).toContain('type="password"');
    // An old session can still end itself.
    expect(
      (
        await app.request(
          `${origin}/auth/sign-out`,
          json({}, { cookie, origin }),
        )
      ).status,
    ).toBe(200);
  });
});
