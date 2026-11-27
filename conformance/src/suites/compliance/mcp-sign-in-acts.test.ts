import { postSignInForm, signInOutcome } from "../../client/owner-session.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { MarfaClient } from "../../client/api.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  refreshedAppToken,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { testAuthenticator } from "../../utils/passkey-authenticator.js";
import {
  approveAsDrawn,
  authorize,
  authorizeQuery,
  CALLBACK,
  codeFor,
  connect,
  pkce,
  registerApp,
  sentTo,
  token,
} from "../../utils/signed-in.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * `marfa_end_sign_in` on a server of its own, so the clock and a write's
 * faults can be scripted. The server signs in at localhost, the name a
 * browser accepts for a passkey.
 */
const CONFIRMATION_LIFE_MS = 5 * 60 * 1000;
const END = "marfa_end_sign_in";
const ACTIONS = {
  browser: "auth.sign_in.ended",
  app: "auth.grant.revoked",
  passkey: "owner.passkey.removed",
};

let server: FreshServer;
let home: URL;
let ownerCookie: string;
let admin: McpConnection;
let otherAdmin: McpConnection;
let grantsOnly: McpConnection;

async function mint(
  label: string,
  permissions: string[],
): Promise<{ id: string; key: string }> {
  const minted = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: {
      label: `mcp-sign-in-${label}`,
      source: `mcp-sign-in-${label}`,
      type_permissions: {},
      permissions,
    },
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return minted.body as unknown as { id: string; key: string };
}

async function adminConnection(
  label: string,
  permissions = ["sign_ins.manage"],
): Promise<McpConnection> {
  const { key } = await mint(label, permissions);
  return connectMcp(server.apiUrl, key, "2026-07-28", "/mcp/admin");
}

const cookieOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");

async function signedIn(): Promise<Response> {
  return postSignInForm(home.origin, home.origin, TEST_OWNER);
}

beforeAll(async () => {
  server = await bootFreshServer("mcp-sign-in-acts");
  home = new URL(server.apiUrl);
  home.hostname = "localhost";
  const moved = await controlRequest(server.controlSocket, "/config", {
    method: "PATCH",
    body: {
      sign_in_address: home.origin,
      confirm_sign_in_address_change: true,
    },
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  const signIn = await signedIn();
  expect(signInOutcome(signIn)).toBe("signed_in");
  ownerCookie = cookieOf(signIn);
  admin = await adminConnection("admin");
  otherAdmin = await adminConnection("other-admin");
  grantsOnly = await adminConnection("grants-only", ["grants.manage"]);
}, FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await admin?.close();
  await otherAdmin?.close();
  await grantsOnly?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function manager(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}

async function api(
  method: string,
  path: string,
  credential = server.managementKey,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const answer = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${credential}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await answer.text();
  return {
    status: answer.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

interface SignInRow {
  id: string;
  kind: string;
  name: string;
}

async function signIns(): Promise<SignInRow[]> {
  const listed = toolResult(await callTool(admin, "marfa_sign_ins", {}));
  return listed.sign_ins as SignInRow[];
}

async function passkeyIds(): Promise<string[]> {
  const listed = toolResult(await callTool(admin, "marfa_sign_ins", {}));
  return (listed.passkeys as { id: string }[]).map((row) => row.id);
}

/** A browser sign-in of its own, with its cookie and its ID. */
async function browser(): Promise<{ id: string; cookie: string }> {
  const before = new Set((await signIns()).map((row) => row.id));
  const answer = await signedIn();
  expect(signInOutcome(answer)).toBe("signed_in");
  const made = (await signIns()).filter(
    (row) => row.kind === "browser" && !before.has(row.id),
  );
  expect(made).toHaveLength(1);
  return { id: made[0]!.id, cookie: cookieOf(answer) };
}

/** Whether a browser's cookie still signs it in. */
async function browserLive(cookie: string): Promise<boolean> {
  const answer = await fetch(`${home.origin}/owner/passkeys`, {
    headers: { Cookie: cookie, Origin: home.origin },
  });
  expect([200, 401], await answer.clone().text()).toContain(answer.status);
  return answer.status === 200;
}

interface App {
  token: string;
  clientId: string;
  refreshToken?: string;
  grantId: string;
}

/** What each app here is approved for: enough to make webhooks and keys, and to end apps. */
const APP_SCOPE =
  "core.note:read grants.manage webhooks.manage keys.mint offline_access";

/** An app approved through the code flow by the owner's browser. */
async function app(): Promise<App> {
  const registered = await registerApp(server, APP_SCOPE);
  const tokens = await connect(
    server,
    home.origin,
    ownerCookie,
    registered,
    APP_SCOPE,
  );
  expect(tokens.access_token).toBeDefined();
  const grants = await api("GET", "/grants");
  expect(grants.status).toBe(200);
  const grant = (grants.body.data as { id: string; client_id: string }[]).find(
    (row) => row.client_id === registered.clientId,
  );
  expect(grant).toBeDefined();
  return {
    token: tokens.access_token!,
    clientId: registered.clientId,
    refreshToken: tokens.refresh_token,
    grantId: grant!.id,
  };
}

async function appLive(token: string): Promise<boolean> {
  const answer = await api("GET", "/items?limit=1", token);
  expect([200, 401]).toContain(answer.status);
  return answer.status === 200;
}

async function webhook(owner: App, url = "https://hooks.example.com/in") {
  const made = await new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: owner.token,
  }).createWebhook({ url, events: ["item.created"] });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data;
}

/** Every webhook on the instance, as the private socket lists them. */
async function webhookIds(): Promise<string[]> {
  const listed = await controlRequest(server.controlSocket, "/webhooks", {
    method: "GET",
  });
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return (listed.body.data as { id: string }[]).map((row) => row.id);
}

function asApp(owner: App): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: owner.token });
}

async function appKey(
  owner: App,
  label = `app-key-${randomUUID()}`,
): Promise<{ id: string; key: string }> {
  const minted = await new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: owner.token,
  }).createKey({ label, source: `app-made-${randomUUID()}` });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return minted.data;
}

async function keyLive(key: string): Promise<boolean> {
  const answer = await api("GET", "/keys/current", key);
  expect([200, 401]).toContain(answer.status);
  return answer.status === 200;
}

interface Passkey {
  id: string;
  device: ReturnType<typeof testAuthenticator>;
  uses: number;
}

async function passkey(name: string): Promise<Passkey> {
  const origin = home.origin;
  const asked = await fetch(`${origin}/auth/passkeys/registration/options`, {
    method: "POST",
    headers: { Origin: origin, Cookie: ownerCookie },
  });
  expect(asked.status, await asked.clone().text()).toBe(200);
  const { challenge } = (await asked.json()) as { challenge: string };
  const cookies = [ownerCookie, cookieOf(asked)].join("; ");
  const device = testAuthenticator();
  const registered = await fetch(`${origin}/auth/passkeys/registration`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookies,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      response: device.registration(challenge, origin, home.hostname),
    }),
  });
  expect(registered.status, await registered.clone().text()).toBe(201);
  const { id } = (await registered.json()) as { id: string };
  return { id, device, uses: 0 };
}

/** Signs the owner in with the passkey, which rewrites its credential and last use. */
async function usePasskey(key: Passkey): Promise<void> {
  const origin = home.origin;
  const asked = await fetch(`${origin}/auth/passkeys/sign-in/options`, {
    method: "POST",
    headers: { Origin: origin },
  });
  expect(asked.status).toBe(200);
  const { challenge } = (await asked.json()) as { challenge: string };
  key.uses += 1;
  const answer = await fetch(`${origin}/auth/passkeys/sign-in`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookieOf(asked),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      response: key.device.authentication(
        challenge,
        origin,
        key.uses,
        home.hostname,
      ),
    }),
  });
  expect(answer.status, await answer.clone().text()).toBe(200);
}

async function preview(
  args: Record<string, unknown>,
  connection = admin,
): Promise<Record<string, unknown>> {
  return toolResult(await callTool(connection, END, args));
}

async function stale(
  args: Record<string, unknown>,
  connection = admin,
): Promise<Record<string, unknown>> {
  const refused = toolError(await callTool(connection, END, args));
  expect(refused.code).toBe("confirmation_stale");
  return refused;
}

describe("marfa_end_sign_in ends a browser sign-in", () => {
  it("ends nothing when called without a confirmation, and previews the browser", async () => {
    const signed = await browser();
    const shown = await preview({ id: signed.id });
    expect(shown.kind).toBe("browser");
    expect(shown.sign_in).toMatchObject({ id: signed.id, kind: "browser" });
    expect(typeof shown.confirm).toBe("string");
    expect(await browserLive(signed.cookie)).toBe(true);
  });

  it("ends the browser sign-in with the confirmation the preview gave", async () => {
    const signed = await browser();
    const shown = await preview({ id: signed.id });
    const done = await preview({ id: signed.id, confirm: shown.confirm });
    expect(done).toMatchObject({ ended: true, kind: "browser" });
    expect(done.already_done).toBeUndefined();
    expect(await browserLive(signed.cookie)).toBe(false);
    expect((await signIns()).map((row) => row.id)).not.toContain(signed.id);
  });

  it("refuses revoke_keys for a browser sign-in or a passkey, and ends nothing", async () => {
    const signed = await browser();
    const key = await passkey("revoke-keys");
    for (const args of [
      { id: signed.id, revoke_keys: true },
      { kind: "passkey", id: key.id, revoke_keys: true },
    ]) {
      const refused = toolError(await callTool(admin, END, args));
      expect(refused.code, JSON.stringify(args)).toBe("validation_error");
    }
    expect(await browserLive(signed.cookie)).toBe(true);
    expect(await passkeyIds()).toContain(key.id);
  });
});

describe("marfa_end_sign_in ends an app", () => {
  it("ends nothing when called without a confirmation, and previews the app with its webhooks, keys and token chains", async () => {
    const owner = await app();
    const hook = await webhook(owner);
    const key = await appKey(owner);

    const kept = await preview({ id: owner.grantId });
    expect(kept.kind).toBe("app");
    expect(kept.sign_in).toMatchObject({ id: owner.grantId, kind: "app" });
    expect(Array.isArray(kept.scopes)).toBe(true);
    expect((kept.scopes as string[]).length).toBeGreaterThan(0);
    expect(kept.webhooks).toEqual([
      {
        id: hook.id,
        url: hook.url,
        events: ["item.created"],
        type_filter: null,
        active: true,
      },
    ]);
    expect(kept.keys).toBeUndefined();
    expect(kept.keys_kept).toBe(1);
    expect(kept.token_chains).toBe(1);
    expect(kept.ends_this_connection).toBe(false);

    const ending = await preview({ id: owner.grantId, revoke_keys: true });
    expect(ending.keys).toEqual([
      expect.objectContaining({ id: key.id, label: expect.any(String) }),
    ]);
    expect(ending.keys_kept).toBeUndefined();

    expect(await appLive(owner.token)).toBe(true);
    expect(await keyLive(key.key)).toBe(true);
    expect(await webhookIds()).toContain(hook.id);
  });

  it("ends the app, its token chains and webhooks with the confirmation the preview gave, and keeps its keys", async () => {
    const owner = await app();
    const hook = await webhook(owner);
    const key = await appKey(owner);
    const shown = await preview({ id: owner.grantId });
    const done = await preview({ id: owner.grantId, confirm: shown.confirm });
    expect(done).toMatchObject({ ended: true, kind: "app", revoked_keys: 0 });
    expect(await appLive(owner.token)).toBe(false);
    expect(await webhookIds()).not.toContain(hook.id);
    expect(await keyLive(key.key)).toBe(true);
    expect((await signIns()).map((row) => row.id)).not.toContain(owner.grantId);
  });

  it("revokes the app's keys with it when the preview asked for revoke_keys, and says how many", async () => {
    const owner = await app();
    const first = await appKey(owner);
    const second = await appKey(owner);
    const args = { id: owner.grantId, revoke_keys: true };
    const shown = await preview(args);
    const done = await preview({ ...args, confirm: shown.confirm });
    expect(done).toMatchObject({ ended: true, kind: "app", revoked_keys: 2 });
    expect(await keyLive(first.key)).toBe(false);
    expect(await keyLive(second.key)).toBe(false);
    expect(await appLive(owner.token)).toBe(false);
  });

  it("says when ending the app ends the connection making the call, which then stops working", async () => {
    const caller = await app();
    const other = await app();
    const connection = await connectMcp(
      server.apiUrl,
      caller.token,
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      // The witness: another app's preview does not end this connection.
      const theirs = await preview({ id: other.grantId }, connection);
      expect(theirs.ends_this_connection).toBe(false);
      const own = await preview({ id: caller.grantId }, connection);
      expect(own.ends_this_connection).toBe(true);
      expect(String(own.next)).toContain("/mcp/schema");
      const done = await preview(
        { id: caller.grantId, confirm: own.confirm },
        connection,
      );
      expect(done.ended).toBe(true);
      expect(await appLive(caller.token)).toBe(false);
    } finally {
      await connection.close().catch(() => undefined);
    }
    expect(await appLive(other.token)).toBe(true);
  });

  it("says when revoking the app's keys ends the key making the call", async () => {
    const owner = await app();
    const minted = await asApp(owner).createKey({
      label: "app-made-admin",
      source: `app-made-admin-${randomUUID()}`,
      permissions: ["grants.manage"],
      type_permissions: {},
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    const connection = await connectMcp(
      server.apiUrl,
      minted.data.key,
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      // The witness: without revoke_keys the key outlives the app.
      const kept = await preview({ id: owner.grantId }, connection);
      expect(kept.ends_this_connection).toBe(false);
      const ending = await preview(
        { id: owner.grantId, revoke_keys: true },
        connection,
      );
      expect(ending.ends_this_connection).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("refuses a confirmation once the app was renamed since the preview, with a new preview", async () => {
    const owner = await app();
    const shown = await preview({ id: owner.grantId });
    toolResult(
      await callTool(admin, "marfa_rename_sign_in", {
        kind: "sign_in",
        id: owner.grantId,
        name: "renamed app",
      }),
    );
    const refused = await stale({ id: owner.grantId, confirm: shown.confirm });
    expect(refused.sign_in).toMatchObject({ name: "renamed app" });
    expect(typeof refused.confirm).toBe("string");
    expect(await appLive(owner.token)).toBe(true);
  });

  it("previews the app's webhooks and keys that fit the answer, counting those it leaves out", async () => {
    const owner = await app();
    const long = "a".repeat(12_000);
    await webhook(owner, `https://hooks.example.com/${long}-1`);
    await webhook(owner, `https://hooks.example.com/${long}-2`);
    await appKey(owner, `${long}-1`);
    await appKey(owner, `${long}-2`);
    const shown = await preview({ id: owner.grantId, revoke_keys: true });
    expect((shown.webhooks as unknown[]).length).toBe(1);
    expect(shown.webhooks_left_out).toBe(1);
    expect((shown.keys as unknown[]).length).toBe(1);
    expect(shown.keys_left_out).toBe(1);
    // The witness: with one of each, nothing is left out.
    const single = await app();
    await webhook(single, `https://hooks.example.com/${long}`);
    await appKey(single, long);
    const fits = await preview({ id: single.grantId, revoke_keys: true });
    expect(fits.webhooks_left_out).toBeUndefined();
    expect(fits.keys_left_out).toBeUndefined();
  });

  it("ends an app for a credential that holds grants.manage alone, and ends no browser sign-in or passkey for it", async () => {
    const owner = await app();
    const shown = await preview({ id: owner.grantId }, grantsOnly);
    const done = await preview(
      { id: owner.grantId, confirm: shown.confirm },
      grantsOnly,
    );
    expect(done).toMatchObject({ ended: true, kind: "app" });
    expect(await appLive(owner.token)).toBe(false);

    const signed = await browser();
    const key = await passkey("grants-only");
    for (const args of [{ id: signed.id }, { kind: "passkey", id: key.id }]) {
      const answer = await callTool(grantsOnly, END, args);
      expect(answer.isError, JSON.stringify(args)).toBe(true);
    }
    expect(await browserLive(signed.cookie)).toBe(true);
    expect(await passkeyIds()).toContain(key.id);
  });

  it("refuses a key with a pointer to marfa_revoke_key, and revokes nothing", async () => {
    const { id, key } = await mint(`refused-${randomUUID()}`, []);
    expect((await signIns()).map((row) => row.id)).toContain(id);
    const refused = toolError(await callTool(admin, END, { id }));
    expect(refused.code).toBe("validation_error");
    expect(refused.use_tool).toBe("marfa_revoke_key");
    expect(await keyLive(key)).toBe(true);
  });

  it("refuses a confirmation once a webhook was made, changed or deleted since the preview, with a new preview", async () => {
    const owner = await app();
    const hook = await webhook(owner);
    const steps: [string, () => Promise<void>][] = [
      ["made", async () => void (await webhook(owner))],
      [
        "changed",
        async () => {
          const changed = await asApp(owner).updateWebhook(hook.id, {
            active: false,
          });
          expect(changed.status, JSON.stringify(changed.error)).toBe(200);
        },
      ],
      [
        "deleted",
        async () => {
          const deleted = await asApp(owner).deleteWebhook(hook.id);
          expect(deleted.status, JSON.stringify(deleted.error)).toBe(200);
        },
      ],
    ];
    for (const [step, change] of steps) {
      const shown = await preview({ id: owner.grantId });
      await change();
      const refused = await stale({
        id: owner.grantId,
        confirm: shown.confirm,
      });
      expect(typeof refused.confirm, step).toBe("string");
      expect(await appLive(owner.token), step).toBe(true);
    }
  });

  it("refuses a confirmation once the app's access was narrowed since the preview, with a new preview", async () => {
    const owner = await app();
    const shown = await preview({ id: owner.grantId });
    const scopes = shown.scopes as string[];
    const narrowed = await api(
      "PATCH",
      `/grants/${owner.grantId}`,
      server.managementKey,
      {
        scopes: scopes.filter((scope) => scope !== "webhooks.manage"),
        expected_scopes: scopes,
      },
    );
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    const refused = await stale({ id: owner.grantId, confirm: shown.confirm });
    expect(refused.scopes).not.toContain("webhooks.manage");
    expect(typeof refused.confirm).toBe("string");
    expect((await signIns()).map((row) => row.id)).toContain(owner.grantId);
  });

  it("refuses a confirmation that revokes keys once the app made, changed or lost a key since the preview", async () => {
    const owner = await app();
    const key = await appKey(owner);
    const args = { id: owner.grantId, revoke_keys: true };
    const steps: [string, () => Promise<void>][] = [
      ["made", async () => void (await appKey(owner))],
      [
        "changed",
        async () => {
          const changed = await manager().updateKey(key.id, {
            label: "relabeled",
          });
          expect(changed.status).toBe(200);
        },
      ],
      [
        "revoked",
        async () => {
          expect((await manager().revokeKey(key.id)).status).toBe(200);
        },
      ],
    ];
    for (const [step, change] of steps) {
      const shown = await preview(args);
      await change();
      await stale({ ...args, confirm: shown.confirm });
      expect(await appLive(owner.token), step).toBe(true);
    }
    // The witness: without revoke_keys, a key made since the preview does not bind it.
    const kept = await preview({ id: owner.grantId });
    await appKey(owner);
    const done = await preview({ id: owner.grantId, confirm: kept.confirm });
    expect(done.ended).toBe(true);
  });

  it("ends the app on a confirmation after it refreshed its token since the preview", async () => {
    const owner = await app();
    expect(owner.refreshToken).toBeDefined();
    const shown = await preview({ id: owner.grantId });
    const fresh = await refreshedAppToken(
      server,
      owner.clientId,
      owner.refreshToken!,
    );
    expect(await appLive(fresh)).toBe(true);
    const done = await preview({ id: owner.grantId, confirm: shown.confirm });
    expect(done.ended).toBe(true);
    expect(await appLive(fresh)).toBe(false);
  });

  it("ends the app on a confirmation after codes were issued and redeemed for it and an event was queued for its webhook since the preview", async () => {
    const owner = await app();
    const hook = await webhook(owner);
    const shown = await preview({ id: owner.grantId });
    const issue = () =>
      codeFor(
        server,
        home.origin,
        ownerCookie,
        { clientId: owner.clientId },
        APP_SCOPE,
      );
    const unredeemed = await issue();
    expect(unredeemed.silent).toBe(true);
    const redeemed = await issue();
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code: redeemed.code,
      redirect_uri: CALLBACK,
      code_verifier: redeemed.verifier,
      client_id: owner.clientId,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    const written = await new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.workingKey,
    }).createItem({ type: "core.note", properties: { title: "queued" } });
    expect(written.status, JSON.stringify(written.error)).toBe(201);
    // The witness: the write queued a delivery for the app's webhook.
    await vi.waitFor(
      async () => {
        const listed = await asApp(owner).listWebhookDeliveries(hook.id);
        expect(listed.status, JSON.stringify(listed.error)).toBe(200);
        expect(listed.data.data.map((row) => row.event_type)).toContain(
          "item.created",
        );
      },
      { timeout: 20_000, interval: 100 },
    );
    const done = await preview({ id: owner.grantId, confirm: shown.confirm });
    expect(done).toMatchObject({ ended: true, kind: "app" });
    expect(await appLive(owner.token)).toBe(false);
    expect(await appLive(exchanged.body.access_token!)).toBe(false);
    expect(await webhookIds()).not.toContain(hook.id);
  });

  it("refuses a confirmation once a new approval added a destination since the preview, with a new preview", async () => {
    const owner = await app();
    const shown = await preview({ id: owner.grantId });
    const added = "http://127.0.0.1:9/added";
    // Only a client's metadata document, served from a public address, offers a new redirect URI.
    withInstanceDatabase(server.sqlitePath, (db) => {
      const changed = db
        .prepare(
          "UPDATE oauth_clients SET redirect_uris = json_insert(redirect_uris, '$[#]', ?) WHERE client_id = ?",
        )
        .run(added, owner.clientId);
      expect(Number(changed.changes)).toBe(1);
    });
    const asked = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(owner.clientId, APP_SCOPE, pkce(), {
          redirect_uri: added,
        }),
        ownerCookie,
      ),
    );
    expect(asked?.href.startsWith(added)).toBe(false);
    const landed = await approveAsDrawn(
      server,
      home.origin,
      ownerCookie,
      asked!,
    );
    expect(landed?.href.startsWith(added)).toBe(true);
    const refused = await stale({ id: owner.grantId, confirm: shown.confirm });
    expect(refused.scopes).toEqual(shown.scopes);
    expect(typeof refused.confirm).toBe("string");
    expect(await appLive(owner.token)).toBe(true);
    // The witness: approving again with no new destination leaves the new preview's confirmation holding.
    const again = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(owner.clientId, APP_SCOPE, pkce(), {
          prompt: "consent",
        }),
        ownerCookie,
      ),
    );
    const approved = await approveAsDrawn(
      server,
      home.origin,
      ownerCookie,
      again!,
    );
    expect(approved?.searchParams.get("code")).toBeTruthy();
    const done = await preview({ id: owner.grantId, confirm: refused.confirm });
    expect(done.ended).toBe(true);
  });
});

describe("marfa_end_sign_in removes a passkey", () => {
  it("removes nothing when called without a confirmation, and removes the passkey with the one the preview gave", async () => {
    const key = await passkey("removed");
    const args = { kind: "passkey", id: key.id };
    const shown = await preview(args);
    expect(shown.kind).toBe("passkey");
    expect(shown.passkey).toMatchObject({ id: key.id, name: "removed" });
    expect(await passkeyIds()).toContain(key.id);
    const done = await preview({ ...args, confirm: shown.confirm });
    expect(done).toMatchObject({ ended: true, kind: "passkey" });
    expect(done.revoked_keys).toBeUndefined();
    expect(await passkeyIds()).not.toContain(key.id);
  });

  it("refuses a confirmation once the passkey was renamed since the preview, with a new preview", async () => {
    const key = await passkey("before");
    const args = { kind: "passkey", id: key.id };
    const shown = await preview(args);
    toolResult(
      await callTool(admin, "marfa_rename_sign_in", {
        kind: "passkey",
        id: key.id,
        name: "after",
      }),
    );
    const refused = await stale({ ...args, confirm: shown.confirm });
    expect(refused.passkey).toMatchObject({ name: "after" });
    expect(await passkeyIds()).toContain(key.id);
  });

  it("removes the passkey on a confirmation after it signed the owner in since the preview", async () => {
    const key = await passkey("used");
    const args = { kind: "passkey", id: key.id };
    const shown = await preview(args);
    await usePasskey(key);
    const listed = toolResult(await callTool(admin, "marfa_sign_ins", {}));
    // The witness: the use rewrote the passkey's last use.
    expect(
      (listed.passkeys as { id: string; last_used_at: string | null }[]).find(
        (row) => row.id === key.id,
      )?.last_used_at,
    ).not.toBeNull();
    const done = await preview({ ...args, confirm: shown.confirm });
    expect(done.ended).toBe(true);
    expect(await passkeyIds()).not.toContain(key.id);
  });
});

describe("a confirmation of ending a sign-in", () => {
  it("refuses a confirmation when the sign-in or passkey is gone, without saying it was not found", async () => {
    const signed = await browser();
    const owner = await app();
    const key = await passkey("gone");
    const cases: [Record<string, unknown>, () => Promise<void>][] = [
      [
        { id: signed.id },
        async () => {
          const ended = await api("DELETE", `/owner/sign-ins/${signed.id}`);
          expect(ended.status).toBe(200);
        },
      ],
      [
        { id: owner.grantId },
        async () => {
          const ended = await api("DELETE", `/grants/${owner.grantId}`);
          expect(ended.status).toBe(200);
        },
      ],
      [
        { kind: "passkey", id: key.id },
        async () => {
          const removed = await api("DELETE", `/owner/passkeys/${key.id}`);
          expect(removed.status).toBe(200);
        },
      ],
    ];
    for (const [args, end] of cases) {
      const shown = await preview(args);
      await end();
      const refused = await stale({ ...args, confirm: shown.confirm });
      expect(refused.confirm, JSON.stringify(args)).toBeUndefined();
      expect(String(refused.message)).not.toMatch(/not found/i);
    }
  });

  it("refuses a confirmation another credential got", async () => {
    const signed = await browser();
    const owner = await app();
    const key = await passkey("other-credential");
    for (const args of [
      { id: signed.id },
      { id: owner.grantId },
      { kind: "passkey", id: key.id },
    ]) {
      const theirs = await preview(args, otherAdmin);
      const refused = await stale({ ...args, confirm: theirs.confirm });
      expect(refused.confirm, JSON.stringify(args)).toBeUndefined();
    }
    expect(await browserLive(signed.cookie)).toBe(true);
    expect(await appLive(owner.token)).toBe(true);
    expect(await passkeyIds()).toContain(key.id);
  });

  it("refuses a confirmation sent for another sign-in, kind or revoke_keys before reading it", async () => {
    const signed = await browser();
    const owner = await app();
    const other = await app();
    const key = await passkey("named");
    const ending = await preview({ id: owner.grantId });
    for (const args of [
      { id: other.grantId },
      { id: owner.grantId, revoke_keys: true },
      { kind: "passkey", id: owner.grantId },
      { id: randomUUID() },
    ]) {
      const refused = await stale({ ...args, confirm: ending.confirm });
      expect(refused.confirm, JSON.stringify(args)).toBeUndefined();
    }
    const browsing = await preview({ id: signed.id });
    for (const args of [
      { kind: "passkey", id: key.id },
      { id: signed.id, revoke_keys: true },
    ]) {
      const wrong = await stale({ ...args, confirm: browsing.confirm });
      expect(wrong.confirm, JSON.stringify(args)).toBeUndefined();
    }
    expect(await browserLive(signed.cookie)).toBe(true);
    expect(await appLive(owner.token)).toBe(true);
    expect(await appLive(other.token)).toBe(true);
    expect(await passkeyIds()).toContain(key.id);
  });

  it("leaves everything and the confirmation as they were when the confirmed change fails, and changes it without the fault", async () => {
    const signed = await browser();
    const owner = await app();
    const hook = await webhook(owner);
    const key = await appKey(owner);
    const held = await passkey("fault");
    const cases: [string, Record<string, unknown>, () => Promise<void>][] = [
      [
        ACTIONS.browser,
        { id: signed.id },
        async () => {
          expect(await browserLive(signed.cookie)).toBe(true);
        },
      ],
      [
        ACTIONS.app,
        { id: owner.grantId, revoke_keys: true },
        async () => {
          expect(await appLive(owner.token)).toBe(true);
          expect(await keyLive(key.key)).toBe(true);
          expect(await webhookIds()).toContain(hook.id);
        },
      ],
      [
        ACTIONS.passkey,
        { kind: "passkey", id: held.id },
        async () => {
          expect(await passkeyIds()).toContain(held.id);
        },
      ],
    ];
    for (const [action, args, stands] of cases) {
      const shown = await preview(args);
      await server.setFault(`fail:audit=${action}`);
      const failed = await callTool(admin, END, {
        ...args,
        confirm: shown.confirm,
      });
      // The witness that the fault acted inside the change, after its rows went and before it committed.
      expect(
        (await server.faults()).find((fault) => fault.name === "fail:audit")
          ?.fired,
        action,
      ).toBe(1);
      expect(failed.isError, action).toBe(true);
      await stands();
      await server.clearFault();
      const done = await preview({ ...args, confirm: shown.confirm });
      expect(done.ended, action).toBe(true);
      expect(done.already_done, action).toBeUndefined();
    }
    expect(await browserLive(signed.cookie)).toBe(false);
    expect(await appLive(owner.token)).toBe(false);
    expect(await keyLive(key.key)).toBe(false);
    expect(await webhookIds()).not.toContain(hook.id);
    expect(await passkeyIds()).not.toContain(held.id);
  });

  it("changes nothing more on a confirmation an earlier call used, and says it already did", async () => {
    const owner = await app();
    await appKey(owner);
    const args = { id: owner.grantId, revoke_keys: true };
    const shown = await preview(args);
    expect(await preview({ ...args, confirm: shown.confirm })).toMatchObject({
      ended: true,
      revoked_keys: 1,
    });
    expect(await preview({ ...args, confirm: shown.confirm })).toMatchObject({
      ended: true,
      kind: "app",
      revoked_keys: 1,
      already_done: true,
    });

    const key = await passkey("repeated");
    const removing = await preview({ kind: "passkey", id: key.id });
    const removed = { kind: "passkey", id: key.id, confirm: removing.confirm };
    expect((await preview(removed)).ended).toBe(true);
    expect(await preview(removed)).toMatchObject({
      ended: true,
      kind: "passkey",
      already_done: true,
    });
  });

  it("refuses a confirmation once five minutes have passed since the preview", async () => {
    const signed = await browser();
    const owner = await app();
    const key = await passkey("expired");
    const calls = [
      { id: signed.id },
      { id: owner.grantId },
      { kind: "passkey", id: key.id },
    ];
    const shown = [];
    for (const args of calls) {
      shown.push((await preview(args)).confirm);
    }
    await server.advanceClock(CONFIRMATION_LIFE_MS + 1_000);
    for (const [index, args] of calls.entries()) {
      const refused = await stale({ ...args, confirm: shown[index] });
      expect(refused.confirm, JSON.stringify(args)).toBeUndefined();
    }
    expect(await browserLive(signed.cookie)).toBe(true);
    expect(await passkeyIds()).toContain(key.id);
  });
});
