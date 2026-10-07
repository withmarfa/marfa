import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { declareOversizeBody } from "../../utils/oversize.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * The instance's identity and `PUT /config` (the instance chapter's
 * `instance/id-*` and `instance/config-*` rules).
 *
 * **On servers of the fixture's own.** The configuration is the instance's,
 * not a key's, so a `PUT` here would replace what every other file on the
 * run's server reads, and an identity that survives a restart can only be
 * watched on a server the fixture is free to stop. A second server is the
 * witness that one identity is not every instance's.
 */
let server: FreshServer | undefined;
let other: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("instance-config");
  other = await bootFreshServer("instance-config-other");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

/** The shape `generateId` mints, which is what the identity is. */
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** An identity no instance minted. */
const ELSEWHERE = "019537a0-7b80-7000-8000-000000000000";

function configKey(): MarfaClient {
  return new MarfaClient({
    baseUrl: server!.apiUrl,
    apiKey: server!.workingKey,
  });
}

/** The identity the root answers, asked with no credential. */
async function rootIdentity(of: FreshServer): Promise<string> {
  const answer = await fetch(`${of.apiUrl}/`);
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { instance_id: string }).instance_id;
}

describe("the instance's identity", () => {
  it(
    "answers one identity to every caller, keeps it across a restart, and shares it with no other instance",
    async () => {
      const minted = await rootIdentity(server!);
      expect(minted).toMatch(UUID_V7);
      for (let call = 0; call < 5; call++) {
        expect(await rootIdentity(server!), `call ${String(call)}`).toBe(
          minted,
        );
      }
      const read = await configKey().getConfig();
      expect(read.ok).toBe(true);
      expect((read.data as { instance_id: string }).instance_id).toBe(minted);

      await server!.restart();

      expect(await rootIdentity(server!)).toBe(minted);
      const readAgain = await configKey().getConfig();
      expect(readAgain.ok, JSON.stringify(readAgain.error)).toBe(true);
      expect((readAgain.data as { instance_id: string }).instance_id).toBe(
        minted,
      );

      // The witness: an instance that was started fresh says a different one,
      // so the equality above is the same file reopened and not a constant.
      const another = await rootIdentity(other!);
      expect(another).toMatch(UUID_V7);
      expect(another).not.toBe(minted);
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );

  it("leaves the identity the root answers as it was after any PUT, refused ones included", async () => {
    const client = configKey();
    const minted = await rootIdentity(server!);

    const bodies: [string, Record<string, unknown>, number][] = [
      ["the wholesale clear", {}, 200],
      ["a body taken back as read", { instance_id: minted }, 200],
      [
        "a body that sets a retention and names the instance",
        { instance_id: minted, audit_retention_days: 31 },
        200,
      ],
      ["a body addressed elsewhere", { instance_id: ELSEWHERE }, 400],
      ["a body naming an empty identity", { instance_id: "" }, 400],
    ];
    for (const [label, body, status] of bodies) {
      const written = await client.updateConfig(body);
      expect(written.status, label).toBe(status);
      expect(await rootIdentity(server!), label).toBe(minted);
      const read = await client.getConfig();
      expect((read.data as { instance_id: string }).instance_id, label).toBe(
        minted,
      );
    }

    await client.updateConfig({});
  }, 120_000);
});

describe("the order PUT /config refuses in", () => {
  /** The `errors` of a `validation_error`, as the paths and messages. */
  function errorsOf(answer: {
    error?: { error: { details?: Record<string, unknown> } };
  }): { path: string; message: string }[] {
    return (answer.error?.error.details?.errors ?? []) as {
      path: string;
      message: string;
    }[];
  }

  it("reads the body's shape before the identity, so a body wrong in both is refused for its shape", async () => {
    const client = configKey();
    const minted = await rootIdentity(server!);
    const held = await client.updateConfig({ audit_retention_days: 31 });
    expect(held.status, JSON.stringify(held.error)).toBe(200);

    const shapes: [string, Record<string, unknown>][] = [
      ["an unknown key", { not_a_setting: 1 }],
      ["a retention out of its range", { audit_retention_days: 36_501 }],
      ["a lever of the wrong shape", { enforcement: { strict_mode: "yes" } }],
    ];
    for (const [label, wrong] of shapes) {
      // The witness: the same body, naming this instance, is refused for its
      // shape alone, so the shape is what the refusal below reports.
      const alone = await client.updateConfig({
        ...wrong,
        instance_id: minted,
      });
      expect(alone.status, `${label}, alone`).toBe(400);
      expect(alone.error?.error.code, `${label}, alone`).toBe(
        "validation_error",
      );

      const both = await client.updateConfig({
        ...wrong,
        instance_id: ELSEWHERE,
      });
      expect(both.status, label).toBe(400);
      expect(both.error?.error.code, label).toBe("validation_error");
      expect(
        errorsOf(both).map((entry) => entry.path),
        label,
      ).not.toContain("instance_id");
      expect(errorsOf(both), label).toEqual(errorsOf(alone));
    }

    // A top-level key the server does not know is reported at the body
    // itself, the empty path, though a known setting sits beside it, and a
    // key one level down is reported at the lever that holds it.
    const misspelled = await client.updateConfig({
      trash_retention_day: 3,
      audit_retention_days: 31,
    });
    expect(misspelled.status).toBe(400);
    expect(misspelled.error?.error.code).toBe("validation_error");
    expect(errorsOf(misspelled).map((entry) => entry.path)).toEqual([""]);
    const nested = await client.updateConfig({
      enforcement: { strict_mode: { types: ["core.note"] }, not_a_lever: true },
    });
    expect(nested.status).toBe(400);
    expect(errorsOf(nested).map((entry) => entry.path)).toEqual([
      "enforcement",
    ]);

    // Reverse witness: with the shape valid, the identity is what is refused.
    const identity = await client.updateConfig({ instance_id: ELSEWHERE });
    expect(identity.status).toBe(400);
    expect(errorsOf(identity)[0]?.path).toBe("instance_id");

    const after = await client.getConfig();
    expect(after.data).toEqual({
      instance_id: minted,
      audit_retention_days: 31,
    });
    await client.updateConfig({});
  }, 120_000);

  it("refuses an empty identity by the schema, naming instance_id", async () => {
    const refused = await configKey().updateConfig({ instance_id: "" });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(errorsOf(refused)[0]?.path).toBe("instance_id");
    // The mismatch refusal says which instance this is; the schema's does
    // not, so this one was refused before the identity was compared.
    const minted = await rootIdentity(server!);
    expect(JSON.stringify(refused.error)).not.toContain(minted);
  }, 120_000);

  it("names a lever's missing field before the identity too", async () => {
    const refused = await configKey().updateConfig({
      enforcement: { strict_mode: {} },
      instance_id: ELSEWHERE,
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("missing_required_field");
    expect(refused.error?.error.details?.field).toBe(
      "enforcement.strict_mode.types",
    );
  }, 120_000);

  it("asks for a credential, then config.manage, before it reads the body", async () => {
    const operator = new MarfaClient({
      baseUrl: server!.apiUrl,
      apiKey: server!.operatorKey,
    });
    const narrowed = await operator.createKey({
      label: "instance-config-narrowed",
      source: "instance-config-narrowed",
      permissions: ["audit.read"],
    });
    expect(narrowed.ok, JSON.stringify(narrowed.error)).toBe(true);
    const faulty = { not_a_setting: 1, instance_id: ELSEWHERE };

    const asNarrowed = new MarfaClient({
      baseUrl: server!.apiUrl,
      apiKey: narrowed.data.key,
    });
    const forbidden = await asNarrowed.updateConfig(faulty);
    expect(forbidden.status).toBe(403);
    expect(forbidden.error?.error.code).toBe("forbidden");
    expect(forbidden.error?.error.details?.required_scope).toBe(
      "config.manage",
    );

    const unknown = await fetch(`${server!.apiUrl}/config`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer marfa_a-key-no-instance-holds",
        "content-type": "application/json",
      },
      body: JSON.stringify(faulty),
    });
    expect(unknown.status).toBe(401);
    const bare = await fetch(`${server!.apiUrl}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(faulty),
    });
    expect(bare.status).toBe(401);
    expect(
      ((await bare.json()) as { error: { code: string } }).error.code,
    ).toBe("unauthorized");

    // The witness: a key that holds config.manage is told what is wrong with
    // the body, so the two refusals above were not the body's.
    const told = await configKey().updateConfig(faulty);
    expect(told.status).toBe(400);
  }, 120_000);

  it("asks for a credential, then config.manage, before it reads the query, so a query key is refused 401, then 403, then 400", async () => {
    const asked = async (method: string, authorization?: string) => {
      const response = await fetch(`${server!.apiUrl}/config?not_a_key=1`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined
            ? {}
            : { Authorization: `Bearer ${authorization}` }),
        },
        ...(method === "PUT" && { body: "{}" }),
      });
      const body = (await response.json()) as {
        error: { code: string; details?: { required_scope?: string } };
      };
      return { status: response.status, error: body.error };
    };

    // The witness: without the query key the same requests are served to the
    // key that holds config.manage, so the refusals below are the query's
    // or the credential's and not the request's.
    const holder = configKey();
    expect((await holder.getConfig()).status).toBe(200);
    expect((await holder.updateConfig({})).status).toBe(200);

    for (const method of ["GET", "PUT"]) {
      for (const [who, credential] of [
        ["no credential", undefined],
        ["a key the instance does not hold", "marfa_a-key-no-instance-holds"],
      ] as const) {
        const refused = await asked(method, credential);
        expect(refused.status, `${method} with ${who}`).toBe(401);
        expect(refused.error.code, `${method} with ${who}`).toBe(
          "unauthorized",
        );
      }

      const forbidden = await asked(method, server!.operatorKey);
      expect(forbidden.status, method).toBe(403);
      expect(forbidden.error.code, method).toBe("forbidden");
      expect(forbidden.error.details?.required_scope, method).toBe(
        "config.manage",
      );

      const invalid = await asked(method, server!.workingKey);
      expect(invalid.status, method).toBe(400);
      expect(invalid.error.code, method).toBe("validation_error");
    }
  }, 120_000);
});

/**
 * The two doors as a whole: who may use them, what they read back and what
 * each accepted write leaves behind. The levers' meaning and the retention
 * bounds are asserted where those chapters own them.
 */
describe("GET /config and PUT /config", () => {
  /** Every setting the door takes, each set. */
  const EVERYTHING = {
    enforcement: {
      strict_mode: { types: ["core.note"] },
      source_allowlist: { types: ["core.note"], sources: ["listed"] },
      source_filter: { types: ["core.note"], sources: ["listed"] },
    },
    audit_retention_days: 31,
    trash_retention_days: 30,
    inbound_handled_retention_days: 5,
    inbound_pending_retention_days: 6,
    event_log_retention_hours: 100,
  };

  function operatorClient(): MarfaClient {
    return new MarfaClient({
      baseUrl: server!.apiUrl,
      apiKey: server!.operatorKey,
    });
  }

  async function put(
    client: MarfaClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const written = await client.updateConfig(body);
    expect(written.status, JSON.stringify(written.error)).toBe(200);
    return written.data as Record<string, unknown>;
  }

  async function read(client: MarfaClient): Promise<Record<string, unknown>> {
    const answer = await client.getConfig();
    expect(answer.status, JSON.stringify(answer.error)).toBe(200);
    return answer.data as Record<string, unknown>;
  }

  it("refuses both operations to the operator key, which holds no config.manage, and serves them to a key that does", async () => {
    const operator = operatorClient();
    for (const [label, answer] of [
      ["GET", await operator.getConfig()],
      ["PUT", await operator.updateConfig({})],
    ] as const) {
      expect(answer.status, label).toBe(403);
      expect(answer.error?.error.code, label).toBe("forbidden");
      expect(answer.error?.error.details?.required_scope, label).toBe(
        "config.manage",
      );
    }

    // The witness: the same two requests, from a key that holds the
    // permission, are served.
    const holder = configKey();
    await put(holder, {});
    expect(await read(holder)).toHaveProperty("instance_id");
  }, 120_000);

  it("answers 401 unauthorized to both operations for no credential and for a key the instance does not hold", async () => {
    for (const authorization of [
      undefined,
      "Bearer marfa_a-key-no-instance-holds",
    ]) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(authorization === undefined
          ? {}
          : { Authorization: authorization }),
      };
      for (const method of ["GET", "PUT"]) {
        const answer = await fetch(`${server!.apiUrl}/config`, {
          method,
          headers,
          ...(method === "PUT" && { body: "{}" }),
        });
        const label = `${method} with ${authorization ?? "no credential"}`;
        expect(answer.status, label).toBe(401);
        expect(
          ((await answer.json()) as { error: { code: string } }).error.code,
          label,
        ).toBe("unauthorized");
      }
    }
  }, 120_000);

  it("reads back each setting that has been set, and no field for one that has not", async () => {
    const client = configKey();
    const minted = await rootIdentity(server!);

    // Nothing set: the identity alone.
    await put(client, {});
    expect(await read(client)).toEqual({ instance_id: minted });

    try {
      const written = await put(client, EVERYTHING);
      expect(written).toEqual({ instance_id: minted, ...EVERYTHING });
      expect(await read(client)).toEqual({
        instance_id: minted,
        ...EVERYTHING,
      });

      // One setting set: that one and the identity, and none of the other
      // seven.
      await put(client, { trash_retention_days: 30 });
      expect(await read(client)).toEqual({
        instance_id: minted,
        trash_retention_days: 30,
      });
    } finally {
      await put(client, {});
    }
  }, 120_000);

  it("takes away each setting a later PUT leaves out", async () => {
    const client = configKey();
    try {
      await put(client, EVERYTHING);
      for (const field of Object.keys(EVERYTHING)) {
        const without = Object.fromEntries(
          Object.entries(EVERYTHING).filter(([name]) => name !== field),
        );
        await put(client, EVERYTHING);
        const written = await put(client, without);
        expect(written, field).not.toHaveProperty(field);
        const after = await read(client);
        expect(after, field).not.toHaveProperty(field);
        expect(Object.keys(after).sort(), field).toEqual(
          ["instance_id", ...Object.keys(without)].sort(),
        );
      }
    } finally {
      await put(client, {});
    }
  }, 120_000);

  it("names the field a lever lacks with missing_required_field, and keeps the configuration", async () => {
    const client = configKey();
    const held = await put(client, { audit_retention_days: 31 });

    const lacking: [string, Record<string, unknown>][] = [
      ["enforcement.strict_mode.types", { enforcement: { strict_mode: {} } }],
      [
        "enforcement.source_allowlist.types",
        { enforcement: { source_allowlist: { sources: ["listed"] } } },
      ],
      [
        "enforcement.source_allowlist.sources",
        { enforcement: { source_allowlist: { types: ["core.note"] } } },
      ],
      [
        "enforcement.source_filter.types",
        { enforcement: { source_filter: { sources: ["listed"] } } },
      ],
      [
        "enforcement.source_filter.sources",
        { enforcement: { source_filter: { types: ["core.note"] } } },
      ],
    ];
    for (const [field, body] of lacking) {
      const refused = await client.updateConfig(body);
      expect(refused.status, field).toBe(400);
      expect(refused.error?.error.code, field).toBe("missing_required_field");
      expect(refused.error?.error.details?.field, field).toBe(field);
      expect(refused.error?.error.message, field).toBe(`${field} is required`);
      expect(await read(client), field).toEqual(held);
    }

    // The witness: each lever with both of its members is taken.
    try {
      await put(client, {
        enforcement: {
          strict_mode: { types: ["core.note"] },
          source_allowlist: { types: ["core.note"], sources: ["listed"] },
          source_filter: { types: ["core.note"], sources: ["listed"] },
        },
      });
    } finally {
      await put(client, {});
    }
  }, 120_000);

  it("records a config.update audit entry for the key that wrote, and none for a refused write", async () => {
    const client = configKey();
    const second = await operatorClient().createKey({
      label: "instance-config-second",
      source: "instance-config-second",
      permissions: ["config.manage"],
    });
    expect(second.ok, JSON.stringify(second.error)).toBe(true);
    const secondClient = new MarfaClient({
      baseUrl: server!.apiUrl,
      apiKey: second.data.key,
    });
    const current = await client.getCurrentKey();
    expect(current.ok, JSON.stringify(current.error)).toBe(true);

    const entries = async () => {
      const listed = await client.listAudit({
        action: "config.update",
        limit: 100,
      });
      expect(listed.status, JSON.stringify(listed.error)).toBe(200);
      return listed.data.data;
    };
    const before = await entries();

    await put(client, { audit_retention_days: 31 });
    await put(secondClient, { audit_retention_days: 32 });
    // Refused for its shape and for its identity: nothing was written, so
    // nothing is recorded.
    expect((await client.updateConfig({ not_a_setting: 1 })).status).toBe(400);
    expect((await client.updateConfig({ instance_id: ELSEWHERE })).status).toBe(
      400,
    );

    const after = await entries();
    const known = new Set(before.map((entry) => entry.id));
    const added = after.filter((entry) => !known.has(entry.id));
    expect(added.map((entry) => entry.key_id).sort()).toEqual(
      [current.data.id, second.data.id].sort(),
    );
    for (const entry of added) {
      expect(entry.action).toBe("config.update");
      expect(entry.resource_type).toBe("config");
    }

    await put(client, {});
  }, 120_000);

  it("refuses a query key on both operations", async () => {
    for (const method of ["GET", "PUT"]) {
      const answer = await fetch(`${server!.apiUrl}/config?not_a_key=1`, {
        method,
        headers: {
          Authorization: `Bearer ${server!.workingKey}`,
          "content-type": "application/json",
        },
        ...(method === "PUT" && { body: "{}" }),
      });
      expect(answer.status, method).toBe(400);
      expect(
        ((await answer.json()) as { error: { code: string } }).error.code,
        method,
      ).toBe("validation_error");
    }
  }, 120_000);
  it("refuses a body past the request cap with 413 request_too_large, and keeps the configuration", async () => {
    const client = configKey();
    const held = await put(client, { audit_retention_days: 31 });
    // No setting bounds its own size, so a lever's list is held only by the
    // cap on the body.
    const lever = (bytes: number) => ({
      enforcement: { strict_mode: { types: ["t".repeat(bytes)] } },
    });

    try {
      // The largest body the default cap takes: one byte under what is
      // refused below.
      const cap = 1_048_576;
      const padding = cap - JSON.stringify(lever(0)).length;
      const atCap = lever(padding);
      expect(JSON.stringify(atCap).length).toBe(cap);
      await put(client, atCap);
      await put(client, { audit_retention_days: 31 });

      const refused = await declareOversizeBody(`${server!.apiUrl}/config`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${server!.workingKey}`,
          "content-type": "application/json",
        },
        bytes: cap + 1,
      });
      expect(refused.status).toBe(413);
      expect(
        (JSON.parse(refused.body) as { error: { code: string } }).error.code,
      ).toBe("request_too_large");
      expect(await read(client)).toEqual(held);
    } finally {
      await put(client, {});
    }
  }, 120_000);
});
