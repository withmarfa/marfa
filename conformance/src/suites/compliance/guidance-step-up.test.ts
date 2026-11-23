import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
  token,
  type App,
} from "../../utils/signed-in.js";

/**
 * Who writes a type's guidance: an app's access token while its owner signed
 * in recently, a key the owner made, never a key an app made. The server is the
 * fixture's own, since the tests move its clock.
 */
let server: FreshServer;
let issuer: string;
let owner: MarfaClient;
let ownerKey: string;

const MINUTE = 60 * 1000;
const RECENT_MS = 15 * MINUTE;
/** Long enough that a sign-in made before it is no longer recent. */
const PAST_RECENT = RECENT_MS + MINUTE;
const CHALLENGE =
  'Bearer error="insufficient_user_authentication", max_age="900"';

beforeAll(async () => {
  server = await bootFreshServer("guidance-step-up");
  issuer = await issuerOrigin(server);
  const local = new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
  const minted = await local.createKey({
    label: "guidance step-up owner",
    source: `guidance-step-up-${randomUUID()}`,
    permissions: ["schema.write", "connectors.manage", "keys.manage"],
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
    metadata_permissions: { "*": "write" },
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  ownerKey = minted.data.key!;
  owner = new MarfaClient({ baseUrl: server.apiUrl, apiKey: ownerKey });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

// The owner may sign in a limited number of times in a window, so each test
// starts past the last one's.
beforeEach(async () => {
  await server.advanceClock(PAST_RECENT);
});

interface Answer {
  status: number;
  challenge: string | null;
  body: Record<string, any>;
}

async function call(
  credential: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const response = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    challenge: response.headers.get("www-authenticate"),
    body: (text === "" ? {} : JSON.parse(text)) as Record<string, any>,
  };
}

/** A part of a name that no earlier run of a test body on this server used. */
function fresh(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

/** A root the owner holds a type under, which an app may then be granted. */
async function seeded(): Promise<string> {
  const root = `guide${fresh()}`;
  const made = await owner.registerType({
    id: `${root}.seed`,
    fields: { title: { type: "string" } },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return root;
}

interface Signed {
  app: App;
  access: string;
  refresh: string;
}

/** An app holding `scope`, and the tokens of a sign-in made just now. */
async function signedIn(scope: string, app?: App): Promise<Signed> {
  const held = app ?? (await registerApp(server, `${scope} offline_access`));
  const tokens = await connect(
    server,
    issuer,
    await signIn(server, issuer),
    held,
    `${scope} offline_access`,
  );
  return {
    app: held,
    access: tokens.access_token!,
    refresh: tokens.refresh_token!,
  };
}

async function refreshed(signed: Signed): Promise<Signed> {
  const answer = await token(server, {
    grant_type: "refresh_token",
    refresh_token: signed.refresh,
    client_id: signed.app.clientId,
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return {
    app: signed.app,
    access: answer.body.access_token!,
    refresh: answer.body.refresh_token!,
  };
}

function expectChallenged(answer: Answer, name: string): void {
  expect(answer.status, `${name} ${JSON.stringify(answer.body)}`).toBe(401);
  expect(answer.challenge, name).toBe(CHALLENGE);
  expect(answer.body.error.code, name).toBe("insufficient_user_authentication");
  expect(answer.body.error.details, name).toEqual({ max_age: 900 });
}

function expectRefusedGuidance(answer: Answer, name: string): void {
  expect(answer.status, `${name} ${JSON.stringify(answer.body)}`).toBe(403);
  expect(answer.challenge, name).toBeNull();
  expect(answer.body.error.code, name).toBe("forbidden");
  expect(answer.body.error.details?.changes, name).toEqual(["guidance"]);
}

async function guidanceOf(id: string): Promise<unknown> {
  const read = await owner.getType(id);
  expect(read.status, `${id} ${JSON.stringify(read.error)}`).toBe(200);
  return read.data.guidance;
}

const TYPE_SCOPE = "user.*:write metadata.types:write schema.write";

function typeBody(
  id: string,
  guidance?: string,
  extra = false,
  parent?: string,
) {
  return {
    id,
    ...(parent === undefined ? {} : { parent }),
    ...(guidance === undefined ? {} : { guidance }),
    fields: {
      title: { type: "string" },
      ...(extra ? { note: { type: "string" } } : {}),
    },
  };
}

describe("an app's token writing a type's guidance", () => {
  it("adds, changes and removes guidance at POST /types and PUT /types/{id} when its owner signed in within fifteen minutes", async () => {
    const { access } = await signedIn(TYPE_SCOPE);
    const id = `user.guided-${fresh()}`;
    const added = await call(access, "POST", "/types", typeBody(id, "One."));
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(await guidanceOf(id)).toBe("One.");
    const changed = await call(
      access,
      "PUT",
      `/types/${id}`,
      typeBody(id, "Two."),
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(await guidanceOf(id)).toBe("Two.");
    const removed = await call(access, "PUT", `/types/${id}`, typeBody(id));
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(await guidanceOf(id)).toBeUndefined();
  });

  it("is challenged at POST /types and PUT /types/{id} with 401 insufficient_user_authentication, max_age and the header once its owner signed in more than fifteen minutes ago, and writes nothing", async () => {
    const { access } = await signedIn(TYPE_SCOPE);
    const id = `user.guided-${fresh()}`;
    // The witness: the same token wrote guidance while its sign-in was recent.
    const made = await call(access, "POST", "/types", typeBody(id, "Kept."));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    await server.advanceClock(PAST_RECENT);

    const other = `user.guided-${fresh()}`;
    const registered = await call(
      access,
      "POST",
      "/types",
      typeBody(other, "New."),
    );
    expectChallenged(registered, "registration");
    await expectMatchesSchema("POST", "/types", 401, registered.body);
    expect((await owner.getType(other)).status).toBe(404);
    const changed = await call(
      access,
      "PUT",
      `/types/${id}`,
      typeBody(id, "Changed.", true),
    );
    expectChallenged(changed, "change");
    await expectMatchesSchema("PUT", "/types/{id}", 401, changed.body);
    const removed = await call(
      access,
      "PUT",
      `/types/${id}`,
      typeBody(id, undefined, true),
    );
    expectChallenged(removed, "removal");
    const read = await owner.getType(id);
    expect(read.data.guidance).toBe("Kept.");
    expect(read.data.fields).not.toHaveProperty("note");

    // The same token still registers a type that carries no guidance.
    const plain = await call(access, "POST", "/types", typeBody(other));
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
  });

  it("writes guidance at exactly fifteen minutes after its owner signed in and is challenged one millisecond later", async () => {
    await server.pauseClock(true);
    const id = `user.guided-${fresh()}`;
    try {
      const { access } = await signedIn(TYPE_SCOPE);
      await server.advanceClock(RECENT_MS);
      const atEdge = await call(
        access,
        "POST",
        "/types",
        typeBody(id, "Edge."),
      );
      expect(atEdge.status, JSON.stringify(atEdge.body)).toBe(201);
      await server.advanceClock(1);
      expectChallenged(
        await call(access, "PUT", `/types/${id}`, typeBody(id, "Past.")),
        "one millisecond past the edge",
      );
    } finally {
      await server.pauseClock(false);
    }
    expect(await guidanceOf(id)).toBe("Edge.");
  });

  it("is challenged when its owner's sign-in is dated after the request, as when the server's clock is set back", async () => {
    const jump = async (ms: number): Promise<void> => {
      const moved = await controlRequest(
        server.controlSocket,
        "/_control/test/clock",
        { method: "POST", body: { jump_ms: ms } },
      );
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    };
    const { access } = await signedIn(TYPE_SCOPE);
    const id = `user.guided-${fresh()}`;
    // The witness: before the clock goes back, the token writes guidance.
    const made = await call(access, "POST", "/types", typeBody(id, "Before."));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    await jump(-2 * MINUTE);
    try {
      expectChallenged(
        await call(access, "PUT", `/types/${id}`, typeBody(id, "Behind.")),
        "a sign-in dated after the request",
      );
    } finally {
      await jump(2 * MINUTE);
    }
    expect(await guidanceOf(id)).toBe("Before.");
  });

  it("keeps its owner's sign-in time through a refresh, so the refreshed token is challenged at guidance fifteen minutes after the sign-in", async () => {
    const first = await signedIn(TYPE_SCOPE);
    const id = `user.guided-${fresh()}`;
    await server.advanceClock(14 * MINUTE);
    const second = await refreshed(first);
    // The witness: within fifteen minutes of the sign-in the refreshed token writes guidance.
    const made = await call(
      second.access,
      "POST",
      "/types",
      typeBody(id, "Fresh."),
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    await server.advanceClock(2 * MINUTE);
    const third = await refreshed(second);
    for (const access of [second.access, third.access]) {
      expectChallenged(
        await call(access, "PUT", `/types/${id}`, typeBody(id, "Refreshed.")),
        "refreshed",
      );
    }
    expect(await guidanceOf(id)).toBe("Fresh.");
  });

  it("is not challenged at a replacement that leaves the type's guidance as stored, however long ago its owner signed in", async () => {
    const id = `user.guided-${fresh()}`;
    const made = await owner.registerType(typeBody(id, "Stays.") as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const { access } = await signedIn(TYPE_SCOPE);
    await server.advanceClock(PAST_RECENT);
    // The witness: the same token is challenged at a change to the guidance.
    expectChallenged(
      await call(access, "PUT", `/types/${id}`, typeBody(id, "Moved.", true)),
      "a change",
    );
    const kept = await call(
      access,
      "PUT",
      `/types/${id}`,
      typeBody(id, "Stays.", true),
    );
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    const read = await owner.getType(id);
    expect(read.data.guidance).toBe("Stays.");
    expect(read.data.fields).toHaveProperty("note");
  });

  it("refuses an app's token without schema.write 403 naming it, never a challenge, however long ago its owner signed in", async () => {
    const { access } = await signedIn("user.*:write metadata.types:write");
    await server.advanceClock(PAST_RECENT);
    const id = `user.guided-${fresh()}`;
    const refused = await call(access, "POST", "/types", typeBody(id, "No."));
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.challenge).toBeNull();
    expect(refused.body.error.details?.required_scope).toBe("schema.write");
    expect((await owner.getType(id)).status).toBe(404);
    // The witness: the same token registers the type without guidance.
    const plain = await call(access, "POST", "/types", typeBody(id));
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
  });

  it("refuses a stale app that may write the type but not its parent with 403 type_not_permitted and no challenge, on register and on replace", async () => {
    const { access } = await signedIn(
      "user.*:write metadata.types:write schema.write",
    );
    await server.advanceClock(PAST_RECENT);
    const parent = `ghost${fresh()}.missing`;
    const denied = `user.denied-${fresh()}`;
    const shipped = `user.shipped-${fresh()}`;

    // The witness: the same token is challenged when the registration names no parent.
    expectChallenged(
      await call(access, "POST", "/types", typeBody(shipped, "Asked.")),
      "no parent",
    );
    expect((await owner.getType(shipped)).status).toBe(404);

    const registered = await call(
      access,
      "POST",
      "/types",
      typeBody(denied, "No.", false, parent),
    );
    expect(registered.status, JSON.stringify(registered.body)).toBe(403);
    expect(registered.challenge).toBeNull();
    expect(registered.body.error.code).toBe("type_not_permitted");
    expect(registered.body.error.details?.grant).toEqual({
      kind: "type",
      name: parent,
      level: "write",
    });
    expect((await owner.getType(denied)).status).toBe(404);

    const kept = `user.kept-${fresh()}`;
    const made = await owner.registerType(typeBody(kept, "Kept.") as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    expectChallenged(
      await call(access, "PUT", `/types/${kept}`, typeBody(kept, "Moved.")),
      "guidance alone",
    );
    const replaced = await call(
      access,
      "PUT",
      `/types/${kept}`,
      typeBody(kept, "Moved.", false, parent),
    );
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(403);
    expect(replaced.challenge).toBeNull();
    expect(replaced.body.error.code).toBe("type_not_permitted");
    expect(replaced.body.error.details?.grant).toEqual({
      kind: "type",
      name: parent,
      level: "write",
    });
    const read = await owner.getType(kept);
    expect(read.status).toBe(200);
    expect(read.data.guidance).toBe("Kept.");
    expect(read.data.parent).toBeUndefined();
  });
});

/** A plugin of five guided types under `root`, an edge type and a connector, as Tickets is. */
function guidedBundle(
  name: string,
  root: string,
  version = "1.0.0",
  guidance: (n: number) => string | undefined = (n) => `Guide ${String(n)}.`,
) {
  return {
    format: 1,
    name,
    title: "Guided",
    description: "Several guided types.",
    mark: "lucide:ticket",
    maker: "Marfa",
    marfa: "0.0.1",
    version,
    types: [1, 2, 3, 4, 5].map((n) => {
      const text = guidance(n);
      return {
        id: `${root}.kind${String(n)}`,
        description: "A guided kind.",
        ...(text === undefined ? {} : { guidance: text }),
        fields: { title: { type: "string" } },
      };
    }),
    edge_types: [{ id: `${name}-link`, cardinality: "many-to-many" }],
    connector: {
      source: `${name}-feed`,
      source_name: "A service",
      kinds: [{ name: "entry", type: `${root}.kind1`, direction: "in" }],
      runs: { on: "host" },
    },
  };
}

function pluginScope(root: string): string {
  return `${root}.*:write edge.*:write schema.write connectors.manage`;
}

async function edgeTypeIds(): Promise<string[]> {
  const listed = await owner.listEdgeTypes();
  expect(listed.status).toBe(200);
  return listed.data.data.map((held) => held.id);
}

describe("an app's token installing a plugin whose types carry guidance", () => {
  it("installs five guided types, an edge type and a connector when its owner signed in just now, and a challenged install writes no type, edge type, connector or plugin record", async () => {
    const root = await seeded();
    const name = `guided-${fresh()}`;
    const bundle = guidedBundle(name, root);
    const stale = await signedIn(pluginScope(root));
    await server.advanceClock(PAST_RECENT);
    const challenged = await call(stale.access, "POST", "/plugins", bundle);
    expectChallenged(challenged, "install");
    await expectMatchesSchema("POST", "/plugins", 401, challenged.body);
    expect((await owner.getPlugin(name)).status).toBe(404);
    expect(
      (await call(ownerKey, "GET", `/plugins/${name}/connector`)).status,
    ).toBe(404);
    for (const type of bundle.types) {
      expect((await owner.getType(type.id)).status, type.id).toBe(404);
    }
    expect(await edgeTypeIds()).not.toContain(`${name}-link`);

    // The same app, after its owner signs in again, installs the whole bundle.
    const recent = await signedIn(pluginScope(root), stale.app);
    const installed = await call(recent.access, "POST", "/plugins", bundle);
    expect(installed.status, JSON.stringify(installed.body)).toBe(201);
    for (const [n, type] of bundle.types.entries()) {
      expect(await guidanceOf(type.id)).toBe(`Guide ${String(n + 1)}.`);
    }
    expect(await edgeTypeIds()).toContain(`${name}-link`);
    const plugin = await owner.getPlugin(name);
    expect(plugin.status).toBe(200);
    expect(plugin.data.connector).toEqual(bundle.connector);
    expect(
      (await call(ownerKey, "GET", `/plugins/${name}/connector`)).status,
    ).toBe(200);
  });

  it("is challenged at an upgrade that changes or removes guidance and writes nothing, upgrades for a recent sign-in, and is never challenged at an upgrade that leaves guidance as stored", async () => {
    const root = await seeded();
    const name = `guided-${fresh()}`;
    const installed = await owner.installPlugin(
      guidedBundle(name, root) as never,
    );
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
    const stale = await signedIn(pluginScope(root));
    await server.advanceClock(PAST_RECENT);

    const same = await call(
      stale.access,
      "POST",
      "/plugins",
      guidedBundle(name, root, "1.1.0"),
    );
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    for (const [version, guidance] of [
      ["1.2.0", (n: number) => (n === 3 ? "Changed." : `Guide ${String(n)}.`)],
      ["1.2.0", (n: number) => (n === 3 ? undefined : `Guide ${String(n)}.`)],
    ] as const) {
      expectChallenged(
        await call(
          stale.access,
          "POST",
          "/plugins",
          guidedBundle(name, root, version, guidance),
        ),
        `upgrade to ${version}`,
      );
    }
    expect((await owner.getPlugin(name)).data.version).toBe("1.1.0");
    expect(await guidanceOf(`${root}.kind3`)).toBe("Guide 3.");

    const recent = await signedIn(pluginScope(root), stale.app);
    const upgraded = await call(
      recent.access,
      "POST",
      "/plugins",
      guidedBundle(name, root, "1.2.0", (n) =>
        n === 3 ? undefined : `Guide ${String(n)}.`,
      ),
    );
    expect(upgraded.status, JSON.stringify(upgraded.body)).toBe(200);
    expect(await guidanceOf(`${root}.kind3`)).toBeUndefined();
    expect(await guidanceOf(`${root}.kind2`)).toBe("Guide 2.");
  });
});

describe("a key writing a type's guidance", () => {
  it("writes guidance through a key the owner made, and refuses a key an app made 403 with details.changes at a registration and an install", async () => {
    const root = await seeded();
    const owned = await call(
      server.workingKey,
      "POST",
      "/types",
      typeBody(`${root}.owned`, "Owner's."),
    );
    // The working key is one the owner made, through the private local command.
    expect(owned.status, JSON.stringify(owned.body)).toBe(201);
    expect(await guidanceOf(`${root}.owned`)).toBe("Owner's.");

    const { access } = await signedIn(
      `${root}.*:write metadata.types:write schema.write keys.mint`,
    );
    const minted = await call(access, "POST", "/keys", {
      label: "made by an app",
      source: `guidance-step-up-${fresh()}`,
      permissions: ["schema.write"],
      type_permissions: { [`${root}.*`]: "write" },
      metadata_permissions: { types: "write" },
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const key = minted.body.key as string;
    const id = `${root}.made`;
    expectRefusedGuidance(
      await call(key, "POST", "/types", typeBody(id, "App's.")),
      "registration",
    );
    expect((await owner.getType(id)).status).toBe(404);
    const name = `guided-${fresh()}`;
    const bundle = {
      ...guidedBundle(name, root),
      types: [
        {
          id: `${root}.installed`,
          description: "A guided kind.",
          guidance: "App's.",
          fields: { title: { type: "string" } },
        },
      ],
      edge_types: [],
      connector: undefined,
    };
    expectRefusedGuidance(
      await call(key, "POST", "/plugins", bundle),
      "install",
    );
    expect((await owner.getPlugin(name)).status).toBe(404);
    // The witness: the same key registers and installs without guidance.
    const plain = await call(key, "POST", "/types", typeBody(id));
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    const bare = await call(key, "POST", "/plugins", {
      ...bundle,
      types: [{ ...bundle.types[0], guidance: undefined }],
    });
    expect(bare.status, JSON.stringify(bare.body)).toBe(201);
  });
});
