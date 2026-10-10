/**
 * An app ended while its refresh is in flight stays ended.
 *
 * The provider reads the presented refresh token before it writes anything,
 * and the end can commit in that gap or wait for the refresh's own
 * transaction. Both orders are forced here, at the provider's first write,
 * against the owner's end door and against Disconnect, and in each the app
 * is left with no token that works.
 */
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { CredentialPersistencePhase } from "./credential-adapter.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.cleanup();
});

const CALLBACK = "http://localhost:0/callback";
const SCOPE = "core.note:read offline_access";

function origin(): string {
  return new URL(ctx.config.authBaseUrl).origin;
}

async function seedClient(): Promise<string> {
  const clientId = `client_${randomBytes(5).toString("hex")}`;
  const schema = await import("../storage/sqlite/schema.js");
  const db = ctx.storage.betterAuthDb as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const now = new Date();
  const op = db.insert(schema.auth_oauth_client).values({
    id: `pk_${randomBytes(5).toString("hex")}`,
    clientId,
    name: "racing app",
    redirectUris: JSON.stringify([CALLBACK]),
    grantTypes: JSON.stringify(["authorization_code", "refresh_token"]),
    responseTypes: JSON.stringify(["code"]),
    scopes: null,
    disabled: false,
    createdAt: now,
    updatedAt: now,
    public: true,
    tokenEndpointAuthMethod: "none",
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}

/** Approve the app as the owner and exchange its code for a token pair. */
async function connect(
  clientId: string,
): Promise<{ access: string; refresh: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "s",
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const cookie = ctx.owner.cookie;
  const authorize = await request(
    ctx.app,
    "GET",
    `/auth/oauth2/authorize?${query.toString()}`,
    { headers: { cookie } },
  );
  const location = authorize.headers.get("location") ?? "";
  const decision = await request(ctx.app, "POST", "/auth/authorize/decision", {
    form: {
      accept: "true",
      oauth_query: location.slice(location.indexOf("?") + 1),
      scopes: SCOPE.split(" "),
    },
    headers: { cookie, origin: origin() },
  });
  const code = new URL(
    decision.headers.get("location") ?? "",
    origin(),
  ).searchParams.get("code");
  expect(code, "no code").toBeTruthy();
  const token = await request(ctx.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
    },
    headers: { origin: origin() },
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as {
    access_token: string;
    refresh_token: string;
  };
  return { access: body.access_token, refresh: body.refresh_token };
}

async function grantItemId(clientId: string): Promise<string> {
  const id = await ctx.storage.oauthProvider?.findGrantItemId({
    clientId,
    authUserId: ctx.owner.id,
  });
  expect(id).toBeTruthy();
  return id!;
}

const doors = {
  "the owner's end door": (id: string) =>
    request(ctx.app, "DELETE", `/owner/sign-ins/${id}`, {
      headers: { cookie: ctx.owner.cookie, origin: origin() },
    }),
  Disconnect: (id: string) =>
    request(ctx.app, "DELETE", `/auth/grants/${id}`, {
      headers: { cookie: ctx.owner.cookie, origin: origin() },
    }),
};

/**
 * Run `end` at the refresh's first provider write: `"before"` awaits it to
 * commit before that write, `"inside"` starts it once the refresh's
 * transaction is open and lets the refresh finish first.
 */
function interleave(
  when: "before" | "inside",
  end: () => Promise<Response>,
): { ended: () => Promise<Response | undefined> } {
  const outside = AsyncLocalStorage.snapshot();
  // Kept to call the provider's own step around the forced end.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const run = CredentialPersistencePhase.prototype.run;
  let fired = false;
  let pending: Promise<Response> | undefined;
  vi.spyOn(CredentialPersistencePhase.prototype, "run").mockImplementation(
    function (this: CredentialPersistencePhase, write, work) {
      if (!write || fired) return run.call(this, write, work);
      fired = true;
      if (when === "before")
        return outside(end).then(() => run.call(this, write, work));
      return run.call(this, write, async () => {
        pending = outside(end);
        return work();
      });
    },
  );
  return { ended: async () => pending };
}

for (const [door, end] of Object.entries(doors)) {
  for (const when of ["before", "inside"] as const) {
    it(`leaves no working token when ${door} commits ${when === "before" ? "before the refresh's first write" : "while the refresh's transaction is open"}`, async () => {
      const clientId = await seedClient();
      const tokens = await connect(clientId);
      const id = await grantItemId(clientId);
      // The witness: the app's access works before the race.
      expect(
        (await request(ctx.app, "GET", "/items", { key: tokens.access }))
          .status,
      ).toBe(200);

      const race = interleave(when, () => end(id));
      const refreshed = await request(ctx.app, "POST", "/auth/oauth2/token", {
        form: {
          grant_type: "refresh_token",
          refresh_token: tokens.refresh,
          client_id: clientId,
        },
        headers: { origin: origin() },
      });
      const endAnswer = await race.ended();
      vi.restoreAllMocks();
      // The order was the one forced: an end that committed first leaves the
      // refresh token gone, and one that waited lets the refresh answer.
      if (when === "before") {
        expect(refreshed.status).toBe(400);
      } else {
        expect(refreshed.status).toBe(200);
        expect(endAnswer, "the end never started").toBeDefined();
        expect([200, 204]).toContain(endAnswer!.status);
      }

      const body = (await refreshed.json()) as {
        access_token?: string;
        refresh_token?: string;
        error?: string;
      };
      for (const access of [tokens.access, body.access_token]) {
        if (!access) continue;
        expect(
          (await request(ctx.app, "GET", "/items", { key: access })).status,
          `${when}: refresh answered ${String(refreshed.status)}`,
        ).toBe(401);
      }
      if (body.refresh_token) {
        const again = await request(ctx.app, "POST", "/auth/oauth2/token", {
          form: {
            grant_type: "refresh_token",
            refresh_token: body.refresh_token,
            client_id: clientId,
          },
          headers: { origin: origin() },
        });
        expect(again.status).toBe(400);
      }
      const live = await ctx.storage.oauthProvider?.getPriorConsent(
        clientId,
        ctx.owner.id,
      );
      expect(live).toBeUndefined();
    });
  }
}
