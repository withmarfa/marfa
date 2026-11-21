import { createHash, randomUUID } from "node:crypto";
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

/** A part of a name or id that no earlier run of a test body on this server used. */
function fresh(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

let origin: FreshServer;
let destination: FreshServer;
let owner: MarfaClient;
let elsewhere: MarfaClient;
let keysMinted = 0;

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
    source: `plugins-${String(++keysMinted)}`,
    permissions,
    type_permissions: types,
    edge_permissions: edges,
    metadata_permissions: { "*": "write" },
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
  owner = await ownerKey(origin, [
    "schema.write",
    "backups.manage",
    "connectors.manage",
  ]);
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

  it("refuses 400 validation_error a bundle with a key it does not hold, a missing field or another format", async () => {
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
    // The witness: the same bundle without the key installs.
    const taken = await owner.installPlugin(single("extra-key", "extra.thing"));
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
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

  it("refuses 403 a key without write on an edge type's reverse name, as registering the edge type does", async () => {
    const thing = single("reverse-permission", "reversepermission.thing", {
      edge_types: [
        {
          id: "guards",
          cardinality: "many-to-many",
          reverse_name: "guarded-by",
        },
      ],
    });
    const forwardOnly = await ownerKey(
      origin,
      ["schema.write"],
      { "*": "write" },
      { guards: "write" },
    );
    const refused = await forwardOnly.installPlugin(thing);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("edge_type_not_permitted");
    expect((await owner.getType("reversepermission.thing")).status).toBe(404);
    // The witness: a key holding both names installs it.
    const both = await ownerKey(
      origin,
      ["schema.write"],
      { "*": "write" },
      { guards: "write", "guarded-by": "write" },
    );
    const taken = await both.installPlugin(thing);
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
  });

  it("refuses 409 conflict a bundle whose edge type redefines a shipped one, and 400 missing_required_field a type with no fields, as registration does", async () => {
    const shipped = await owner.installPlugin(
      single("shipped-edge", "shippededge.thing", {
        edge_types: [{ id: "about", cardinality: "many-to-many" }],
      }),
    );
    expect(shipped.status).toBe(409);
    expect(shipped.error?.error.code).toBe("conflict");
    expect(shipped.error?.error.details?.edge_type).toBe("about");
    const fieldless = await owner.installPlugin(
      single("fieldless", "fieldless.thing", {
        types: [{ id: "fieldless.thing", description: "No fields." }],
      }),
    );
    expect(fieldless.status).toBe(400);
    expect(fieldless.error?.error.code).toBe("missing_required_field");
    expect(fieldless.error?.error.details?.type_id).toBe("fieldless.thing");
    const registered = await owner.registerType({
      id: "fieldless.registered",
    } as never);
    expect(registered.error?.error.code).toBe("missing_required_field");
  });

  it("refuses 409 conflict a bundle that changes the label of an edge type another source registered, and takes it with the labels as registered", async () => {
    const made = await owner.registerEdgeType({
      id: "relabelled",
      cardinality: "many-to-many",
      label: "Relabelled",
      reverse_name: "relabelled-by",
      reverse_label: "Relabelled by",
    } as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const edge = (label: string) =>
      single("relabel", "relabel.thing", {
        edge_types: [
          {
            id: "relabelled",
            cardinality: "many-to-many",
            label,
            reverse_name: "relabelled-by",
            reverse_label: "Relabelled by",
          },
        ],
      });
    const refused = await owner.installPlugin(edge("Something else"));
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("conflict");
    expect(refused.error?.error.details?.changes).toEqual(["label"]);
    const taken = await owner.installPlugin(edge("Relabelled"));
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
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

  it("refuses 403 the same or an older version to a key without write on an edge type's stored reverse name", async () => {
    const part = fresh();
    const [forward, reverse] = [`watches-${part}`, `watched-by-${part}`];
    const watched = (version: string, stored: boolean) =>
      single(`stored-reverse-${part}`, `storedreverse${part}.thing`, {
        version,
        edge_types: [
          {
            id: forward,
            cardinality: "many-to-many",
            ...(stored ? { reverse_name: reverse } : {}),
          },
        ],
      });
    const installed = await owner.installPlugin(watched("1.0.0", true));
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
    const forwardOnly = await ownerKey(
      origin,
      ["schema.write"],
      { "*": "write" },
      { [forward]: "write" },
    );
    for (const version of ["1.0.0", "0.9.0"]) {
      const refused = await forwardOnly.installPlugin(watched(version, false));
      expect(refused.status, version).toBe(403);
      expect(refused.error?.error.code).toBe("edge_type_not_permitted");
    }
    // The witness: a key holding both names is answered for the version.
    const both = await ownerKey(
      origin,
      ["schema.write"],
      { "*": "write" },
      { [forward]: "write", [reverse]: "write" },
    );
    const again = await both.installPlugin(watched("1.0.0", false));
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.outcome).toBe("unchanged");
    const older = await both.installPlugin(watched("0.9.0", false));
    expect(older.error?.error.code).toBe("plugin_version_older");
  });

  it("takes a version that moves a requirement from the type's required list to the field", async () => {
    const part = fresh();
    const versioned = (version: string, inField: boolean) =>
      single(`moved-required-${part}`, `movedrequired${part}.thing`, {
        version,
        types: [
          {
            id: `movedrequired${part}.thing`,
            description: "A thing whose title is required.",
            ...(inField ? {} : { required: ["title"] }),
            fields: {
              title: { type: "string", ...(inField ? { required: true } : {}) },
            },
          },
        ],
      });
    const installed = await owner.installPlugin(versioned("1.0.0", false));
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
    const moved = await owner.installPlugin(versioned("1.1.0", true));
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect(moved.data.outcome).toBe("updated");
    const back = await owner.installPlugin(versioned("1.2.0", false));
    expect(back.status, JSON.stringify(back.error)).toBe(200);
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

  it("takes a version that adds a field and an enum value, and reads the new version on its types", async () => {
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

/** A root type with a status field, a list of entries and a table, at `version`. */
function shapes(
  version: string,
  change: (thing: Record<string, any>) => void = () => {},
) {
  const thing: Record<string, any> = {
    id: "shapes.thing",
    description: "A thing with every kind of shape.",
    fields: {
      title: { type: "string" },
      stage: {
        type: "status",
        status_values: [
          { value: "open", group: "not_started" },
          { value: "shut", group: "completed" },
        ],
      },
      kind: { type: "enum", enum_values: ["small", "large"] },
      parts: {
        type: "array",
        items_type: "object",
        items_fields: { name: { type: "string" } },
      },
    },
    tables: {
      lines: { columns: { note: { type: "string", max_length: 100 } } },
    },
  };
  change(thing);
  return bundle("shapes", { version, types: [thing], edge_types: [] });
}

describe("what a newer version may change", () => {
  beforeAll(async () => {
    const installed = await owner.installPlugin(shapes("1.0.0"));
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
  });

  it("refuses 409 plugin_narrows a version that adds a required field, makes a list member required, lowers a table column's limit or moves a status word to another group", async () => {
    const cases: [string, (thing: Record<string, any>) => void][] = [
      [
        "fields.due",
        (thing) => (thing.fields.due = { type: "date", required: true }),
      ],
      [
        "fields.parts.items_fields.name",
        (thing) => (thing.fields.parts.items_fields.name.required = true),
      ],
      [
        "tables.lines.columns.note.max_length",
        (thing) => (thing.tables.lines.columns.note.max_length = 50),
      ],
      [
        "fields.stage.status_values.shut",
        (thing) => (thing.fields.stage.status_values[1].group = "canceled"),
      ],
    ];
    for (const [path, change] of cases) {
      const refused = await owner.installPlugin(shapes("1.1.0", change));
      expect(refused.status, path).toBe(409);
      expect(refused.error?.error.code).toBe("plugin_narrows");
      expect(refused.error?.error.details?.changes).toEqual([
        expect.objectContaining({ type: "shapes.thing", path }),
      ]);
    }
    expect((await owner.getPlugin("shapes")).data.version).toBe("1.0.0");
  });

  it("takes a version that adds a field, a status word, an enum value and an optional list member", async () => {
    const grown = await owner.installPlugin(
      shapes("1.2.0", (thing) => {
        thing.fields.note = { type: "string" };
        thing.fields.stage.status_values.push({
          value: "held",
          group: "in_progress",
        });
        thing.fields.kind.enum_values.push("medium");
        thing.fields.parts.items_fields.size = { type: "integer" };
      }),
    );
    expect(grown.status, JSON.stringify(grown.error)).toBe(200);
    expect(grown.data.outcome).toBe("updated");
    const read = await owner.getType("shapes.thing");
    expect(
      (read.data.fields as Record<string, any>).stage.status_values.map(
        (word: { value: string }) => word.value,
      ),
    ).toContain("held");
  });

  it("refuses 409 plugin_narrows a version that drops a type the owner already deleted, naming it", async () => {
    const pair = (version: string, both: boolean) =>
      bundle("dropping", {
        version,
        edge_types: [],
        types: [
          {
            id: "dropping.kept",
            description: "Kept.",
            fields: { title: { type: "string" } },
          },
          ...(both
            ? [
                {
                  id: "dropping.gone",
                  description: "Deleted by the owner.",
                  fields: { title: { type: "string" } },
                },
              ]
            : []),
        ],
      });
    const installed = await owner.installPlugin(pair("1.0.0", true));
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
    expect((await owner.deleteType("dropping.gone")).status).toBe(200);
    const refused = await owner.installPlugin(pair("1.1.0", false));
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("plugin_narrows");
    expect(refused.error?.error.details?.changes).toEqual([
      expect.objectContaining({ type: "dropping.gone", path: "" }),
    ]);
    // The witness: the newer version that still holds it installs.
    const taken = await owner.installPlugin(pair("1.1.0", true));
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
  });

  it("names the type that declared a status word when a newer version adds it to a type two generations above an owner's type that declares it", async () => {
    const family = (version: string, words: string[]) =>
      bundle("family", {
        version,
        edge_types: [],
        types: [
          {
            id: "family.base",
            description: "The top of a family.",
            fields: {
              stage: {
                type: "status",
                status_values: words.map((value) => ({
                  value,
                  group: "not_started",
                })),
              },
            },
          },
        ],
      });
    expect((await owner.installPlugin(family("1.0.0", ["open"]))).status).toBe(
      201,
    );
    const middle = await owner.registerType({
      id: "user.family-middle",
      parent: "family.base",
      fields: {
        stage: {
          type: "status",
          status_values: [{ value: "waiting", group: "in_progress" }],
        },
      },
    } as never);
    expect(middle.status, JSON.stringify(middle.error)).toBe(201);
    const low = await owner.registerType({
      id: "user.family-low",
      parent: "user.family-middle",
      fields: {
        stage: {
          type: "status",
          status_values: [{ value: "parked", group: "not_started" }],
        },
      },
    } as never);
    expect(low.status, JSON.stringify(low.error)).toBe(201);
    const refused = await owner.installPlugin(
      family("1.1.0", ["open", "parked"]),
    );
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("plugin_child_conflict");
    expect(refused.error?.error.details?.conflicts).toEqual([
      expect.objectContaining({
        type: "user.family-low",
        inherited: "parked",
        inherited_from: "family.base",
      }),
    ]);
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
      removed: { name: "removable", version: "1.0.0", connector: null },
      kept: { types: ["removable.thing"], edge_types: [], connector: null },
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

describe("removing a plugin whose edge type the owner deleted", () => {
  it("reports as kept only the edge types the instance still holds", async () => {
    const installed = await owner.installPlugin(
      single("edge-removed", "edgeremoved.thing", {
        edge_types: [
          { id: "edge-removed-a", cardinality: "many-to-many" },
          { id: "edge-removed-b", cardinality: "many-to-many" },
        ],
      }),
    );
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
    expect((await owner.deleteEdgeType("edge-removed-a")).status).toBe(200);
    const removed = await owner.removePlugin("edge-removed");
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    expect(removed.data.kept).toEqual({
      types: ["edgeremoved.thing"],
      edge_types: ["edge-removed-b"],
    });
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
    const held = await owner.getPlugin("tickets");
    expect(held.data.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(record.data).toMatchObject({
      version: "1.3.0",
      types: [TICKET, SPIKE],
      fingerprint: held.data.fingerprint,
    });
    expect(
      (await elsewhere.getType("user.registered-beside")).data.provenance
        ?.origin,
    ).toBe("registered");
  });

  it("restores an export taken after the owner deleted the types a plugin's stored bundle names as parents", async () => {
    const part = fresh();
    const name = `parent-gone-${part}`;
    const parent = `user.parent-gone-${part}`;
    const child = `parentgone${part}.child`;
    const registered = await owner.registerType({
      id: parent,
      fields: { title: { type: "string" } },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const installed = await owner.installPlugin(
      single(name, child, {
        types: [
          {
            id: child,
            parent,
            description: "A child of a type the owner registered.",
            fields: { note: { type: "string" } },
          },
        ],
      }),
    );
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
    expect((await owner.deleteType(child)).status).toBe(200);
    expect((await owner.deleteType(parent)).status).toBe(200);
    const archive = await owner.exportArchive({ state: "any" });
    expect(archive.status).toBe(200);
    const local = new MarfaClient({
      baseUrl: destination.apiUrl,
      controlSocket: destination.controlSocket,
    });
    const restored = await local.restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    const record = await elsewhere.getPlugin(name);
    expect(record.status).toBe(200);
    expect(record.data.types).toEqual([]);
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
    const id = `user.user-in-version-two-${fresh()}`;
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

describe("a version 2 archive's provenance and install records", () => {
  const archiveOf = (lines: Record<string, unknown>[], plugins: number) =>
    tar([
      {
        name: "manifest.json",
        body: JSON.stringify(
          emptyManifest({
            version: 2,
            type_count: lines.length - plugins,
            plugin_count: plugins,
          }),
        ),
      },
      lineFile("files", ""),
      lineFile("instance", ndjson(lines)),
      lineFile("items", ""),
      lineFile("versions", ""),
      lineFile("edges", ""),
      lineFile("rows", ""),
    ]);
  const restore = (archive: Uint8Array) =>
    new MarfaClient({
      baseUrl: destination.apiUrl,
      controlSocket: destination.controlSocket,
    }).restoreArchive(archive);

  it("refuses a type whose origin or creator is mistyped, missing, outside the sign-in kinds or at odds with its plugin", async () => {
    const id = `user.mistyped-origin-${fresh()}`;
    const typed = (provenance: Record<string, unknown>) =>
      archiveOf(
        [{ type: { id, fields: { title: { type: "string" } } }, provenance }],
        0,
      );
    for (const provenance of [
      { origin: 7, created_by: null },
      { origin: "registered", created_by: {} },
      { origin: "registered" },
      {
        origin: "registered",
        created_by: { kind: "server", id: "server", name: "Marfa" },
      },
      {
        origin: "registered",
        plugin: { name: "tickets", version: "1.0.0" },
        created_by: null,
      },
      { origin: "plugin", created_by: null },
      { origin: "platform", created_by: null },
    ]) {
      const refused = await restore(typed(provenance));
      expect(refused.status, JSON.stringify(provenance)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
    expect((await elsewhere.getType(id)).status).toBe(404);
    // The witness: the same archive with a well-formed provenance restores.
    const restored = await restore(
      typed({
        origin: "registered",
        created_by: { kind: "key", id: "k1", name: "A key" },
      }),
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
  });

  it("refuses a type from a plugin under a root no plugin registers, which it restores under common", async () => {
    const part = fresh();
    const typed = (id: string) =>
      archiveOf(
        [
          {
            type: { id, fields: { title: { type: "string" } } },
            provenance: {
              origin: "plugin",
              plugin: { name: "claimed", version: "1.0.0" },
              created_by: null,
            },
          },
        ],
        0,
      );
    for (const root of ["core", "system", "marfa", "app", "user"]) {
      const id = `${root}.plugin-claimed-${part}`;
      const refused = await restore(typed(id));
      expect(refused.status, id).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect((await elsewhere.getType(id)).status, id).toBe(404);
    }
    // The witness: the same line under common restores, so a plugin's type was producible.
    const id = `common.plugin-claimed-${part}`;
    const restored = await restore(typed(id));
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect((await elsewhere.getType(id)).data.provenance?.origin).toBe(
      "plugin",
    );
  });

  it("refuses a plugin line whose times, installer, edge types, fingerprint or bundle definitions are not ones the server writes or installs", async () => {
    const part = fresh();
    const plugin = single(
      `archived-record-${part}`,
      `archivedrecord${part}.thing`,
    );
    const line = (fields: Record<string, unknown>) => ({
      plugin: {
        name: plugin.name,
        version: plugin.version,
        bundle: plugin,
        edge_types: [],
        installed_at: "2026-11-01T10:00:00.000Z",
        installed_by: null,
        updated_at: "2026-11-01T10:00:00.000Z",
        fingerprint: "ab".repeat(32),
        ...fields,
      },
    });
    for (const fields of [
      { installed_at: "yesterday" },
      { updated_at: "2026-11-01" },
      { installed_by: {} },
      { installed_by: { kind: "server", id: "server", name: "Marfa" } },
      {
        bundle: {
          ...plugin,
          types: [
            { id: `archivedrecord${part}.thing`, description: "No fields." },
          ],
        },
      },
      { edge_types: "none" },
      { edge_types: [""] },
      { edge_types: ["NOT AN EDGE ID"] },
      { edge_types: ["about"] },
      { fingerprint: "AB".repeat(32) },
      { fingerprint: "ab" },
      { fingerprint: null },
    ]) {
      const refused = await restore(archiveOf([line(fields)], 1));
      expect(refused.status, JSON.stringify(fields)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
    expect((await elsewhere.getPlugin(plugin.name)).status).toBe(404);
    // The witness: the same line with a sign-in and stored times restores.
    const restored = await restore(
      archiveOf(
        [
          line({
            installed_by: { kind: "local", id: "local", name: "Local command" },
            edge_types: [`gone-link-${part}`],
          }),
        ],
        1,
      ),
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    const read = await elsewhere.getPlugin(plugin.name);
    expect(read.status).toBe(200);
    expect(read.data.fingerprint).toBe("ab".repeat(32));
    expect(read.data.edge_types).toEqual([]);
    await expectMatchesSchema("GET", "/plugins/{name}", 200, read.data);
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

  it("refuses 403 an app installing a plugin whose types carry guidance, and installs the same plugin without it", async () => {
    // A grant names a root the instance holds a type under.
    const anchor = await owner.registerType({
      id: "guided.anchor",
      fields: { title: { type: "string" } },
    } as never);
    expect(anchor.status, JSON.stringify(anchor.error)).toBe(201);
    const app = await appToken(origin, "guided.*:write schema.write");
    const guided = (guidance?: string) =>
      single("guided-by-app", "guided.thing", {
        types: [
          {
            id: "guided.thing",
            description: "A guided thing.",
            ...(guidance === undefined ? {} : { guidance }),
            fields: { title: { type: "string" } },
          },
        ],
      });
    const refused = await app.installPlugin(guided("Installing writes this."));
    expect(refused.status, JSON.stringify(refused.error)).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");
    expect(refused.error?.error.details?.changes).toEqual(["guidance"]);
    expect((await owner.getType("guided.thing")).status).toBe(404);
    const plain = await app.installPlugin(guided());
    expect(plain.status, JSON.stringify(plain.error)).toBe(201);
  });

  it("refuses an app's newer version that would remove guidance the owner's install wrote", async () => {
    const anchor = await owner.registerType({
      id: "unguided.anchor",
      fields: { title: { type: "string" } },
    } as never);
    expect(anchor.status, JSON.stringify(anchor.error)).toBe(201);
    const at = (version: string, guidance?: string) =>
      single("unguided", "unguided.thing", {
        version,
        types: [
          {
            id: "unguided.thing",
            description: "A guided thing.",
            ...(guidance === undefined ? {} : { guidance }),
            fields: { title: { type: "string" } },
          },
        ],
      });
    const installed = await owner.installPlugin(at("1.0.0", "Read me."));
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
    const app = await appToken(origin, "unguided.*:write schema.write");
    const refused = await app.installPlugin(at("1.1.0"));
    expect(refused.status).toBe(403);
    expect(refused.error?.error.details?.changes).toEqual(["guidance"]);
    expect((await owner.getType("unguided.thing")).data.guidance).toBe(
      "Read me.",
    );
    // The witness: the owner's key installs the same version.
    const taken = await owner.installPlugin(at("1.1.0"));
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
  });

  it("refuses guidance to an owner's key an app minted, on registration and on install, and takes both without it", async () => {
    // An app is offered a root's wildcard only once the instance holds a type under it.
    const seeded = await owner.registerType({
      id: "minted.seed",
      fields: { title: { type: "string" } },
    } as never);
    expect(seeded.status, JSON.stringify(seeded.error)).toBe(201);
    const app = await appToken(
      origin,
      "minted.*:write metadata.types:write schema.write keys.mint keys.manage",
    );
    const minted = await app.createKey({
      label: "minted by an app",
      source: `plugins-minted-${String(++keysMinted)}`,
      permissions: ["schema.write"],
      type_permissions: { "minted.*": "write" },
      metadata_permissions: { types: "write" },
      owner_key: true,
    } as never);
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    expect(minted.data).not.toHaveProperty("oauth_client_id");
    const key = new MarfaClient({
      baseUrl: origin.apiUrl,
      apiKey: minted.data.key!,
    });
    const registered = await key.registerType({
      id: "minted.guided",
      guidance: "Use it.",
      fields: { title: { type: "string" } },
    } as never);
    expect(registered.status, JSON.stringify(registered.error)).toBe(403);
    expect(registered.error?.error.details?.changes).toEqual(["guidance"]);
    const installed = await key.installPlugin(
      single("minted", "minted.thing", {
        types: [
          {
            id: "minted.thing",
            description: "A thing.",
            guidance: "Use it.",
            fields: { title: { type: "string" } },
          },
        ],
      }),
    );
    expect(installed.status).toBe(403);
    expect(installed.error?.error.details?.changes).toEqual(["guidance"]);
    // The witness: the same key registers and installs without guidance.
    const plain = await key.registerType({
      id: "minted.guided",
      fields: { title: { type: "string" } },
    } as never);
    expect(plain.status, JSON.stringify(plain.error)).toBe(201);
    const bare = await key.installPlugin(single("minted", "minted.thing"));
    expect(bare.status, JSON.stringify(bare.error)).toBe(201);
  });
});

describe("installing a plugin with a connector", () => {
  /** Sends `text` as the body, so the test knows the bytes the server received. */
  async function sent(key: string, text: string) {
    const response = await fetch(`${origin.apiUrl}/plugins`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: text,
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  }

  async function keyWith(permissions: string[]): Promise<string> {
    const local = new MarfaClient({
      baseUrl: origin.apiUrl,
      controlSocket: origin.controlSocket,
    });
    const minted = await local.createKey({
      label: "plugins connector fixture",
      source: `plugins-${String(++keysMinted)}`,
      permissions,
      type_permissions: { "wired.*": "write" },
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    return minted.data.key!;
  }

  it("refuses 403 a bundle with a connector to a key without connectors.manage, which installs the same bundle without one, and takes it with both, recording the SHA-256 of the bytes sent", async () => {
    const connector = (type: string, source: string) => ({
      source,
      source_name: "A service",
      kinds: [{ name: "entry", type, direction: "in" }],
      runs: { on: "host" },
    });
    const schemaOnly = await keyWith(["schema.write"]);
    // The witness: schema.write alone installs a bundle with no connector.
    const bare = await sent(
      schemaOnly,
      JSON.stringify(single("wired-bare", "wired.bare")),
    );
    expect(bare.status, JSON.stringify(bare.body)).toBe(201);
    const refused = await sent(
      schemaOnly,
      JSON.stringify(
        single("wired-refused", "wired.refused", {
          connector: connector("wired.refused", "wired-refused"),
        }),
      ),
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.details.required_scope).toBe("connectors.manage");
    expect((await owner.getPlugin("wired-refused")).status).toBe(404);
    expect((await owner.getType("wired.refused")).status).toBe(404);
    const both = await keyWith(["schema.write", "connectors.manage"]);
    // Spacing the server does not keep, so the digest is of the bytes as sent.
    const text = JSON.stringify(
      single("wired-taken", "wired.taken", {
        connector: connector("wired.taken", "wired-taken"),
      }),
      null,
      3,
    );
    const taken = await sent(both, text);
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    const digest = createHash("sha256").update(text).digest("hex");
    expect(taken.body.fingerprint).toBe(digest);
    const read = await owner.getPlugin("wired-taken");
    expect(read.data.fingerprint).toBe(digest);
    expect(read.data.connector).toEqual(connector("wired.taken", "wired-taken"));
    const listed = await owner.listPlugins();
    expect(
      listed.data.data.find((held) => held.name === "wired-taken")?.fingerprint,
    ).toBe(digest);
  });
});

describe("an edge type an earlier version brought", () => {
  it("keeps reporting an edge type a newer version omits, through an export, a restore and the removal", async () => {
    const part = fresh();
    const [plugin, link, thing] = [
      `review-plugin-${part}`,
      `review-link-${part}`,
      `reviewplugin${part}.thing`,
    ];
    const versioned = (version: string, linked: boolean) =>
      single(plugin, thing, {
        version,
        edge_types: linked ? [{ id: link, cardinality: "many-to-many" }] : [],
      });
    const first = await owner.installPlugin(versioned("1.0.0", true));
    expect(first.status, JSON.stringify(first.error)).toBe(201);
    const omitted = await owner.installPlugin(versioned("1.1.0", false));
    expect(omitted.status, JSON.stringify(omitted.error)).toBe(200);
    expect(omitted.data.edge_types).toEqual([link]);
    const held = await owner.listEdgeTypes();
    expect(held.data.data.map((edge) => edge.id)).toContain(link);
    const archive = await owner.exportArchive({ state: "any" });
    expect(archive.status).toBe(200);
    const line = archiveLines(archive.data, "instance")
      .map((held) => held.plugin as { name: string; edge_types: string[] })
      .find((held) => held?.name === plugin);
    expect(line?.edge_types).toEqual([link]);
    const local = new MarfaClient({
      baseUrl: destination.apiUrl,
      controlSocket: destination.controlSocket,
    });
    const restored = await local.restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect((await elsewhere.getPlugin(plugin)).data.edge_types).toEqual([link]);
    const removed = await owner.removePlugin(plugin);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    expect(removed.data.kept).toEqual({ types: [thing], edge_types: [link] });
  });
});
