import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * The instance's identity and `PUT /config` (`instance.md` 1 and 2).
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
});
