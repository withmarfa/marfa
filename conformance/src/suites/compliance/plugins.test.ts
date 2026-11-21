import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  archiveLines,
  archiveManifest,
  emptyManifest,
  lineFile,
  ndjson,
  tar,
} from "../../utils/archive.js";
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
} from "../../utils/signed-in.js";

/**
 * Installing a plugin's bundle, its provenance on the types it registers, a
 * newer version that only adds, removing it, and its record in an archive.
 * Each server is the fixture's own, since a plugin's types are the instance's
 * and an export and a restore are the whole instance's.
 */
const TICKET = "common.ticket";
const SPIKE = "common.ticket.spike";
const EDGE = "blocks";

type Bundle = {
  format: number;
  name: string;
  title: string;
  description: string;
  mark: string;
  maker: string;
  marfa: string;
  version: string;
  types: Record<string, unknown>[];
  edge_types: Record<string, unknown>[];
  connector?: Record<string, unknown>;
  [key: string]: unknown;
};

function ticket(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TICKET,
    parent: "core.task",
    description: "A piece of work someone asked for.",
    guidance: "File one ticket per request.",
    fields: {
      reporter: { type: "string", max_length: 200 },
      kind: { type: "enum", enum_values: ["bug", "chore"] },
      ...extra,
    },
  };
}

function spike(): Record<string, unknown> {
  return {
    id: SPIKE,
    parent: TICKET,
    description: "Time spent finding out.",
    fields: { question: { type: "string" } },
  };
}

function bundle(name: string, fields: Partial<Bundle> = {}): Bundle {
  return {
    format: 1,
    name,
    title: "Tickets",
    description: "Tickets for tracking work.",
    mark: "lucide:ticket",
    maker: "Marfa",
    marfa: "0.0.1",
    version: "1.0.0",
    types: [ticket(), spike()],
    edge_types: [
      { id: EDGE, cardinality: "many-to-many", reverse_name: "blocked-by" },
    ],
    ...fields,
  };
}

/** A bundle of one type of its own, under `root`, so tests do not share types. */
function single(name: string, id: string, fields: Partial<Bundle> = {}) {
  return bundle(name, {
    types: [
      {
        id,
        description: "A thing a plugin brings.",
        fields: { title: { type: "string" } },
      },
    ],
    edge_types: [],
    ...fields,
  });
}

let origin: FreshServer;
let destination: FreshServer;
let owner: MarfaClient;
let elsewhere: MarfaClient;
let minted = 0;

/** A key minted by local authority: an owner's key, holding what it names. */
async function ownerKey(
  server: FreshServer,
  permissions: string[],
  types: Record<string, string> = { "*": "write" },
  edges: Record<string, string> = { "*": "write" },
): Promise<MarfaClient> {
  const local = new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
  const minted = await local.createKey({
    label: "plugins fixture",
    source: `plugins-${String(++minted)}`,
    permissions,
    type_permissions: types,
    edge_permissions: edges,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: minted.data.key! });
}

async function appToken(
  server: FreshServer,
  scope: string,
): Promise<MarfaClient> {
  const issuer = await issuerOrigin(server);
  const app = await registerApp(server, scope);
  const tokens = await connect(
    server,
    issuer,
    await signIn(server, issuer),
    app,
    scope,
  );
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: tokens.access_token,
  });
}

beforeAll(async () => {
  [origin, destination] = await Promise.all([
    bootFreshServer("plugins-origin"),
    bootFreshServer("plugins-destination"),
  ]);
  owner = await ownerKey(origin, ["schema.write", "backups.manage"]);
  elsewhere = await ownerKey(destination, ["schema.write", "backups.manage"]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([origin?.stop(), destination?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

describe("installing a plugin", () => {
  it("installs a bundle and answers 201 with the plugin, its types and its edge types", async () => {
    const installed = await owner.installPlugin(bundle("tickets"));
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
    await expectMatchesSchema("POST", "/plugins", 201, installed.data);
    expect(installed.data).toMatchObject({
      name: "tickets",
      version: "1.0.0",
      title: "Tickets",
      outcome: "installed",
      types: [TICKET, SPIKE],
      edge_types: [EDGE],
      connector: null,
    });
    const edges = await owner.listEdgeTypes();
    expect(edges.data.data.map((held) => held.id)).toContain(EDGE);
  });

  it("reads a type a plugin installed with origin plugin, naming the plugin and its version", async () => {
    const read = await owner.getType(TICKET);
    expect(read.status).toBe(200);
    expect(read.data.provenance).toMatchObject({
      origin: "plugin",
      plugin: { name: "tickets", version: "1.0.0" },
    });
    expect(read.data.guidance).toBe("File one ticket per request.");
    // The witness: a type registered through POST /types reads as registered.
    const made = await owner.registerType({
      id: "user.registered-beside",
      fields: { title: { type: "string" } },
    } as never);
    expect(made.status).toBe(201);
    expect(made.data.provenance).toMatchObject({
      origin: "registered",
      plugin: null,
    });
  });

  it("registers neither type of a bundle whose second type is refused, though the bundle without it installs", async () => {
    const good = {
      id: "acme.first",
      description: "First.",
      fields: { title: { type: "string" } },
    };
    const bad = {
      id: "acme.second",
      description: "Second.",
      fields: { title: { type: "no-such-kind" } },
    };
    const refused = await owner.installPlugin(
      bundle("acme", { types: [good, bad], edge_types: [] }),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    expect(refused.error?.error.details?.type_id).toBe("acme.second");
    expect((await owner.getType("acme.first")).status).toBe(404);
    expect((await owner.getPlugin("acme")).status).toBe(404);
    const witness = await owner.installPlugin(
      bundle("acme", { types: [good], edge_types: [] }),
    );
    expect(witness.status, JSON.stringify(witness.error)).toBe(201);
    expect((await owner.getType("acme.first")).status).toBe(200);
  });

  it("refuses 400 validation_error a bundle with a key it does not hold, a missing field or another format, and keeps a connector object as it is", async () => {
    const { marfa: _marfa, ...lacking } = single("shape", "shape.thing");
    const missing = await owner.installPlugin(lacking);
    expect(missing.status).toBe(400);
    expect(missing.error?.error.code).toBe("validation_error");
    expect(JSON.stringify(missing.error?.error.details)).toContain("marfa");
    const later = await owner.installPlugin(
      single("shape", "shape.thing", { format: 2 }),
    );
    expect(later.status).toBe(400);
    expect(JSON.stringify(later.error?.error.details)).toContain("format");
    expect((await owner.getPlugin("shape")).status).toBe(404);
    const refused = await owner.installPlugin({
      ...single("extra-key", "extra.thing"),
      shipped_by: "someone",
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(JSON.stringify(refused.error?.error.details)).toContain(
      "shipped_by",
    );
    const connector = { any: ["shape", 1], the: { connector: "defines" } };
    const taken = await owner.installPlugin(
      single("extra-key", "extra.thing", { connector }),
    );
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
    expect(taken.data.connector).toEqual(connector);
  });

  it("refuses 403 forbidden a bundle with a type under a root kept for Marfa, apps or the owner, naming the namespace", async () => {
    for (const root of ["core", "system", "marfa", "app", "user"]) {
      const refused = await owner.installPlugin(
        single(`reserved-${root}`, `${root}.plugin-thing`),
      );
      expect(refused.status, root).toBe(403);
      expect(refused.error?.error.code).toBe("forbidden");
      expect(refused.error?.error.details?.namespace).toBe(root);
    }
    // The witness: the same bundle under a plugin's own root installs.
    const taken = await owner.installPlugin(
      single("reserved-witness", "witness.plugin-thing"),
    );
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
  });

  it("installs a bundle that names any Marfa on a development build", async () => {
    const taken = await owner.installPlugin(
      single("needs-later", "later.thing", { marfa: "99.0.0" }),
    );
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
    expect(taken.data.marfa).toBe("99.0.0");
  });

  it("refuses 403 a key without schema.write, one without write on a type of the bundle, and one without write on an edge type", async () => {
    const thing = single("permission", "permission.thing", {
      edge_types: [{ id: "permits", cardinality: "many-to-many" }],
    });
    const lacking = await ownerKey(origin, ["backups.manage"]);
    const refused = await lacking.installPlugin(thing);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.details?.required_scope).toBe("schema.write");
    const narrow = await ownerKey(origin, ["schema.write"], {
      "other.*": "write",
    });
    const denied = await narrow.installPlugin(thing);
    expect(denied.status).toBe(403);
    expect(denied.error?.error.code).toBe("type_not_permitted");
    const edgeless = await ownerKey(
      origin,
      ["schema.write"],
      { "*": "write" },
      { other: "write" },
    );
    const withheld = await edgeless.installPlugin(thing);
    expect(withheld.status).toBe(403);
    expect(withheld.error?.error.code).toBe("edge_type_not_permitted");
    expect((await owner.getType("permission.thing")).status).toBe(404);
    // The witness: a key holding all three installs it.
    const taken = await owner.installPlugin(thing);
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
  });

  it("answers the first refusal in order: the bundle's shape before a reserved root, and a reserved root before the permission", async () => {
    const lacking = await ownerKey(origin, ["backups.manage"]);
    const both = await lacking.installPlugin({
      ...single("ordered", "user.ordered-thing"),
      extra: true,
    });
    expect(both.status).toBe(400);
    expect(both.error?.error.code).toBe("validation_error");
    const reserved = await lacking.installPlugin(
      single("ordered", "user.ordered-thing"),
    );
    expect(reserved.status).toBe(403);
    expect(reserved.error?.error.details?.namespace).toBe("user");
    // The witness: with neither, the permission is what is refused.
    const permission = await lacking.installPlugin(
      single("ordered", "ordered.thing"),
    );
    expect(permission.status).toBe(403);
    expect(permission.error?.error.details?.required_scope).toBe(
      "schema.write",
    );
  });

  it("installs a type under another plugin's common type with no write on it, and refuses one under an owner's type", async () => {
    const owned = await owner.registerType({
      id: "owned.parent",
      fields: { title: { type: "string" } },
    } as never);
    expect(owned.status).toBe(201);
    const narrow = await ownerKey(origin, ["schema.write"], {
      "child.*": "write",
    });
    const under = (parent: string) =>
      single("child-plugin", "child.thing", {
        types: [
          {
            id: "child.thing",
            parent,
            description: "A child.",
            fields: { note: { type: "string" } },
          },
        ],
      });
    const refused = await narrow.installPlugin(under("owned.parent"));
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");
    const taken = await narrow.installPlugin(under(TICKET));
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
  });

  it("refuses 409 conflict an edge type the instance holds in another shape", async () => {
    const refused = await owner.installPlugin(
      single("edge-clash", "edgeclash.thing", {
        edge_types: [{ id: EDGE, cardinality: "one-to-one" }],
      }),
    );
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("conflict");
    expect(refused.error?.error.details?.edge_type).toBe(EDGE);
    expect((await owner.getType("edgeclash.thing")).status).toBe(404);
  });

  it("refuses 409 type_exists a bundle with a type the plugin did not install", async () => {
    const made = await owner.registerType({
      id: "taken.thing",
      fields: { title: { type: "string" } },
    } as never);
    expect(made.status).toBe(201);
    const refused = await owner.installPlugin(single("taken", "taken.thing"));
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("type_exists");
    expect(refused.error?.error.details?.type_id).toBe("taken.thing");
  });
});

describe("a newer version of an installed plugin", () => {
  it("answers 200 unchanged to the same version again, and 409 plugin_version_older to an older one", async () => {
    const again = await owner.installPlugin(bundle("tickets"));
    expect(again.status).toBe(200);
    expect(again.data.outcome).toBe("unchanged");
    const older = await owner.installPlugin(
      bundle("tickets", { version: "0.9.0" }),
    );
    expect(older.status).toBe(409);
    expect(older.error?.error.code).toBe("plugin_version_older");
    expect(older.error?.error.details).toMatchObject({
      installed: "1.0.0",
      version: "0.9.0",
    });
  });

  it("refuses 409 plugin_narrows a version that drops a field or a type, naming each, and keeps the type as installed", async () => {
    const without = await owner.installPlugin(
      bundle("tickets", { version: "1.1.0", types: [ticket()] }),
    );
    expect(without.status).toBe(409);
    expect(without.error?.error.details?.changes).toEqual([
      expect.objectContaining({ type: SPIKE, path: "" }),
    ]);
    const dropped = ticket();
    delete (dropped.fields as Record<string, unknown>).reporter;
    const refused = await owner.installPlugin(
      bundle("tickets", { version: "1.1.0", types: [dropped, spike()] }),
    );
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("plugin_narrows");
    expect(refused.error?.error.details?.changes).toEqual([
      expect.objectContaining({ type: TICKET, path: "fields.reporter" }),
    ]);
    const read = await owner.getType(TICKET);
    expect(read.data.fields).toHaveProperty("reporter");
    expect(read.data.provenance?.plugin?.version).toBe("1.0.0");
  });

  it("refuses 409 plugin_child_conflict a version that gives a field an owner's child declares in another shape, naming the child", async () => {
    const child = await owner.registerType({
      id: "user.ticket-child",
      parent: TICKET,
      fields: { severity: { type: "integer" } },
    } as never);
    expect(child.status, JSON.stringify(child.error)).toBe(201);
    const refused = await owner.installPlugin(
      bundle("tickets", {
        version: "1.2.0",
        types: [ticket({ severity: { type: "string" } }), spike()],
      }),
    );
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("plugin_child_conflict");
    expect(refused.error?.error.details?.conflicts).toEqual([
      expect.objectContaining({
        type: "user.ticket-child",
        field: "severity",
        inherited_from: TICKET,
      }),
    ]);
    expect(refused.error?.error.message).toContain("user.ticket-child");
    expect((await owner.deleteType("user.ticket-child")).status).toBe(200);
  });

  it("takes a version that adds a field, a status word and an enum value, and reads the new version on its types", async () => {
    const grown = ticket({
      kind: { type: "enum", enum_values: ["bug", "chore", "spike"] },
      estimate: { type: "integer" },
    });
    const updated = await owner.installPlugin(
      bundle("tickets", { version: "1.3.0", types: [grown, spike()] }),
    );
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    expect(updated.data.outcome).toBe("updated");
    const read = await owner.getType(TICKET);
    expect(read.data.fields).toHaveProperty("estimate");
    expect(read.data.provenance?.plugin?.version).toBe("1.3.0");
    expect((await owner.getType(SPIKE)).data.provenance?.plugin?.version).toBe(
      "1.3.0",
    );
  });
});

describe("listing and removing plugins", () => {
  it("lists and reads installed plugins, and answers 404 plugin_not_found for one not installed", async () => {
    const listed = await owner.listPlugins();
    expect(listed.status).toBe(200);
    await expectMatchesSchema("GET", "/plugins", 200, listed.data);
    expect(listed.data.data.map((held) => held.name)).toContain("tickets");
    const read = await owner.getPlugin("tickets");
    expect(read.status).toBe(200);
    await expectMatchesSchema("GET", "/plugins/{name}", 200, read.data);
    expect(read.data).toMatchObject({ name: "tickets", version: "1.3.0" });
    const missing = await owner.getPlugin("no-such-plugin");
    expect(missing.status).toBe(404);
    expect(missing.error?.error.code).toBe("plugin_not_found");
  });

  it("removes a plugin's record and keeps its types, which keep their provenance, saying what it removed and kept", async () => {
    const installed = await owner.installPlugin(
      single("removable", "removable.thing"),
    );
    expect(installed.status).toBe(201);
    const lacking = await ownerKey(origin, ["backups.manage"]);
    const refused = await lacking.removePlugin("removable");
    expect(refused.status).toBe(403);
    expect(refused.error?.error.details?.required_scope).toBe("schema.write");
    expect((await owner.getPlugin("removable")).status).toBe(200);
    const removed = await owner.removePlugin("removable");
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    await expectMatchesSchema("DELETE", "/plugins/{name}", 200, removed.data);
    expect(removed.data).toEqual({
      removed: { name: "removable", version: "1.0.0" },
      kept: { types: ["removable.thing"], edge_types: [] },
    });
    expect((await owner.getPlugin("removable")).status).toBe(404);
    const kept = await owner.getType("removable.thing");
    expect(kept.status).toBe(200);
    expect(kept.data.provenance?.plugin).toEqual({
      name: "removable",
      version: "1.0.0",
    });
    expect((await owner.removePlugin("removable")).status).toBe(404);
  });
});

describe("plugins in an archive", () => {
  it("keeps plugin provenance and the install record through an export and a restore", async () => {
    const archive = await owner.exportArchive({ state: "any" });
    expect(archive.status).toBe(200);
    expect(archiveManifest(archive.data).version).toBe(2);
    const plugins = archiveLines(archive.data, "instance").filter(
      (line) => "plugin" in line,
    );
    expect(
      plugins.map((line) => (line.plugin as { name: string }).name),
    ).toContain("tickets");
    const local = new MarfaClient({
      baseUrl: destination.apiUrl,
      controlSocket: destination.controlSocket,
    });
    const restored = await local.restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({ plugins_added: plugins.length });
    const read = await elsewhere.getType(TICKET);
    expect(read.data.provenance).toMatchObject({
      origin: "plugin",
      plugin: { name: "tickets", version: "1.3.0" },
    });
    const record = await elsewhere.getPlugin("tickets");
    expect(record.status).toBe(200);
    expect(record.data).toMatchObject({
      version: "1.3.0",
      types: [TICKET, SPIKE],
    });
    expect(
      (await elsewhere.getType("user.registered-beside")).data.provenance
        ?.origin,
    ).toBe("registered");
  });

  it("restores a version 1 archive whose type names the origin user as registered", async () => {
    const id = "user.from-version-one";
    const archive = tar([
      {
        name: "manifest.json",
        body: JSON.stringify(emptyManifest({ version: 1, type_count: 1 })),
      },
      lineFile("files", ""),
      lineFile(
        "instance",
        ndjson([
          {
            type: { id, fields: { title: { type: "string" } } },
            provenance: { origin: "user", created_by: null },
          },
        ]),
      ),
      lineFile("items", ""),
      lineFile("versions", ""),
      lineFile("edges", ""),
      lineFile("rows", ""),
    ]);
    const local = new MarfaClient({
      baseUrl: destination.apiUrl,
      controlSocket: destination.controlSocket,
    });
    const restored = await local.restoreArchive(archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect((await elsewhere.getType(id)).data.provenance?.origin).toBe(
      "registered",
    );
  });

  it("refuses a version 2 archive whose type names the origin user", async () => {
    const id = "user.user-in-version-two";
    const lines = (origin: string) =>
      tar([
        {
          name: "manifest.json",
          body: JSON.stringify(
            emptyManifest({ version: 2, type_count: 1, plugin_count: 0 }),
          ),
        },
        lineFile("files", ""),
        lineFile(
          "instance",
          ndjson([
            {
              type: { id, fields: { title: { type: "string" } } },
              provenance: { origin, created_by: null },
            },
          ]),
        ),
        lineFile("items", ""),
        lineFile("versions", ""),
        lineFile("edges", ""),
        lineFile("rows", ""),
      ]);
    const local = new MarfaClient({
      baseUrl: destination.apiUrl,
      controlSocket: destination.controlSocket,
    });
    const refused = await local.restoreArchive(lines("user"));
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect((await elsewhere.getType(id)).status).toBe(404);
    // The witness: the same archive naming registered restores.
    const restored = await local.restoreArchive(lines("registered"));
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
  });
});

describe("who writes a type's guidance", () => {
  it("refuses guidance to an app holding user.*:write and schema.write, and takes the same registration without it", async () => {
    const app = await appToken(
      origin,
      "user.*:write metadata.types:write schema.write",
    );
    const refused = await app.registerType({
      id: "user.app-guided",
      guidance: "Use it.",
      fields: { title: { type: "string" } },
    } as never);
    expect(refused.status, JSON.stringify(refused.error)).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");
    expect(refused.error?.error.details?.changes).toEqual(["guidance"]);
    expect((await owner.getType("user.app-guided")).status).toBe(404);
    const plain = await app.registerType({
      id: "user.app-guided",
      fields: { title: { type: "string" } },
    } as never);
    expect(plain.status, JSON.stringify(plain.error)).toBe(201);
  });

  it("refuses an app's replacement that adds guidance, and lets an owner's key add it", async () => {
    const app = await appToken(
      origin,
      "user.*:write metadata.types:write schema.write",
    );
    const made = await app.registerType({
      id: "user.app-replaced",
      fields: { title: { type: "string" } },
    } as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const body = {
      id: "user.app-replaced",
      guidance: "Use it.",
      fields: { title: { type: "string" } },
    };
    const refused = await app.replaceType("user.app-replaced", body);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.details?.changes).toEqual(["guidance"]);
    const taken = await owner.replaceType("user.app-replaced", body);
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
    expect(taken.data.guidance).toBe("Use it.");
  });

  it("lets an app holding schema.write install a plugin whose types carry guidance", async () => {
    const app = await appToken(origin, "guided.*:write schema.write");
    const installed = await app.installPlugin(
      single("guided-by-app", "guided.thing", {
        types: [
          {
            id: "guided.thing",
            description: "A guided thing.",
            guidance: "Installing writes this.",
            fields: { title: { type: "string" } },
          },
        ],
      }),
    );
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
    expect((await owner.getType("guided.thing")).data.guidance).toBe(
      "Installing writes this.",
    );
  });
});
