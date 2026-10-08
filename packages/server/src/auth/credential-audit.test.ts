import { CredentialPersistencePhase } from "./credential-adapter.js";
import { afterEach, expect, it } from "vitest";
import { request } from "../test-utils.js";
import { createClaimTestApp } from "./claim-test-app.js";
type TestContext = Awaited<ReturnType<typeof createClaimTestApp>>;
const contexts: TestContext[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.cleanup();
});
async function fixture() {
  const ctx = await createClaimTestApp("http://localhost:0");
  contexts.push(ctx);
  return ctx;
}
function native(ctx: TestContext) {
  return ctx.storage;
}
const body = { email: "owner@example.test", password: "correct horse battery" };
it("rolls owner and account back on a native owner audit failure, then accepts a retry", async () => {
  const ctx = await fixture();
  const db = native(ctx);
  await db.__sqliteRun(
    "CREATE TRIGGER refuse_owner_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'owner.claimed' BEGIN SELECT RAISE(ABORT, 'audit fault'); END",
    [],
  );
  expect(
    (
      await request(ctx.app, "POST", "/owner", {
        body: { ...body, code: ctx.setupCode },
      })
    ).status,
  ).toBe(500);
  expect(await db.__sqliteAll("SELECT id FROM auth_user")).toHaveLength(0);
  expect(await db.__sqliteAll("SELECT id FROM auth_account")).toHaveLength(0);
  await db.__sqliteRun("DROP TRIGGER refuse_owner_audit", []);
  expect(
    (
      await request(ctx.app, "POST", "/owner", {
        body: { ...body, code: ctx.setupCode },
      })
    ).status,
  ).toBe(201);
  expect(await db.__sqliteAll("SELECT id FROM auth_user")).toHaveLength(1);
  expect(await db.__sqliteAll("SELECT id FROM auth_account")).toHaveLength(1);
  expect(
    (await ctx.storage.audit.list({ action: "owner.claimed" })).data,
  ).toHaveLength(1);
});
it("returns no cookie and stores no session if the accepted sign-in audit fails", async () => {
  const ctx = await fixture();
  const db = native(ctx);
  expect(
    (
      await request(ctx.app, "POST", "/owner", {
        body: { ...body, code: ctx.setupCode },
      })
    ).status,
  ).toBe(201);
  const signin = () =>
    request(ctx.app, "POST", "/auth/sign-in/email", {
      body,
      headers: { origin: "http://localhost:0" },
    });
  await db.__sqliteRun(
    "CREATE TRIGGER refuse_session_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'auth.sign_in.success' BEGIN SELECT RAISE(ABORT, 'audit fault'); END",
    [],
  );
  const refused = await signin();
  expect(refused.ok).toBe(false);
  expect(refused.headers.get("set-cookie")).toBeNull();
  expect(await db.__sqliteAll("SELECT id FROM auth_session")).toHaveLength(0);
  await db.__sqliteRun("DROP TRIGGER refuse_session_audit", []);
  const accepted = await signin();
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("set-cookie")).not.toBeNull();
  expect(await db.__sqliteAll("SELECT id FROM auth_session")).toHaveLength(1);
  expect(
    (await ctx.storage.audit.list({ action: "auth.sign_in.success" })).data,
  ).toHaveLength(1);
});

it("awaits owned persistence work and refuses retained operations after commit", async () => {
  const ctx = await fixture();
  const phase = new CredentialPersistencePhase(ctx.storage);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = phase.run(true, async () => {
    await gate;
    await ctx.storage.settings.set("credential.phase", "committed");
  });
  let finished = false;
  const response = phase.finish(new Response("accepted")).then((result) => {
    finished = true;
    return result;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  release();
  await write;
  expect((await response).status).toBe(200);
  expect(await ctx.storage.settings.get("credential.phase")).toBe("committed");
  await expect(
    phase.run(true, () =>
      ctx.storage.settings.set("credential.phase", "escaped"),
    ),
  ).rejects.toThrow("closed");
  expect(await ctx.storage.settings.get("credential.phase")).toBe("committed");
});
it("rolls the entire persistence tail back even when its caller catches an adapter failure", async () => {
  const ctx = await fixture();
  await native(ctx).__sqliteRun(
    "CREATE TRIGGER reject_phase_audit BEFORE INSERT ON audit_log WHEN NEW.action='test.phase' BEGIN SELECT RAISE(ABORT, 'provider caught native failure'); END",
    [],
  );
  const phase = new CredentialPersistencePhase(ctx.storage);
  await phase.run(true, () =>
    ctx.storage.settings.set("credential.poison", "pending"),
  );
  await phase
    .run(true, async () => {
      await ctx.storage.audit.log({
        action: "test.phase",
        resource_type: "test",
      });
    })
    .catch(() => undefined);
  await expect(phase.finish(new Response("pretended success"))).rejects.toThrow(
    "Failed query",
  );
  expect(await ctx.storage.settings.get("credential.poison")).toBeNull();
  const control = new CredentialPersistencePhase(ctx.storage);
  await control.run(true, () =>
    ctx.storage.settings.set("credential.poison", "control"),
  );
  expect((await control.finish(new Response("accepted"))).status).toBe(200);
  expect(await ctx.storage.settings.get("credential.poison")).toBe("control");
});

it("audits provider-only dynamic registration at its actual persistence boundary", async () => {
  const ctx = await fixture();
  const db = native(ctx);
  const register = () =>
    request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        client_name: "Audit Client",
        application_type: "native",
        redirect_uris: ["http://localhost:0/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "core.note:read",
      },
      headers: { origin: "http://localhost:0" },
    });
  await db.__sqliteRun(
    "CREATE TRIGGER reject_registration_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.oauthClient.create' BEGIN SELECT RAISE(ABORT, 'registration audit fault'); END",
    [],
  );
  expect((await register()).status).toBe(500);
  expect(await db.__sqliteAll("SELECT id FROM auth_oauth_client")).toHaveLength(
    0,
  );
  await db.__sqliteRun("DROP TRIGGER reject_registration_audit", []);
  const accepted = await register();
  expect(accepted.status).toBe(201);
  expect(((await accepted.json()) as { scope: string }).scope).toBe(
    "core.note:read",
  );
  expect(await db.__sqliteAll("SELECT scopes FROM auth_oauth_client")).toEqual([
    { scopes: '["core.note:read"]' },
  ]);
  expect(
    (await ctx.storage.audit.list({ action: "auth.oauthClient.create" })).data,
  ).toHaveLength(1);
});
it("keeps a cached session usable if provider sign-out audit fails, then invalidates it on commit", async () => {
  const ctx = await fixture();
  const db = native(ctx);
  expect(
    (
      await request(ctx.app, "POST", "/owner", {
        body: { ...body, code: ctx.setupCode },
      })
    ).status,
  ).toBe(201);
  const signed = await request(ctx.app, "POST", "/auth/sign-in/email", {
    body,
    headers: { origin: "http://localhost:0" },
  });
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = () =>
    request(ctx.app, "GET", "/auth/get-session", { headers: { cookie } });
  expect(await (await session()).json()).not.toBeNull();
  const out = () =>
    request(ctx.app, "POST", "/auth/sign-out", {
      body: {},
      headers: { cookie, origin: "http://localhost:0" },
    });
  await db.__sqliteRun(
    "CREATE TRIGGER reject_logout_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.session.delete' BEGIN SELECT RAISE(ABORT, 'logout audit fault'); END",
    [],
  );
  expect((await out()).status).toBe(500);
  expect(await (await session()).json()).not.toBeNull();
  await db.__sqliteRun("DROP TRIGGER reject_logout_audit", []);
  expect((await out()).status).toBe(200);
  expect(await (await session()).json()).toBeNull();
});

it("rolls password replacement and session turnover back when their final audit fails", async () => {
  const ctx = await fixture();
  const db = native(ctx);
  expect(
    (
      await request(ctx.app, "POST", "/owner", {
        body: { ...body, code: ctx.setupCode },
      })
    ).status,
  ).toBe(201);
  const signed = await request(ctx.app, "POST", "/auth/sign-in/email", {
    body,
    headers: { origin: "http://localhost:0" },
  });
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  await request(ctx.app, "POST", "/auth/sign-in/email", {
    body,
    headers: { origin: "http://localhost:0" },
  });
  const sessions = await db.__sqliteAll("SELECT id FROM auth_session");
  const accounts = await db.__sqliteAll(
    "SELECT id, password FROM auth_account",
  );
  await db.__sqliteRun(
    "CREATE TRIGGER reject_password_audit BEFORE INSERT ON audit_log WHEN NEW.action='owner.password.changed' BEGIN SELECT RAISE(ABORT, 'password audit fault'); END",
    [],
  );
  const change = () =>
    request(ctx.app, "POST", "/auth/change-password", {
      body: {
        currentPassword: body.password,
        newPassword: "a different correct password",
        revokeOtherSessions: true,
      },
      headers: { cookie, origin: "http://localhost:0" },
    });
  const refused = await change();
  expect(refused.status).toBe(500);
  expect(refused.headers.getSetCookie()).toEqual([]);
  expect(await db.__sqliteAll("SELECT id FROM auth_session")).toEqual(sessions);
  expect(await db.__sqliteAll("SELECT id, password FROM auth_account")).toEqual(
    accounts,
  );
  expect(
    await (
      await request(ctx.app, "GET", "/auth/get-session", {
        headers: { cookie },
      })
    ).json(),
  ).not.toBeNull();
  await db.__sqliteRun("DROP TRIGGER reject_password_audit", []);
  const accepted = await change();
  expect(accepted.status).toBe(200);
  expect(accepted.headers.getSetCookie()).toEqual([]);
  expect(await db.__sqliteAll("SELECT id FROM auth_session")).not.toEqual(
    sessions,
  );
  expect(
    await (
      await request(ctx.app, "GET", "/auth/get-session", {
        headers: { cookie },
      })
    ).json(),
  ).not.toBeNull();
  expect(
    (
      await request(ctx.app, "POST", "/auth/sign-in/email", {
        body,
        headers: { origin: "http://localhost:0" },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request(ctx.app, "POST", "/auth/sign-in/email", {
        body: { ...body, password: "a different correct password" },
        headers: { origin: "http://localhost:0" },
      })
    ).status,
  ).toBe(200);
  expect(
    (await ctx.storage.audit.list({ action: "owner.password.changed" })).data,
  ).toHaveLength(1);
});

it("couples provider profile updates and signing-key creation to their native audits", async () => {
  const ctx = await fixture();
  const db = native(ctx);
  expect(
    (
      await request(ctx.app, "POST", "/owner", {
        body: { ...body, code: ctx.setupCode },
      })
    ).status,
  ).toBe(201);
  const signed = await request(ctx.app, "POST", "/auth/sign-in/email", {
    body,
    headers: { origin: "http://localhost:0" },
  });
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const before = await db.__sqliteAll("SELECT id, name FROM auth_user");
  await db.__sqliteRun(
    "CREATE TRIGGER reject_profile_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.user.update' BEGIN SELECT RAISE(ABORT, 'profile audit fault'); END",
    [],
  );
  const update = () =>
    request(ctx.app, "POST", "/auth/update-user", {
      body: { name: "Changed Owner" },
      headers: { cookie, origin: "http://localhost:0" },
    });
  const refused = await update();
  expect(refused.status).toBe(500);
  expect(refused.headers.getSetCookie()).toEqual([]);
  expect(await db.__sqliteAll("SELECT id, name FROM auth_user")).toEqual(
    before,
  );
  await db.__sqliteRun("DROP TRIGGER reject_profile_audit", []);
  expect((await update()).status).toBe(200);
  expect(await db.__sqliteAll("SELECT name FROM auth_user")).toEqual([
    { name: "Changed Owner" },
  ]);
  await db.__sqliteRun(
    "CREATE TRIGGER reject_jwks_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.jwks.create' BEGIN SELECT RAISE(ABORT, 'jwks audit fault'); END",
    [],
  );
  expect((await request(ctx.app, "GET", "/auth/jwks")).status).toBe(500);
  expect(await db.__sqliteAll("SELECT id FROM auth_jwks")).toHaveLength(0);
  await db.__sqliteRun("DROP TRIGGER reject_jwks_audit", []);
  expect((await request(ctx.app, "GET", "/auth/jwks")).status).toBe(200);
  expect(await db.__sqliteAll("SELECT id FROM auth_jwks")).toHaveLength(1);
  expect(
    (await ctx.storage.audit.list({ action: "auth.jwks.create" })).data,
  ).toHaveLength(1);
});

it.each(["revoke-session", "revoke-sessions", "revoke-other-sessions"])(
  "keeps %s atomic when a native session audit fails",
  async (door) => {
    const ctx = await fixture();
    const db = native(ctx);
    expect(
      (
        await request(ctx.app, "POST", "/owner", {
          body: { ...body, code: ctx.setupCode },
        })
      ).status,
    ).toBe(201);
    const signin = () =>
      request(ctx.app, "POST", "/auth/sign-in/email", {
        body,
        headers: { origin: "http://localhost:0" },
      });
    const signed = await signin();
    await signin();
    await signin();
    const cookie = signed.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const sessions = (await db.__sqliteAll(
      "SELECT id, token FROM auth_session",
    )) as { id: string; token: string }[];
    const action = `auth.session.${door === "revoke-sessions" ? "deleteMany" : "delete"}`;
    await db.__sqliteRun(
      `CREATE TRIGGER reject_session_door BEFORE INSERT ON audit_log WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT, 'session door audit fault'); END`,
      [],
    );
    const submit = () =>
      request(ctx.app, "POST", `/auth/${door}`, {
        body: { token: sessions[1]!.token },
        headers: { cookie, origin: "http://localhost:0" },
      });
    const refused = await submit();
    expect(refused.status).toBe(500);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(await db.__sqliteAll("SELECT id, token FROM auth_session")).toEqual(
      sessions,
    );
    await db.__sqliteRun("DROP TRIGGER reject_session_door", []);
    expect((await submit()).status).toBe(200);
    expect(await db.__sqliteAll("SELECT id FROM auth_session")).toHaveLength(
      door === "revoke-sessions" ? 0 : door === "revoke-other-sessions" ? 1 : 2,
    );
  },
);

it("requires a durable failed-sign-in observation without creating a session", async () => {
  const ctx = await fixture();
  const db = native(ctx);
  const signin = () =>
    request(ctx.app, "POST", "/auth/sign-in/email", {
      body,
      headers: { origin: "http://localhost:0" },
    });
  await db.__sqliteRun(
    "CREATE TRIGGER reject_failed_signin BEFORE INSERT ON audit_log WHEN NEW.action='auth.sign_in.failed' BEGIN SELECT RAISE(ABORT, 'failed sign-in audit fault'); END",
    [],
  );
  const failed = await signin();
  expect(failed.status).toBe(500);
  expect(failed.headers.getSetCookie()).toEqual([]);
  expect(await db.__sqliteAll("SELECT id FROM auth_session")).toEqual([]);
  await db.__sqliteRun("DROP TRIGGER reject_failed_signin", []);
  expect((await signin()).status).toBe(401);
  expect(
    (await ctx.storage.audit.list({ action: "auth.sign_in.failed" })).data,
  ).toHaveLength(1);
});
