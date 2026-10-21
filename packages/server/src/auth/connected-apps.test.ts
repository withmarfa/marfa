import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestContext,
  request,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";
import {
  appKindOf,
  COMMAND_LINE_SOFTWARE_ID,
  findConnectedApp,
  listConnectedApps,
} from "./connected-apps.js";

vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

describe("appKindOf", () => {
  it("reads a client that registered as the command line's software as the command line", () => {
    expect(
      appKindOf({
        applicationType: "native",
        redirectUris: [],
        softwareId: COMMAND_LINE_SOFTWARE_ID,
      }),
    ).toEqual({ kind: "cli", origins: [] });
  });

  it("reads any other client as an app, whatever name or grant it signs in with", () => {
    const native = { applicationType: "native", redirectUris: [] };
    expect(appKindOf({ ...native, softwareId: null })).toEqual({
      kind: "app",
      origins: [],
    });
    expect(appKindOf({ ...native, softwareId: "so.example.tv" })).toEqual({
      kind: "app",
      origins: [],
    });
  });

  it("reads a web client with an https address as a web page, with its origins", () => {
    expect(
      appKindOf({
        applicationType: "web",
        redirectUris: ["https://page.example/callback"],
        softwareId: null,
      }),
    ).toEqual({ kind: "web", origins: ["https://page.example"] });
  });

  it("reads a native client, a web one on the loopback and one that is gone as apps", () => {
    expect(
      appKindOf({
        applicationType: "native",
        redirectUris: ["http://localhost:5173/callback"],
        softwareId: null,
      }),
    ).toEqual({ kind: "app", origins: [] });
    expect(
      appKindOf({
        applicationType: "web",
        redirectUris: ["http://localhost:5173/callback"],
        softwareId: null,
      }),
    ).toEqual({ kind: "app", origins: [] });
    expect(appKindOf(null)).toEqual({ kind: "app", origins: [] });
  });
});

/** Connects a client that registered for the device grant, with `extra` registration fields. */
async function connectDeviceClient(
  c: TestContext,
  name: string,
  extra: Record<string, string>,
): Promise<string> {
  const registered = await request(c.app, "POST", "/auth/oauth2/register", {
    body: {
      client_name: name,
      ...extra,
      application_type: "native",
      grant_types: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
      token_endpoint_auth_method: "none",
      redirect_uris: [`${ORIGIN}/callback`],
      response_types: [],
    },
    headers: { origin: ORIGIN },
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as {
    client_id: string;
  };
  const started = await request(c.app, "POST", "/auth/device/code", {
    form: { client_id: clientId, scope: "core.note:read" },
    headers: { origin: ORIGIN },
  });
  expect(started.status).toBe(200);
  const { user_code: userCode } = (await started.json()) as {
    user_code: string;
  };
  const consent = await request(
    c.app,
    "GET",
    `/auth/device/consent?user_code=${encodeURIComponent(userCode)}`,
    { headers: { cookie: c.owner.cookie } },
  );
  expect(consent.status).toBe(200);
  const decided = await request(c.app, "POST", "/auth/device/consent", {
    form: {
      user_code: userCode,
      decision: "approve",
      scopes: ["core.note:read"],
    },
    headers: { origin: ORIGIN, cookie: c.owner.cookie },
  });
  expect(decided.status).toBe(200);
  return clientId;
}

describe("the connected apps", () => {
  it("lists each approved app with the kind its registration gives it, newest first", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const plain = await seedOauthBearer(c, ["core.note:read"], {
      clientName: "Notes app",
    });
    const page = await seedOauthBearer(c, ["core.note:read"], {
      clientName: "Reader page",
      webRedirectUri: "https://reader.example/callback",
    });
    const cli = await connectDeviceClient(c, "marfa on a laptop", {
      software_id: COMMAND_LINE_SOFTWARE_ID,
    });
    const tv = await connectDeviceClient(c, "marfa", {});

    const apps = await listConnectedApps(c.storage, c.owner.id);
    const byClient = new Map(apps.map((app) => [app.clientId, app]));
    expect(apps).toHaveLength(4);
    expect(byClient.get(plain.clientId)).toMatchObject({
      id: plain.grantId,
      name: "Notes app",
      kind: "app",
      origins: [],
      scopes: ["core.note:read"],
    });
    expect(byClient.get(page.clientId)).toMatchObject({
      name: "Reader page",
      kind: "web",
      origins: ["https://reader.example"],
    });
    expect(byClient.get(cli)).toMatchObject({
      name: "marfa on a laptop",
      kind: "cli",
    });
    // A program with no browser that signs in with the device grant, and
    // names itself "marfa", is still an app: only the software id says
    // which program it is.
    expect(byClient.get(tv)).toMatchObject({ name: "marfa", kind: "app" });
    const times = apps.map((app) => app.grantedAt);
    expect(times).toEqual([...times].sort().reverse());
  });

  it("finds one app by its grant, and none by another id or after it is disconnected", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const seeded = await seedOauthBearer(c, ["core.note:read"]);
    expect(
      (await findConnectedApp(c.storage, c.owner.id, seeded.grantId))?.clientId,
    ).toBe(seeded.clientId);
    expect(await findConnectedApp(c.storage, c.owner.id, "nothing")).toBeNull();

    const ended = await c.ownerRequest(
      `/owner/sign-ins/${encodeURIComponent(seeded.grantId)}`,
      { method: "DELETE" },
    );
    expect(ended.status).toBe(200);
    expect(
      await findConnectedApp(c.storage, c.owner.id, seeded.grantId),
    ).toBeNull();
    expect(await listConnectedApps(c.storage, c.owner.id)).toEqual([]);
  });

  it("lists nothing before the instance has an owner", async () => {
    ctx = await createTestContext({});
    await seedOauthBearer(ctx, ["core.note:read"]);
    expect(await listConnectedApps(ctx.storage, null)).toEqual([]);
  });
});
