import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { listEntries } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  serverOutput,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  arriveAt,
  granted,
  runProvider,
  type Answer,
  type Provider,
} from "../../utils/oauth-provider.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import {
  connectorBundle,
  connectorKey,
  connectorSection,
  fresh,
  linkedHost,
  ownerKey,
  type LinkedHost,
} from "../../utils/plugin-connector.js";
import {
  CALLBACK,
  connect,
  issuerOrigin,
  registerApp,
  signIn,
} from "../../utils/signed-in.js";

/**
 * A plugin's connector that declares `sign_in` gets its refresh token through
 * the owner's browser: the start answers the provider's address, the provider
 * sends the browser back to the callback, and the server trades the code at
 * the provider's token address for a refresh token it seals into the
 * connector's token setting. A `sign-in-provider` fault points the provider's
 * addresses at a provider this file runs, so nothing leaves the machine. The
 * server is the file's own, since plugins and connector hosts are the
 * instance's.
 */

let server: FreshServer;
let owner: MarfaClient;
let host: LinkedHost;
let provider: Provider;
let issuer: string;

const TEN_MINUTES_MS = 10 * 60 * 1000;
const SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "openid"];

const SETTINGS = [
  { name: "client_id", label: "Client ID", kind: "text", required: true },
  {
    name: "client_secret",
    label: "Client secret",
    kind: "text",
    secret: true,
    required: true,
  },
  {
    name: "refresh_token",
    label: "Refresh token",
    kind: "text",
    secret: true,
    required: false,
  },
];

const SIGN_IN = {
  kind: "oauth2",
  provider: "google",
  scopes: SCOPES,
  client_id_setting: "client_id",
  client_secret_setting: "client_secret",
  token_setting: "refresh_token",
};

beforeAll(async () => {
  [server, provider] = await Promise.all([
    bootFreshServer("connector-sign-in"),
    runProvider(),
  ]);
  owner = (
    await ownerKey(server, [
      "schema.write",
      "connectors.manage",
      "keys.manage",
      "keys.mint",
      "backups.manage",
      "audit.read",
    ])
  ).client;
  host = await linkedHost(server, owner, "sign-in host");
  issuer = await issuerOrigin(server);
  await server.setFault(`sign-in-provider=${provider.origin}`);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([server?.stop(), provider?.close()]);
}, FRESH_SERVER_TIMEOUT_MS);

/** A bundle named `<prefix>-<part>` whose connector declares the client settings and `sign_in`. */
function signInBundle(
  prefix: string,
  signIn: Record<string, unknown> | null = SIGN_IN,
): { name: string; bundle: Record<string, unknown> } {
  const name = `${prefix}-${fresh()}`;
  const root = name.replaceAll("-", "");
  const extra: Record<string, unknown> = { settings: SETTINGS };
  if (signIn !== null) extra.sign_in = signIn;
  return {
    name,
    bundle: connectorBundle(name, root, name, {
      connector: connectorSection(`${root}.entry`, name, extra),
    }),
  };
}

/** Installs a plugin whose connector declares `sign_in`, its client settings set. */
async function ready(
  prefix: string,
): Promise<{ name: string; clientId: string; clientSecret: string }> {
  const { name, bundle } = signInBundle(prefix);
  const made = await owner.installPlugin(bundle);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const clientId = `${fresh()}.apps.googleusercontent.com`;
  const clientSecret = `GOCSPX-${randomUUID()}`;
  const set = await owner.setConnectorSettings(name, {
    client_id: clientId,
    client_secret: clientSecret,
  });
  expect(set.status, JSON.stringify(set.error)).toBe(200);
  return { name, clientId, clientSecret };
}

type Started = { url: URL; state: string; challenge: string; raw: string };

async function started(name: string, body?: unknown): Promise<Started> {
  const answer = await owner.startConnectorSignIn(name, body);
  expect(answer.status, JSON.stringify(answer.error)).toBe(201);
  const url = new URL(answer.data.url as string);
  return {
    url,
    state: url.searchParams.get("state") ?? "",
    challenge: url.searchParams.get("code_challenge") ?? "",
    raw: JSON.stringify(answer.data),
  };
}

type Arrived = Awaited<ReturnType<typeof arriveAt>>;

function arrive(
  query: Record<string, string>,
  from: FreshServer = server,
): Promise<Arrived> {
  return arriveAt(from.apiUrl, query);
}

function expectPage(arrived: Arrived, status: number): void {
  expect(arrived.status, arrived.text.slice(0, 300)).toBe(status);
  expect(arrived.contentType).toMatch(/^text\/html/);
  expect(arrived.location).toBeNull();
}

type Entry = Record<string, unknown> & { name: string };

async function tokenEntry(name: string): Promise<Entry> {
  const listed = await owner.getConnectorSettings(name);
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return (listed.data.settings as Entry[]).find(
    (entry) => entry.name === "refresh_token",
  )!;
}

async function statusOf(name: string): Promise<Record<string, any>> {
  const read = await owner.getConnectorSignIn(name);
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  return read.data;
}

/** The refresh token the plugin's connector reads with its own key. */
async function tokenForConnector(name: string): Promise<unknown> {
  const assigned = await owner.assignConnector(name, host.id);
  expect(assigned.status, JSON.stringify(assigned.error)).toBe(200);
  const key = await connectorKey(server, host, name);
  const registered = await key.client.registerConnector({ name });
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  const own = await key.client.readOwnConnectorSettings(registered.data.id);
  expect(own.status, JSON.stringify(own.error)).toBe(200);
  return (own.data.settings as Entry[]).find(
    (entry) => entry.name === "refresh_token",
  )?.value;
}

function errorPaths(answer: { error?: { error: { details?: unknown } } }) {
  const errors = (answer.error?.error.details as { errors?: unknown[] })
    ?.errors as { path: string }[] | undefined;
  return (errors ?? []).map((held) => held.path);
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The audit entries of the plugin's failed sign-ins, newest first. */
async function failedEntries(name: string): Promise<Record<string, any>[]> {
  const audit = await owner.listAudit({ resource_id: name, limit: 200 });
  expect(audit.status, JSON.stringify(audit.error)).toBe(200);
  return (audit.data.data as unknown as Record<string, any>[]).filter(
    (entry) => entry.action === "connector.sign_in_failed",
  );
}

/**
 * Starts a sign-in for a fresh plugin, sends the browser back with `query`
 * (the state added), and answers the page, the status, and the outcome its
 * one failed audit entry records.
 */
async function failedWith(
  prefix: string,
  query: Record<string, string>,
  page: number,
): Promise<{ arrived: Arrived; status: Record<string, any>; audit: string }> {
  const { name } = await ready(prefix);
  const start = await started(name);
  const arrived = await arrive({ state: start.state, ...query });
  expectPage(arrived, page);
  const status = await statusOf(name);
  expect(status.status).toBe("failed");
  const entries = await failedEntries(name);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.details.outcome).toBe(status.reason);
  return { arrived, status, audit: JSON.stringify(entries) };
}

/** An app whose OAuth client registered `redirectUris`, holding `connectors.manage`. */
async function appClient(redirectUris: string[]): Promise<MarfaClient> {
  const scope = "connectors.manage";
  const app = await registerApp(server, scope, {
    redirect_uris: [CALLBACK, ...redirectUris],
  });
  const tokens = await connect(
    server,
    issuer,
    await signIn(server, issuer),
    app,
    scope,
  );
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: tokens.access_token!,
  });
}

describe("starting a sign-in", () => {
  it("starts a sign-in answering the provider's address with every parameter, a state and an S256 challenge, ten minutes to finish", async () => {
    const { name, clientId } = await ready("start");
    const before = await statusOf(name);
    expect(before).toEqual({
      plugin: name,
      status: "none",
      reason: null,
      id: null,
      started_at: null,
      expires_at: null,
      ended_at: null,
    });
    const askedBefore = provider.asked.length;

    const answer = await owner.startConnectorSignIn(name, {
      return_to: "/done",
    });
    expect(answer.status, JSON.stringify(answer.error)).toBe(201);
    await expectMatchesSchema(
      "POST",
      "/plugins/{name}/connector/sign-in",
      201,
      answer.data,
    );
    const url = new URL(answer.data.url as string);
    expect(`${url.origin}${url.pathname}`).toBe(`${provider.origin}/authorize`);
    const params = url.searchParams;
    expect(params.get("client_id")).toBe(clientId);
    expect(params.get("redirect_uri")).toBe(`${issuer}/connect/oauth/callback`);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("scope")).toBe(SCOPES.join(" "));
    expect(params.get("state")).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");

    const pending = await statusOf(name);
    await expectMatchesSchema(
      "GET",
      "/plugins/{name}/connector/sign-in",
      200,
      pending,
    );
    expect(pending.status).toBe("pending");
    expect(pending.reason).toBeNull();
    expect(typeof answer.data.id).toBe("string");
    expect(pending.id).toBe(answer.data.id);
    expect(pending.ended_at).toBeNull();
    expect(pending.expires_at).toBe(answer.data.expires_at);
    expect(
      Date.parse(pending.expires_at) - Date.parse(pending.started_at),
    ).toBe(TEN_MINUTES_MS);

    // A second start answers a fresh id, state and challenge.
    const again = await started(name);
    expect(JSON.parse(again.raw).id).not.toBe(answer.data.id);
    expect(again.state).not.toBe(params.get("state"));
    expect(again.challenge).not.toBe(params.get("code_challenge"));
    expect(provider.asked.length).toBe(askedBefore);
  });

  it("refuses 409 a start while the client ID or secret is unset, naming each, and for a connector that declares no sign-in", async () => {
    const { name, bundle } = signInBundle("unset");
    expect((await owner.installPlugin(bundle)).status).toBe(201);
    const neither = await owner.startConnectorSignIn(name);
    expect(neither.status).toBe(409);
    expect(neither.error?.error.code).toBe(
      "connector_sign_in_settings_missing",
    );
    expect(
      (neither.error?.error.details as { settings: string[] }).settings,
    ).toEqual(["client_id", "client_secret"]);

    expect(
      (await owner.setConnectorSettings(name, { client_id: "an-id" })).status,
    ).toBe(200);
    const secretOnly = await owner.startConnectorSignIn(name);
    expect(secretOnly.status).toBe(409);
    expect(
      (secretOnly.error?.error.details as { settings: string[] }).settings,
    ).toEqual(["client_secret"]);
    expect((await statusOf(name)).status).toBe("none");

    expect(
      (await owner.setConnectorSettings(name, { client_secret: "a-secret" }))
        .status,
    ).toBe(200);
    expect((await owner.startConnectorSignIn(name)).status).toBe(201);

    const plain = signInBundle("undeclared", null);
    expect((await owner.installPlugin(plain.bundle)).status).toBe(201);
    for (const answer of [
      await owner.startConnectorSignIn(plain.name),
      await owner.getConnectorSignIn(plain.name),
    ]) {
      expect(answer.status).toBe(409);
      expect(answer.error?.error.code).toBe("connector_sign_in_not_declared");
      expect((answer.error?.error.details as { plugin: string }).plugin).toBe(
        plain.name,
      );
    }
  });

  it("refuses 400 a return_to off the server's own address and a body that is not an object, 403 a key without connectors.manage, and 404 a plugin not installed or with no connector", async () => {
    const { name } = await ready("refused");
    for (const return_to of [
      "https://elsewhere.example/done",
      "//elsewhere.example/done",
      "javascript:alert(1)",
      "",
      `/${"a".repeat(2048)}`,
      7,
    ]) {
      const refused = await owner.startConnectorSignIn(name, { return_to });
      expect(refused.status, String(return_to).slice(0, 40)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(errorPaths(refused)).toEqual(["return_to"]);
    }
    for (const body of [[], "text", 3]) {
      const refused = await owner.rawRequest<Record<string, any>>(
        `/plugins/${name}/connector/sign-in`,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        },
      );
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
    const bodiless = await owner.rawRequest<Record<string, any>>(
      `/plugins/${name}/connector/sign-in`,
      { method: "POST" },
    );
    expect(bodiless.status).toBe(400);
    expect(bodiless.error?.error.code).toBe("validation_error");
    expect((await statusOf(name)).status).toBe("none");
    for (const return_to of ["/ok?a=b", `${issuer}/ok`]) {
      expect(
        (await owner.startConnectorSignIn(name, { return_to })).status,
        return_to,
      ).toBe(201);
    }

    const reader = (await ownerKey(server, ["schema.write"])).client;
    for (const answer of [
      await reader.startConnectorSignIn(name),
      await reader.getConnectorSignIn(name),
    ]) {
      expect(answer.status).toBe(403);
      expect(answer.error?.error.code).toBe("forbidden");
      expect(
        (answer.error?.error.details as { required_scope: string })
          .required_scope,
      ).toBe("connectors.manage");
    }

    const missing = `absent-${fresh()}`;
    for (const answer of [
      await owner.startConnectorSignIn(missing),
      await owner.getConnectorSignIn(missing),
    ]) {
      expect(answer.status).toBe(404);
      expect(answer.error?.error.code).toBe("plugin_not_found");
    }
    const bare = `bare-${fresh()}`;
    const bareBundle = connectorBundle(bare, bare.replaceAll("-", ""), bare);
    delete (bareBundle as Record<string, unknown>).connector;
    expect((await owner.installPlugin(bareBundle)).status).toBe(201);
    for (const answer of [
      await owner.startConnectorSignIn(bare),
      await owner.getConnectorSignIn(bare),
    ]) {
      expect(answer.status).toBe(404);
      expect(answer.error?.error.code).toBe("connector_not_found");
      expect((answer.error?.error.details as { plugin: string }).plugin).toBe(
        bare,
      );
    }
  });

  it("accepts as return_to a redirect URI the calling app's own OAuth client registered, and refuses another app's, an unregistered one, and one from a caller that is no app", async () => {
    provider.answer = granted;
    const own = "com.example.marfa-sign-in:/done";
    const withQuery = "com.example.marfa-sign-in:/back?from=marfa";
    const app = await appClient([own, withQuery]);
    const { name } = await ready("app-return");

    for (const [back, wanted] of [
      [own, `${own}?signed_in=${name}`],
      [withQuery, `${withQuery}&signed_in=${name}`],
    ] as const) {
      const answer = await app.startConnectorSignIn(name, { return_to: back });
      expect(answer.status, JSON.stringify(answer.error)).toBe(201);
      const state = new URL(answer.data.url as string).searchParams.get(
        "state",
      )!;
      const arrived = await arrive({ state, code: "c" });
      expect(arrived.status, arrived.text.slice(0, 300)).toBe(303);
      expect(arrived.location).toBe(wanted);
    }

    const other = "com.example.another-app:/done";
    await appClient([other]);
    for (const [caller, back] of [
      [app, other],
      [app, "com.example.marfa-sign-in:/elsewhere"],
      [app, `${own}/`],
      [app, "com.example.unregistered:/done"],
      [owner, own],
    ] as const) {
      const refused = await caller.startConnectorSignIn(name, {
        return_to: back,
      });
      expect(refused.status, back).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(errorPaths(refused)).toEqual(["return_to"]);
    }
    // An app keeps the server's own pages.
    expect(
      (await app.startConnectorSignIn(name, { return_to: "/done" })).status,
    ).toBe(201);
  });
});

describe("the callback", () => {
  it("finishes at the callback: the provider gets the code, the verifier, the client ID and secret, the refresh token is sealed into the token setting, and the browser goes back to return_to with signed_in", async () => {
    const { name, clientId, clientSecret } = await ready("finish");
    const start = await started(name, { return_to: "/done?step=2#part" });
    const code = `4/${randomUUID()}`;
    let given: Answer | undefined;
    provider.answer = () => (given = granted());
    const askedBefore = provider.asked.length;

    const arrived = await arrive({ state: start.state, code, scope: "x" });
    expect(arrived.status, arrived.text.slice(0, 300)).toBe(303);
    const back = new URL(arrived.location!, server.apiUrl);
    expect(back.origin).toBe(new URL(server.apiUrl).origin);
    expect(back.pathname).toBe("/done");
    expect(back.searchParams.get("step")).toBe("2");
    expect(back.searchParams.get("signed_in")).toBe(name);
    expect(back.hash).toBe("#part");

    const asked = provider.asked.slice(askedBefore);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.method).toBe("POST");
    expect(asked[0]!.path).toBe("/token");
    expect(asked[0]!.contentType).toMatch(
      /^application\/x-www-form-urlencoded/,
    );
    const form = asked[0]!.form;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe(code);
    expect(form.get("redirect_uri")).toBe(
      start.url.searchParams.get("redirect_uri"),
    );
    expect(form.get("client_id")).toBe(clientId);
    expect(form.get("client_secret")).toBe(clientSecret);
    const verifier = form.get("code_verifier") ?? "";
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(s256(verifier)).toBe(start.challenge);

    const entry = await tokenEntry(name);
    expect(entry).toMatchObject({ set: true, value: null, unreadable: false });
    const refresh = (given!.body as { refresh_token: string }).refresh_token;
    expect(await tokenForConnector(name)).toBe(refresh);
    const done = await statusOf(name);
    expect(done.status).toBe("signed_in");
    expect(done.ended_at).not.toBeNull();
  });

  it("shows a page saying the owner can return to their app when the sign-in gave no return_to", async () => {
    const { name } = await ready("page");
    provider.answer = granted;
    const start = await started(name);
    const arrived = await arrive({ state: start.state, code: randomUUID() });
    expectPage(arrived, 200);
    expect(arrived.text).toMatch(/return to (your|the) app/i);
    expect((await tokenEntry(name)).set).toBe(true);
    expect((await statusOf(name)).status).toBe("signed_in");
  });

  it("finishes nothing for a wrong, replayed, expired or replaced state, showing each the page that says the sign-in did not finish, storing nothing and asking the provider nothing", async () => {
    provider.answer = granted;

    // A state no start answered, and none at all.
    const wrong = await ready("wrong");
    await started(wrong.name);
    let asked = provider.asked.length;
    expectPage(
      await arrive({ state: randomUUID().replaceAll("-", ""), code: "c" }),
      400,
    );
    expectPage(await arrive({ code: "c" }), 400);
    expect(provider.asked.length).toBe(asked);
    expect((await tokenEntry(wrong.name)).set).toBe(false);
    expect((await statusOf(wrong.name)).status).toBe("pending");

    // A state a callback already ended: the first use finishes, the second nothing.
    const replay = await ready("replay");
    const once = await started(replay.name);
    const code = randomUUID();
    expectPage(await arrive({ state: once.state, code }), 200);
    asked = provider.asked.length;
    const tokenBefore = await tokenForConnector(replay.name);
    expectPage(await arrive({ state: once.state, code }), 400);
    expect(provider.asked.length).toBe(asked);
    expect(await tokenForConnector(replay.name)).toBe(tokenBefore);

    // A state a later start replaced; the later one still finishes.
    const replaced = await ready("replaced");
    const first = await started(replaced.name);
    const second = await started(replaced.name);
    asked = provider.asked.length;
    expectPage(await arrive({ state: first.state, code: "c" }), 400);
    expect(provider.asked.length).toBe(asked);
    expect((await tokenEntry(replaced.name)).set).toBe(false);
    expect((await statusOf(replaced.name)).status).toBe("pending");
    expectPage(await arrive({ state: second.state, code: "c" }), 200);
    expect((await tokenEntry(replaced.name)).set).toBe(true);

    // A state whose ten minutes have passed.
    const late = await ready("late");
    const lapsing = await started(late.name);
    await server.advanceClock(TEN_MINUTES_MS + 1000);
    asked = provider.asked.length;
    expectPage(await arrive({ state: lapsing.state, code: "c" }), 400);
    expect(provider.asked.length).toBe(asked);
    expect((await tokenEntry(late.name)).set).toBe(false);
  });

  it("ends the sign-in on an error from the provider, showing the page that says it did not finish and storing nothing", async () => {
    provider.answer = granted;
    const written = `written-by-the-provider-${randomUUID()}`;
    for (const [query, outcome] of [
      [{ error: "access_denied" }, "access_denied"],
      [{ error: "access_denied", code: "c" }, "access_denied"],
      [{ error: "server_error", error_description: written }, "server_error"],
      [{ error: "temporarily_unavailable" }, "temporarily_unavailable"],
      [{ error: "invalid_scope" }, "invalid_scope"],
      [{ error: written, error_description: written }, "provider_error"],
      [{ error: "admin_policy_enforced" }, "provider_error"],
      [{}, "no_code"],
    ] as [Record<string, string>, string][]) {
      const { name } = await ready("denied");
      const start = await started(name);
      const asked = provider.asked.length;
      const arrived = await arrive({ state: start.state, ...query });
      expectPage(arrived, 400);
      const status = await statusOf(name);
      expect(status.status).toBe("failed");
      expect(status.reason, JSON.stringify(query)).toBe(outcome);
      const entries = await failedEntries(name);
      expect(entries.map((entry) => entry.details.outcome)).toEqual([outcome]);
      for (const text of [
        arrived.text,
        JSON.stringify(status),
        JSON.stringify(entries),
      ]) {
        expect(text.includes(written), JSON.stringify(query)).toBe(false);
      }
      expectPage(await arrive({ state: start.state, code: "c" }), 400);
      expect(provider.asked.length, JSON.stringify(query)).toBe(asked);
      expect((await tokenEntry(name)).set).toBe(false);
    }
  });

  it("stores nothing when the provider answers without a refresh token, and shows a page saying the sign-in failed", async () => {
    for (const [answer, outcome] of [
      [
        { status: 200, body: { access_token: "a", expires_in: 3599 } },
        "no_refresh_token",
      ],
      [
        { status: 200, body: { access_token: "a", refresh_token: 12 } },
        "unreadable_answer",
      ],
      [
        { status: 200, body: { access_token: "a", refresh_token: " padded " } },
        "unreadable_answer",
      ],
      [{ status: 400, body: { error: "invalid_grant" } }, "invalid_grant"],
      [{ status: 200, body: ["not", "an", "object"] }, "unreadable_answer"],
      [{ status: 200, body: "x".repeat(70 * 1024) }, "unreadable_answer"],
    ] as [Answer, string][]) {
      provider.answer = () => answer;
      const { name } = await ready("no-refresh");
      const start = await started(name);
      const asked = provider.asked.length;
      expectPage(await arrive({ state: start.state, code: "c" }), 502);
      expect(provider.asked.length, JSON.stringify(answer)).toBe(asked + 1);
      expect((await tokenEntry(name)).set, JSON.stringify(answer)).toBe(false);
      const status = await statusOf(name);
      expect(status.status).toBe("failed");
      expect(status.reason, JSON.stringify(answer).slice(0, 80)).toBe(outcome);
      expect(
        (await failedEntries(name)).map((entry) => entry.details.outcome),
      ).toEqual([outcome]);
    }
    provider.answer = granted;
  });

  it("ends the sign-in as failed when the provider does not answer within the bound", async () => {
    await server.setFault("sign-in-deadline=500");
    try {
      provider.answer = () => ({ ...granted(), delayMs: 5000 });
      const { name } = await ready("slow");
      const start = await started(name);
      const began = Date.now();
      expectPage(await arrive({ state: start.state, code: "c" }), 502);
      expect(Date.now() - began).toBeLessThan(4000);
      const status = await statusOf(name);
      expect(status.status).toBe("failed");
      expect(status.reason).toBe("timeout");
      expect(
        (await failedEntries(name)).map((entry) => entry.details.outcome),
      ).toEqual(["timeout"]);
      expect((await tokenEntry(name)).set).toBe(false);
    } finally {
      provider.answer = granted;
      await server.clearFault("sign-in-deadline");
    }
  });

  it("records the provider's own word for each of the six token errors of RFC 6749, keeping none of the provider's text", async () => {
    const written = `written-by-the-provider-${randomUUID()}`;
    try {
      for (const word of [
        "invalid_request",
        "invalid_client",
        "invalid_grant",
        "unauthorized_client",
        "unsupported_grant_type",
        "invalid_scope",
      ]) {
        provider.answer = () => ({
          status: word === "invalid_client" ? 401 : 400,
          body: {
            error: word,
            error_description: written,
            error_uri: `https://provider.example/${written}`,
          },
        });
        const { arrived, status, audit } = await failedWith(
          "token-error",
          { code: "c" },
          502,
        );
        expect(status.reason).toBe(word);
        for (const text of [arrived.text, JSON.stringify(status), audit]) {
          expect(text.includes(written), word).toBe(false);
        }
      }
    } finally {
      provider.answer = granted;
    }
  });

  it("records status_ and the status for a refusal with no token error it names", async () => {
    const written = `written-by-the-provider-${randomUUID()}`;
    try {
      for (const [answer, outcome] of [
        [
          { status: 400, body: { error: "temporarily_unavailable" } },
          "status_400",
        ],
        [{ status: 401, body: { error: written } }, "status_401"],
        [{ status: 503, body: written }, "status_503"],
        [{ status: 302, body: {} }, "status_302"],
      ] as [Answer, string][]) {
        provider.answer = () => answer;
        const { arrived, status, audit } = await failedWith(
          "token-status",
          { code: "c" },
          502,
        );
        expect(status.reason, JSON.stringify(answer)).toBe(outcome);
        for (const text of [arrived.text, JSON.stringify(status), audit]) {
          expect(text.includes(written)).toBe(false);
        }
      }
    } finally {
      provider.answer = granted;
    }
  });

  it("records unreachable when nothing answers at the provider's token address", async () => {
    const closed = await runProvider();
    const origin = closed.origin;
    await closed.close();
    await server.setFault(`sign-in-provider=${origin}`);
    try {
      const { status } = await failedWith("unreachable", { code: "c" }, 502);
      expect(status.reason).toBe("unreachable");
    } finally {
      await server.setFault(`sign-in-provider=${provider.origin}`);
    }
  });

  it("records changed_since_start when the client secret was cleared between the start and the callback", async () => {
    provider.answer = granted;
    const { name } = await ready("changed");
    const start = await started(name);
    const cleared = await owner.setConnectorSettings(name, {
      client_secret: null,
    });
    expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
    const asked = provider.asked.length;
    expectPage(await arrive({ state: start.state, code: "c" }), 400);
    expect(provider.asked.length).toBe(asked);
    const status = await statusOf(name);
    expect(status.status).toBe("failed");
    expect(status.reason).toBe("changed_since_start");
    expect(
      (await failedEntries(name)).map((entry) => entry.details.outcome),
    ).toEqual(["changed_since_start"]);
  });

  it("answers each of its pages with nothing from another origin", async () => {
    provider.answer = granted;
    const finished = await ready("own-finished");
    const failed = await ready("own-failed");
    const pages = [
      await arrive({
        state: (await started(finished.name)).state,
        code: "c",
      }),
      await arrive({ state: "unknown", code: "c" }),
    ];
    provider.answer = () => ({ status: 400, body: { error: "invalid_grant" } });
    pages.push(
      await arrive({ state: (await started(failed.name)).state, code: "c" }),
    );
    provider.answer = granted;
    expect(pages.map((page) => page.status)).toEqual([200, 400, 502]);
    for (const page of pages) {
      expect(page.policy, String(page.status)).toMatch(
        /(^|;)\s*default-src 'none'/,
      );
      expect(page.policy).not.toMatch(/https?:|\*/);
      expect(page.text).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
    }
  });
});

describe("what a sign-in shows and keeps", () => {
  it("answers the latest sign-in's status: none, pending, signed in, failed and expired", async () => {
    provider.answer = granted;
    const { name } = await ready("status");
    expect(await statusOf(name)).toMatchObject({
      status: "none",
      id: null,
      reason: null,
    });
    const one = await started(name);
    const oneId = JSON.parse(one.raw).id as string;
    expect(await statusOf(name)).toMatchObject({
      status: "pending",
      id: oneId,
      reason: null,
    });
    expectPage(await arrive({ state: one.state, code: "c" }), 200);
    const signedIn = await statusOf(name);
    expect(signedIn.status).toBe("signed_in");
    expect(signedIn.id).toBe(oneId);
    expect(signedIn.reason).toBeNull();
    expect(Date.parse(signedIn.ended_at)).toBeGreaterThanOrEqual(
      Date.parse(signedIn.started_at),
    );

    const two = await started(name);
    expectPage(await arrive({ state: two.state, error: "access_denied" }), 400);
    const failed = await statusOf(name);
    expect(failed.status).toBe("failed");
    expect(failed.id).toBe(JSON.parse(two.raw).id);
    expect(failed.reason).toBe("access_denied");
    // A failed sign-in leaves the earlier token.
    expect((await tokenEntry(name)).set).toBe(true);

    await started(name);
    expect((await statusOf(name)).status).toBe("pending");
    await server.advanceClock(TEN_MINUTES_MS + 1000);
    const expired = await statusOf(name);
    expect(expired.status).toBe("expired");
    expect(expired.reason).toBeNull();
    expect(expired.ended_at).toBeNull();
  });

  it("shows the code, the tokens and the client secret nowhere: no answer, page, redirect, audit entry or log line, where the connector's own key reads the refresh token", async () => {
    const { name, clientSecret } = await ready("nowhere");
    const code = `4/code-${randomUUID()}`;
    const failedCode = `4/failed-${randomUUID()}`;
    let given: Answer | undefined;
    provider.answer = () => (given = granted());

    const seen: string[] = [];
    const start = await started(name, { return_to: "/done" });
    seen.push(start.raw);
    const arrived = await arrive({ state: start.state, code });
    expect(arrived.status).toBe(303);
    seen.push(arrived.location ?? "", arrived.text);
    // A replay with the same code, and a provider that refuses another.
    const replayed = await arrive({ state: start.state, code });
    seen.push(replayed.text, replayed.location ?? "");
    provider.answer = () => ({
      status: 400,
      body: { error: "invalid_grant", error_description: failedCode },
    });
    const refusedStart = await started(name);
    const refused = await arrive({
      state: refusedStart.state,
      code: failedCode,
    });
    expect(refused.status).toBe(502);
    seen.push(refusedStart.raw, refused.text);
    provider.answer = granted;
    seen.push(JSON.stringify(await statusOf(name)));
    seen.push(
      JSON.stringify((await owner.getConnectorSettings(name)).data),
      JSON.stringify(
        (await owner.startConnectorSignIn(`absent-${fresh()}`)).error,
      ),
    );
    const audit = await owner.listAudit({ resource_id: name, limit: 200 });
    expect(audit.status, JSON.stringify(audit.error)).toBe(200);
    seen.push(JSON.stringify(audit.data));

    const body = given!.body as { refresh_token: string; access_token: string };
    // The witnesses: the provider was given the code, and the connector reads the token.
    expect(
      provider.asked.some((asked) => asked.form.get("code") === code),
    ).toBe(true);
    expect(await tokenForConnector(name)).toBe(body.refresh_token);

    const log = serverOutput(server.stateDir);
    const hidden = {
      code,
      failedCode,
      refresh: body.refresh_token,
      access: body.access_token,
      clientSecret,
    };
    for (const [what, value] of Object.entries(hidden)) {
      for (const [index, text] of seen.entries()) {
        expect(text.includes(value), `${what} in answer ${String(index)}`).toBe(
          false,
        );
      }
      expect(log.includes(value), `${what} in the log`).toBe(false);
    }
  });

  it("audits the start and the end of each sign-in against the plugin's name", async () => {
    provider.answer = granted;
    const { name } = await ready("audited");
    const one = await started(name);
    expectPage(await arrive({ state: one.state, code: "c" }), 200);
    const two = await started(name);
    expectPage(await arrive({ state: two.state, error: "access_denied" }), 400);
    // A state that ended is no sign-in, so it audits nothing.
    expectPage(await arrive({ state: two.state, code: "c" }), 400);

    const audit = await owner.listAudit({ resource_id: name, limit: 200 });
    expect(audit.status, JSON.stringify(audit.error)).toBe(200);
    const entries = (
      audit.data.data as unknown as {
        action: string;
        resource_type: string;
        resource_id: string;
      }[]
    ).filter((entry) => entry.action.startsWith("connector.sign"));
    expect(entries.map((entry) => entry.action).sort()).toEqual(
      [
        "connector.sign_in",
        "connector.sign_in",
        "connector.sign_in_failed",
        "connector.signed_in",
      ].sort(),
    );
    for (const entry of entries) {
      expect(entry.resource_type).toBe("plugin");
      expect(entry.resource_id).toBe(name);
    }
  });

  it("ends a pending sign-in with its plugin's removal, and carries none in an archive", async () => {
    provider.answer = granted;
    const removed = await ready("removed");
    const gone = await started(removed.name);
    expect((await owner.removePlugin(removed.name)).status).toBe(200);
    const asked = provider.asked.length;
    expectPage(await arrive({ state: gone.state, code: "c" }), 400);
    expect(provider.asked.length).toBe(asked);

    const kept = await ready("archived");
    const pending = await started(kept.name);
    const archive = await owner.exportArchive({});
    expect(archive.status).toBe(200);
    const text = listEntries(archive.data)
      .map(({ body }) =>
        (body[0] === 0x1f && body[1] === 0x8b
          ? gunzipSync(body)
          : body
        ).toString("utf8"),
      )
      .join("\n");
    // The witness: the archive carries the plugin whose sign-in is pending.
    expect(text).toContain(kept.name);
    for (const held of [
      pending.state,
      pending.challenge,
      createHash("sha256").update(pending.state).digest("hex"),
      createHash("sha256").update(pending.state).digest("base64url"),
      "sign_in_status",
      "connector_sign_in",
    ]) {
      expect(text.includes(held), held).toBe(false);
    }
  });
});

describe("the callback's limit", () => {
  let limited: FreshServer;

  beforeAll(async () => {
    limited = await bootFreshServer("connector-sign-in-limited", {
      MARFA_RATE_LIMIT_ENABLED: "true",
    });
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await limited?.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it(
    "refuses 429 rate_limited callbacks from one address past ten in fifteen minutes",
    { retry: 0 },
    async () => {
      // The retry would start past the limit this test spends.
      for (let tried = 0; tried < 10; tried += 1) {
        const unknown = await arrive({ state: "made-up", code: "c" }, limited);
        expect(unknown.status, String(tried)).toBe(400);
      }
      const spent = await fetch(
        `${limited.apiUrl}/connect/oauth/callback?state=made-up&code=c`,
        { redirect: "manual" },
      );
      expect(spent.status).toBe(429);
      expect(
        ((await spent.json()) as { error: { code: string } }).error.code,
      ).toBe("rate_limited");
    },
  );
});
