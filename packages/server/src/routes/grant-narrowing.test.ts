import { AsyncLocalStorage } from "node:async_hooks";
import { CredentialPersistencePhase } from "../auth/credential-adapter.js";
import { withConsentLock } from "../auth/consent-lock.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createTestContext,
  seedOauthBearer,
  request,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await cleanupTestContext(ctx);
});
const narrow = (id: string, expected: string[], scopes: string[]) =>
  ctx.ownerRequest(`/auth/grants/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scopes, expected_scopes: expected }),
  });
it("narrows the live grant and refuses widening or a stale page", async () => {
  const held = ["core.note:write", "offline_access"];
  const app = await seedOauthBearer(ctx, held);
  expect((await narrow(app.grantId, held, ["*:write"])).status).toBe(403);
  expect(
    (
      await request(ctx.app, "PATCH", `/auth/grants/${app.grantId}`, {
        key: app.token,
        body: { scopes: [], expected_scopes: held },
      })
    ).status,
  ).toBe(403);
  const scopes = ["core.note:read", "offline_access"];
  const saved = await narrow(app.grantId, held, scopes);
  expect(saved.status, await saved.clone().text()).toBe(200);
  expect(
    await ctx.storage.oauthProvider?.getPriorConsent(
      app.clientId,
      ctx.owner.id,
    ),
  ).toEqual(scopes);
  expect((await ctx.storage.items.get(app.grantId))?.properties.scopes).toEqual(
    scopes,
  );
  expect((await narrow(app.grantId, held, scopes)).status).toBe(409);
});
it("reports a web grant using the same classifier as its page", async () => {
  const app = await seedOauthBearer(ctx, ["core.note:read"], {
    webRedirectUri: "https://reader.example/callback",
  });
  const response = await ctx.ownerRequest("/auth/grants");
  const body = (await response.json()) as {
    data: { id: string; kind: string }[];
  };
  expect(body.data.find((row) => row.id === app.grantId)?.kind).toBe("web");
});

it("keeps covered tokens and refreshes, but ends tokens and refresh chains above the new ceiling", async () => {
  const held = ["core.note:write", "offline_access"];
  const wide = await seedOauthBearer(ctx, held);
  const kept = ["core.note:read", "offline_access"];
  const read = await seedOauthBearer(ctx, kept, { clientId: wide.clientId });
  const items = (token: string) =>
    request(ctx.app, "GET", "/items", { key: token });
  expect((await items(wide.token)).status).toBe(200);
  expect((await items(read.token)).status).toBe(200);
  const current = [
    ...((await ctx.storage.oauthProvider!.getPriorConsent(
      wide.clientId,
      ctx.owner.id,
    )) ?? []),
  ];
  expect((await narrow(wide.grantId, current, kept)).status).toBe(200);
  expect((await items(wide.token)).status).toBe(401);
  expect((await items(read.token)).status).toBe(200);
  const refresh = (refreshToken: string) =>
    request(ctx.app, "POST", "/auth/oauth2/token", {
      headers: { origin: new URL(ctx.config.authBaseUrl).origin },
      form: {
        client_id: wide.clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      },
    });
  expect((await refresh(wide.refreshToken!)).status).toBe(400);
  const renewed = await refresh(read.refreshToken!);
  expect(renewed.status).toBe(200);
  const body = (await renewed.json()) as { access_token: string };
  expect((await items(body.access_token)).status).toBe(200);
});

it("rolls consent, projection and token withdrawal back if the narrowing audit fails", async () => {
  const held = ["core.note:write", "offline_access"];
  const app = await seedOauthBearer(ctx, held);
  const db = ctx.storage as typeof ctx.storage & {
    __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
  };
  await db.__sqliteRun(
    "CREATE TRIGGER reject_narrow_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.grant.narrowed' BEGIN SELECT RAISE(ABORT, 'narrow fault'); END",
    [],
  );
  try {
    expect((await narrow(app.grantId, held, ["core.note:read"])).status).toBe(
      500,
    );
    expect(
      await ctx.storage.oauthProvider?.getPriorConsent(
        app.clientId,
        ctx.owner.id,
      ),
    ).toEqual(held);
    expect(
      (await ctx.storage.items.get(app.grantId))?.properties.scopes,
    ).toEqual(held);
    expect(
      (await request(ctx.app, "GET", "/items", { key: app.token })).status,
    ).toBe(200);
  } finally {
    await db.__sqliteRun("DROP TRIGGER reject_narrow_audit", []);
  }
  expect((await narrow(app.grantId, held, ["core.note:read"])).status).toBe(
    200,
  );
  expect(
    (await request(ctx.app, "GET", "/items", { key: app.token })).status,
  ).toBe(401);
});

for (const when of ["before", "inside"] as const)
  it(`keeps a racing refresh below the new ceiling when narrowing commits ${when} its transaction`, async () => {
    const held = ["core.note:write", "offline_access"];
    const app = await seedOauthBearer(ctx, held);
    const outside = AsyncLocalStorage.snapshot();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const run = CredentialPersistencePhase.prototype.run;
    let fired = false;
    let pending: Promise<Response> | undefined;
    vi.spyOn(CredentialPersistencePhase.prototype, "run").mockImplementation(
      function (this: CredentialPersistencePhase, write, work) {
        if (!write || fired) return run.call(this, write, work);
        fired = true;
        const reduce = () =>
          narrow(app.grantId, held, ["core.note:read", "offline_access"]);
        if (when === "before")
          return outside(reduce).then(() => run.call(this, write, work));
        return run.call(this, write, async () => {
          pending = outside(reduce);
          return work();
        });
      },
    );
    let response: Response;
    try {
      response = await request(ctx.app, "POST", "/auth/oauth2/token", {
        headers: { origin: new URL(ctx.config.authBaseUrl).origin },
        form: {
          client_id: app.clientId,
          grant_type: "refresh_token",
          refresh_token: app.refreshToken!,
        },
      });
      if (pending) expect((await pending).status).toBe(200);
    } finally {
      vi.restoreAllMocks();
    }
    expect(response.status).toBe(when === "before" ? 400 : 200);
    const body = (await response.json()) as { access_token?: string };
    for (const token of [app.token, body.access_token].filter(
      (s): s is string => !!s,
    ))
      expect(
        (await request(ctx.app, "GET", "/items", { key: token })).status,
      ).toBe(401);
  });

it("rereads consent after waiting behind another approval", async () => {
  const held = ["core.note:write"];
  const app = await seedOauthBearer(ctx, held);
  let release!: () => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const consent = withConsentLock(app.clientId, ctx.owner.id, async () => {
    ready();
    await blocker;
    await ctx.storage.oauthProvider!.setConsentScopes(
      app.clientId,
      ctx.owner.id,
      ["core.note:read"],
      held,
    );
  });
  await started;
  const pending = narrow(app.grantId, held, held);
  release();
  await consent;
  expect((await pending).status).toBe(409);
});
