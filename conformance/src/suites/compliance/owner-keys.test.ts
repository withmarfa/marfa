import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { controlRequest } from "../../utils/control-request.js";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";
import { itemsStatus } from "../../utils/signed-in.js";

/**
 * Who may widen a key, grant any source as a claim, and mint an owner's key
 * from an app. An app's access token needs a person's approval, and an
 * instance has one owner, which the run's shared server does not have, so
 * this file boots a server of its own.
 */
let server: FreshServer;

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

interface Key {
  id: string;
  key: string;
  label: string;
  source: string;
  permissions: string[];
  type_permissions: Record<string, string>;
  sources?: string[];
  expires_at?: string | null;
  oauth_client_id?: string;
}

interface App {
  token: string;
  clientId: string;
}

let manageAndMint: App;
let mintOnly: App;
let manageOnly: App;

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
    body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
}

function local(method: string, path: string, body?: unknown): Promise<Answer> {
  return controlRequest(server.controlSocket, path, { method, body });
}

function named(label: string): { label: string; source: string } {
  return { label, source: `${label}-${randomUUID()}` };
}

function minted(answer: Answer): Key {
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body as unknown as Key;
}

/** A key the local command mints, which no app made. */
async function localKey(
  label: string,
  body: Record<string, unknown> = {},
): Promise<Key> {
  return minted(await local("POST", "/keys", { ...named(label), ...body }));
}

async function mintBy(
  credential: string,
  label: string,
  body: Record<string, unknown> = {},
): Promise<Key> {
  return minted(
    await call(credential, "POST", "/keys", { ...named(label), ...body }),
  );
}

/** The key as the listing answers it, or undefined once it is gone. */
async function listed(id: string): Promise<Key | undefined> {
  const answer = await local("GET", "/keys");
  expect(answer.status).toBe(200);
  return (answer.body.data as Key[]).find((key) => key.id === id);
}

async function labels(): Promise<string[]> {
  const answer = await local("GET", "/keys");
  expect(answer.status).toBe(200);
  return (answer.body.data as Key[]).map((key) => key.label);
}

function refusal(answer: Answer): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  return answer.body.error as {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

async function grantOf(
  clientId: string,
): Promise<{ id: string; scopes: string[] }> {
  const grants = await local("GET", "/grants");
  expect(grants.status).toBe(200);
  const grant = (
    grants.body.data as { id: string; client_id: string; scopes: string[] }[]
  ).find((row) => row.client_id === clientId);
  expect(grant, JSON.stringify(grants.body)).toBeDefined();
  return grant!;
}

function later(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

beforeAll(async () => {
  server = await bootFreshServer("owner-keys");
  manageAndMint = await approvedApp(server, [
    "core.note:write",
    "keys.mint",
    "keys.manage",
  ]);
  mintOnly = await approvedApp(server, ["core.note:write", "keys.mint"]);
  manageOnly = await approvedApp(server, ["core.note:write", "keys.manage"]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("an owner's key minted from an app", () => {
  it("mints an owner's key from an app that holds keys.manage, and an app's key without owner_key", async () => {
    const reach = { type_permissions: { "core.note": "write" } };
    const owners = await mintBy(manageAndMint.token, "owners-from-app", {
      ...reach,
      owner_key: true,
    });
    // The witnesses: the same app mints an app's key without the field, and
    // with it set to false.
    const apps = await mintBy(manageAndMint.token, "apps-from-app", reach);
    const unset = await mintBy(manageAndMint.token, "apps-unset", {
      ...reach,
      owner_key: false,
    });
    expect(apps.oauth_client_id).toBe(manageAndMint.clientId);
    expect(unset.oauth_client_id).toBe(manageAndMint.clientId);
    expect((await listed(apps.id))?.oauth_client_id).toBe(
      manageAndMint.clientId,
    );

    expect(owners).not.toHaveProperty("oauth_client_id");
    expect(owners).not.toHaveProperty("owner_key");
    expect(owners.type_permissions).toEqual({ "core.note": "write" });
    expect(await listed(owners.id)).not.toHaveProperty("oauth_client_id");
    const current = await call(owners.key, "GET", "/keys/current");
    expect(current.status).toBe(200);
    expect(current.body).not.toHaveProperty("oauth_client_id");
  });

  it("mints an owner's key from a key an app made that holds keys.manage", async () => {
    const appKey = await mintBy(manageAndMint.token, "app-key-manages", {
      permissions: ["keys.mint", "keys.manage"],
      type_permissions: { "core.note": "write" },
    });
    expect(appKey.oauth_client_id).toBe(manageAndMint.clientId);
    const owners = await mintBy(appKey.key, "owners-from-app-key", {
      type_permissions: { "core.note": "read" },
      owner_key: true,
    });
    expect(owners).not.toHaveProperty("oauth_client_id");
    // The witness: without the field, the app's key mints an app's key.
    const apps = await mintBy(appKey.key, "apps-from-app-key", {
      type_permissions: { "core.note": "read" },
    });
    expect(apps.oauth_client_id).toBe(manageAndMint.clientId);
  });

  it("refuses owner_key from an app, or a key an app made, that does not hold keys.manage", async () => {
    const withoutManage = await mintBy(manageAndMint.token, "app-key-mints", {
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "write" },
    });
    const mintOnlyKey = await mintBy(mintOnly.token, "mint-only-app-key", {
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "write" },
    });
    for (const [who, credential] of [
      ["an app without keys.manage", mintOnly.token],
      ["that app's key", mintOnlyKey.key],
      [
        "a key without keys.manage from an app that holds it",
        withoutManage.key,
      ],
    ] as const) {
      const label = `refused-owner-key-${randomUUID()}`;
      const refused = await call(credential, "POST", "/keys", {
        ...named(label),
        type_permissions: { "core.note": "read" },
        owner_key: true,
      });
      expect(refused.status, who).toBe(403);
      expect(refusal(refused).code, who).toBe("forbidden");
      expect(refusal(refused).details?.required_scope, who).toBe("keys.manage");
      expect(await labels(), who).not.toContain(label);
      // The witness: the same mint without the field mints an app's key.
      const apps = await mintBy(credential, `${label}-witness`, {
        type_permissions: { "core.note": "read" },
      });
      expect(apps.oauth_client_id, who).toBeTruthy();
    }
  });

  it("decides owner_key on the caller's access when it mints, not when it was read", async () => {
    const appKey = await mintBy(manageAndMint.token, "app-key-narrowed", {
      permissions: ["keys.mint", "keys.manage"],
      type_permissions: { "core.note": "write" },
    });
    const read = await call(appKey.key, "GET", "/keys/current");
    expect(read.body.permissions).toContain("keys.manage");
    const narrowed = await local("PATCH", `/keys/${appKey.id}`, {
      permissions: ["keys.mint"],
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    const label = `after-narrowing-${randomUUID()}`;
    const refused = await call(appKey.key, "POST", "/keys", {
      ...named(label),
      type_permissions: { "core.note": "read" },
      owner_key: true,
    });
    expect(refused.status).toBe(403);
    expect(refusal(refused).details?.required_scope).toBe("keys.manage");

    // An app whose grant loses keys.manage between its read and its mint.
    const app = await approvedApp(server, [
      "core.note:write",
      "keys.mint",
      "keys.manage",
    ]);
    const before = await mintBy(app.token, "app-before-narrowing", {
      type_permissions: { "core.note": "read" },
      owner_key: true,
    });
    expect(before).not.toHaveProperty("oauth_client_id");
    const grant = await grantOf(app.clientId);
    const reduced = await local("PATCH", `/grants/${grant.id}`, {
      expected_scopes: grant.scopes,
      scopes: ["core.note:write", "keys.mint"],
    });
    expect(reduced.status, JSON.stringify(reduced.body)).toBe(200);
    const afterLabel = `app-after-narrowing-${randomUUID()}`;
    const ended = await call(app.token, "POST", "/keys", {
      ...named(afterLabel),
      type_permissions: { "core.note": "read" },
      owner_key: true,
    });
    expect(ended.status).toBe(401);
    expect(await labels()).not.toContain(label);
    expect(await labels()).not.toContain(afterLabel);
  });

  it("accepts owner_key from a caller no app made and mints the key it would without it", async () => {
    const plain = await localKey("plain-minter", {
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "write" },
    });
    const managing = await localKey("plain-manager", {
      permissions: ["keys.mint", "keys.manage"],
      type_permissions: { "core.note": "write" },
    });
    const body = {
      permissions: [],
      type_permissions: { "core.note": "read" },
      sources: [],
      default_tier: "feed",
    };
    for (const [who, mint] of [
      ["local authority", (b: object) => local("POST", "/keys", b)],
      [
        "a key without keys.manage",
        (b: object) => call(plain.key, "POST", "/keys", b),
      ],
      [
        "a key with keys.manage",
        (b: object) => call(managing.key, "POST", "/keys", b),
      ],
    ] as const) {
      const without = minted(await mint({ ...named("without"), ...body }));
      for (const flag of [true, false]) {
        const withFlag = minted(
          await mint({ ...named("with"), ...body, owner_key: flag }),
        );
        expect(
          withFlag,
          `${who}, owner_key ${String(flag)}`,
        ).not.toHaveProperty("oauth_client_id");
        expect(withFlag).not.toHaveProperty("owner_key");
        for (const field of [
          "permissions",
          "type_permissions",
          "edge_permissions",
          "metadata_permissions",
          "profile_permissions",
          "extension_permissions",
          "sources",
          "default_tier",
          "expires_at",
          "enforcement_override",
        ] as const) {
          expect(
            (withFlag as unknown as Record<string, unknown>)[field],
            `${who}, ${field}`,
          ).toEqual((without as unknown as Record<string, unknown>)[field]);
        }
      }
    }
  });

  it("refuses an owner_key that is not true or false, naming it", async () => {
    for (const value of ["true", 1, 0, null, {}, []]) {
      for (const [who, mint] of [
        ["local authority", (b: object) => local("POST", "/keys", b)],
        [
          "an app that holds keys.manage",
          (b: object) => call(manageAndMint.token, "POST", "/keys", b),
        ],
      ] as const) {
        const label = `bad-owner-key-${randomUUID()}`;
        const refused = await mint({
          ...named(label),
          type_permissions: { "core.note": "read" },
          owner_key: value,
        });
        const at = `${who}, ${JSON.stringify(value)}`;
        expect(refused.status, at).toBe(400);
        expect(refusal(refused).code, at).toBe("validation_error");
        expect(refusal(refused).details?.field, at).toBe("owner_key");
        expect(await labels(), at).not.toContain(label);
      }
    }
  });

  it("records owner_key in the audit entry of the mint", async () => {
    const owners = await mintBy(manageAndMint.token, "audited-owners", {
      type_permissions: { "core.note": "read" },
      owner_key: true,
    });
    const apps = await mintBy(manageAndMint.token, "audited-apps", {
      type_permissions: { "core.note": "read" },
    });
    const entryOf = async (id: string) => {
      const answer = await local(
        "GET",
        `/audit?action=key.create&resource_id=${id}`,
      );
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      const entries = answer.body.data as {
        details: Record<string, unknown>;
      }[];
      expect(entries).toHaveLength(1);
      return entries[0]!.details;
    };
    expect((await entryOf(owners.id)).owner_key).toBe(true);
    // The witness: the app's key's own entry is there, without the field.
    expect(await entryOf(apps.id)).not.toHaveProperty("owner_key");
  });

  it("keeps an owner's key working when its app's grant is narrowed, and then revoked with its keys", async () => {
    const app = await approvedApp(server, [
      "core.note:write",
      "keys.mint",
      "keys.manage",
    ]);
    const writes = { type_permissions: { "core.note": "write" } };
    const owners = await mintBy(app.token, "survives-owners", {
      ...writes,
      owner_key: true,
    });
    const beyond = await mintBy(app.token, "ended-by-narrowing", writes);
    const within = await mintBy(app.token, "ended-by-revoking", {
      type_permissions: { "core.note": "read" },
    });
    for (const key of [owners, beyond, within]) {
      expect(await itemsStatus(server, key.key), key.label).toBe(200);
    }

    const grant = await grantOf(app.clientId);
    const narrowed = await local("PATCH", `/grants/${grant.id}`, {
      expected_scopes: grant.scopes,
      scopes: ["core.note:read", "keys.mint", "keys.manage"],
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    // The witness: the app's key that holds what the owner's key holds ends.
    expect(await itemsStatus(server, beyond.key)).toBe(401);
    expect(await itemsStatus(server, within.key)).toBe(200);
    expect(await itemsStatus(server, owners.key)).toBe(200);

    const revoked = await local(
      "DELETE",
      `/grants/${grant.id}?revoke_keys=true`,
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    // The witness: the app's key its narrowing left ends with the grant.
    expect(await itemsStatus(server, within.key)).toBe(401);
    expect(await itemsStatus(server, owners.key)).toBe(200);
    expect((await listed(owners.id))?.type_permissions).toEqual({
      "core.note": "write",
    });
  });
});

describe("widening a key", () => {
  it("narrows a key through keys.manage alone, and says the key does not hold what a widening adds", async () => {
    const claim = `manager-claim-${randomUUID()}`;
    const manager = await localKey("manager-alone", {
      permissions: ["keys.manage", "webhooks.manage"],
      type_permissions: { "core.note": "write" },
      sources: [claim],
    });
    const target = await localKey("managed-target", {
      type_permissions: { "core.note": "read" },
    });
    for (const [change, detail, named] of [
      [
        { permissions: ["webhooks.manage"] },
        "required_scope",
        "webhooks.manage",
      ],
      [
        { type_permissions: { "core.note": "write" } },
        "required_scope",
        "core.note:write",
      ],
      [{ sources: [claim] }, "source", claim],
    ] as const) {
      const refused = await call(
        manager.key,
        "PATCH",
        `/keys/${target.id}`,
        change,
      );
      const at = JSON.stringify(change);
      expect(refused.status, at).toBe(403);
      expect(refusal(refused).code, at).toBe("forbidden");
      expect(refusal(refused).details?.[detail], at).toBe(named);
      expect(refusal(refused).message, at).toContain("which it does not hold");
      expect(refusal(refused).message, at).toContain("keys.mint");
      expect(refusal(refused).message, at).not.toContain("you do not hold");
    }
    const held = await listed(target.id);
    expect(held?.permissions).toEqual([]);
    expect(held?.type_permissions).toEqual({ "core.note": "read" });
    expect(held?.sources ?? []).toEqual([]);

    // The witness: the same caller narrows the key and relabels it.
    const narrowed = await call(manager.key, "PATCH", `/keys/${target.id}`, {
      label: "managed-target-narrowed",
      type_permissions: {},
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect(narrowed.body.type_permissions).toEqual({});
  });

  it("narrows only, through an app that holds keys.manage and not keys.mint", async () => {
    const target = await localKey("app-managed-target", {
      type_permissions: { "core.note": "read" },
    });
    const refused = await call(
      manageOnly.token,
      "PATCH",
      `/keys/${target.id}`,
      {
        type_permissions: { "core.note": "write" },
      },
    );
    expect(refused.status).toBe(403);
    expect(refusal(refused).details?.required_scope).toBe("core.note:write");
    expect(refusal(refused).message).toContain("keys.mint");
    expect((await listed(target.id))?.type_permissions).toEqual({
      "core.note": "read",
    });
    const narrowed = await call(
      manageOnly.token,
      "PATCH",
      `/keys/${target.id}`,
      {
        type_permissions: {},
      },
    );
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
  });

  it("widens a key within its caller through keys.mint, with keys.manage or without it", async () => {
    const reach = {
      permissions: ["keys.mint", "webhooks.manage"],
      type_permissions: { "core.note": "write" },
    };
    const minter = await localKey("widening-minter", reach);
    const both = await localKey("widening-both", {
      ...reach,
      permissions: [...reach.permissions, "keys.manage"],
    });
    // A mint-only caller reaches a key within its access; with keys.manage
    // the caller reaches one the local command made.
    const ownTarget = await mintBy(minter.key, "minters-target", {
      type_permissions: { "core.note": "read" },
    });
    const anyTarget = await localKey("boths-target", {
      type_permissions: { "core.note": "read" },
    });
    for (const [who, caller, target] of [
      ["keys.mint", minter, ownTarget],
      ["keys.mint and keys.manage", both, anyTarget],
    ] as const) {
      const widened = await call(caller.key, "PATCH", `/keys/${target.id}`, {
        permissions: ["webhooks.manage"],
        type_permissions: { "core.note": "write" },
      });
      expect(widened.status, `${who}: ${JSON.stringify(widened.body)}`).toBe(
        200,
      );
      expect(widened.body.permissions, who).toEqual(["webhooks.manage"]);
      expect(widened.body.type_permissions, who).toEqual({
        "core.note": "write",
      });
    }
  });

  it("widens a key through an app that holds keys.mint and keys.manage", async () => {
    const target = await localKey("app-widened-target", {
      type_permissions: { "core.note": "read" },
    });
    // The witness: an app holding keys.manage alone is refused the same change.
    const refused = await call(
      manageOnly.token,
      "PATCH",
      `/keys/${target.id}`,
      {
        type_permissions: { "core.note": "write" },
      },
    );
    expect(refused.status).toBe(403);
    const widened = await call(
      manageAndMint.token,
      "PATCH",
      `/keys/${target.id}`,
      { type_permissions: { "core.note": "write" } },
    );
    expect(widened.status, JSON.stringify(widened.body)).toBe(200);
    expect(widened.body.type_permissions).toEqual({ "core.note": "write" });
    expect(widened.body).not.toHaveProperty("oauth_client_id");
  });

  it("holds a widening by keys.mint and keys.manage to the caller's own access", async () => {
    const both = await localKey("ceiling-both", {
      permissions: ["keys.mint", "keys.manage"],
      type_permissions: { "core.note": "write" },
    });
    const target = await localKey("ceiling-target", {
      permissions: ["audit.read"],
      type_permissions: { "core.note": "read" },
    });
    for (const [change, scope] of [
      [{ permissions: ["webhooks.manage"] }, "webhooks.manage"],
      [{ type_permissions: { "core.task": "read" } }, "core.task:read"],
      // The key keeps a permission the caller lacks, beside what it gains.
      [{ type_permissions: { "core.note": "write" } }, "audit.read"],
    ] as const) {
      const refused = await call(
        both.key,
        "PATCH",
        `/keys/${target.id}`,
        change,
      );
      const at = JSON.stringify(change);
      expect(refused.status, at).toBe(403);
      expect(refusal(refused).details?.required_scope, at).toBe(scope);
    }
    const held = await listed(target.id);
    expect(held?.permissions).toEqual(["audit.read"]);
    expect(held?.type_permissions).toEqual({ "core.note": "read" });
    // The witness: the same caller widens it once the key holds nothing
    // beyond the caller.
    const widened = await call(both.key, "PATCH", `/keys/${target.id}`, {
      permissions: [],
      type_permissions: { "core.note": "write" },
    });
    expect(widened.status, JSON.stringify(widened.body)).toBe(200);
  });

  it("never widens a key an app made, whoever holds keys.mint and keys.manage", async () => {
    const appKey = await mintBy(manageAndMint.token, "app-made-target", {
      type_permissions: { "core.note": "read" },
    });
    expect(appKey.oauth_client_id).toBe(manageAndMint.clientId);
    const both = await localKey("app-key-widener", {
      permissions: ["keys.mint", "keys.manage"],
      type_permissions: { "core.note": "write" },
    });
    for (const [who, widen] of [
      [
        "local authority",
        (b: object) => local("PATCH", `/keys/${appKey.id}`, b),
      ],
      [
        "a key holding keys.mint and keys.manage",
        (b: object) => call(both.key, "PATCH", `/keys/${appKey.id}`, b),
      ],
      [
        "the app that made it",
        (b: object) =>
          call(manageAndMint.token, "PATCH", `/keys/${appKey.id}`, b),
      ],
    ] as const) {
      const refused = await widen({
        type_permissions: { "core.note": "write" },
      });
      expect(refused.status, who).toBe(403);
      expect(refusal(refused).details?.required_scope, who).toBe(
        "core.note:write",
      );
      expect(refusal(refused).message, who).toContain("an app made");
    }
    expect((await listed(appKey.id))?.type_permissions).toEqual({
      "core.note": "read",
    });
    // The witness: the same caller narrows it.
    const narrowed = await call(both.key, "PATCH", `/keys/${appKey.id}`, {
      type_permissions: {},
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
  });

  it("holds a widening by keys.mint and keys.manage to the caller's own expiry", async () => {
    const expiring = await localKey("expiring-both", {
      permissions: ["keys.mint", "keys.manage", "webhooks.manage"],
      type_permissions: { "core.note": "write" },
      expires_at: later(48),
    });
    const lasting = await localKey("outlives-caller", {
      type_permissions: { "core.note": "read" },
    });
    const refused = await call(expiring.key, "PATCH", `/keys/${lasting.id}`, {
      permissions: ["webhooks.manage"],
    });
    expect(refused.status).toBe(403);
    expect((await listed(lasting.id))?.permissions).toEqual([]);

    const shorter = await localKey("within-caller", {
      type_permissions: { "core.note": "read" },
      expires_at: later(24),
    });
    // The witness: the caller widens a key that expires before it does.
    const widened = await call(expiring.key, "PATCH", `/keys/${shorter.id}`, {
      permissions: ["webhooks.manage"],
    });
    expect(widened.status, JSON.stringify(widened.body)).toBe(200);
    const lengthened = await call(
      expiring.key,
      "PATCH",
      `/keys/${shorter.id}`,
      {
        expires_at: later(36),
      },
    );
    expect(lengthened.status, JSON.stringify(lengthened.body)).toBe(200);
    const kept = (await listed(shorter.id))?.expires_at;
    for (const expires_at of [later(72), null]) {
      const beyond = await call(expiring.key, "PATCH", `/keys/${shorter.id}`, {
        expires_at,
      });
      expect(beyond.status, String(expires_at)).toBe(403);
    }
    expect((await listed(shorter.id))?.expires_at).toBe(kept);
  });
});

describe("claims granted through keys.manage", () => {
  it("grants any source as a claim through keys.manage, on a mint and on an update", async () => {
    const elsewhere = `elsewhere-${randomUUID()}`;
    const connector = `connector:${randomUUID()}`;
    const reach = {
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "write" },
    };
    const minter = await localKey("claims-minter", reach);
    const both = await localKey("claims-both", {
      ...reach,
      permissions: ["keys.mint", "keys.manage"],
    });
    // The witness: a caller holding keys.mint alone is refused the claim.
    const refused = await call(minter.key, "POST", "/keys", {
      ...named("claims-refused"),
      type_permissions: { "core.note": "read" },
      sources: [elsewhere],
    });
    expect(refused.status).toBe(403);
    expect(refusal(refused).details?.source).toBe(elsewhere);

    const claiming = await mintBy(both.key, "claims-granted", {
      type_permissions: { "core.note": "read" },
      sources: [elsewhere, connector],
    });
    expect(claiming.sources).toEqual([elsewhere, connector]);

    const target = await localKey("claims-target", {
      type_permissions: { "core.note": "read" },
    });
    const updated = await call(both.key, "PATCH", `/keys/${target.id}`, {
      sources: [elsewhere],
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.sources).toEqual([elsewhere]);
  });

  it("grants any source as a claim through an app that holds keys.manage", async () => {
    const elsewhere = `app-elsewhere-${randomUUID()}`;
    // The witness: an app without keys.manage is refused the claim.
    const refused = await call(mintOnly.token, "POST", "/keys", {
      ...named("app-claims-refused"),
      type_permissions: { "core.note": "read" },
      sources: [elsewhere],
    });
    expect(refused.status).toBe(403);
    expect(refusal(refused).details?.source).toBe(elsewhere);
    const claiming = await mintBy(manageAndMint.token, "app-claims-granted", {
      type_permissions: { "core.note": "read" },
      sources: [elsewhere],
    });
    expect(claiming.sources).toEqual([elsewhere]);
    const target = await localKey("app-claims-target", {
      type_permissions: { "core.note": "read" },
    });
    const updated = await call(
      manageAndMint.token,
      "PATCH",
      `/keys/${target.id}`,
      { sources: [elsewhere] },
    );
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.sources).toEqual([elsewhere]);
  });

  it("takes as a key's own source one another key claims, through keys.manage", async () => {
    const taken = `taken-${randomUUID()}`;
    await localKey("claims-holder", { sources: [taken] });
    const reach = {
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "write" },
    };
    const minter = await localKey("own-source-minter", reach);
    const both = await localKey("own-source-both", {
      ...reach,
      permissions: ["keys.mint", "keys.manage"],
    });
    // The witness: a caller holding keys.mint alone is refused the source.
    const refused = await call(minter.key, "POST", "/keys", {
      label: "own-source-refused",
      source: taken,
      type_permissions: { "core.note": "read" },
    });
    expect(refused.status).toBe(403);
    expect(refusal(refused).details?.source).toBe(taken);
    const mintedKey = minted(
      await call(both.key, "POST", "/keys", {
        label: "own-source-granted",
        source: taken,
        type_permissions: { "core.note": "read" },
      }),
    );
    expect(mintedKey.source).toBe(taken);
  });

  it("refuses a reserved prefix through keys.manage", async () => {
    const both = await localKey("reserved-both", {
      permissions: ["keys.mint", "keys.manage"],
      type_permissions: { "core.note": "write" },
    });
    const target = await localKey("reserved-target");
    for (const [who, credential] of [
      ["a key holding keys.manage", both.key],
      ["an app holding keys.manage", manageAndMint.token],
    ] as const) {
      for (const reserved of [
        `oauth:${manageAndMint.clientId}`,
        "OAuth:another-app",
        " restored:device",
      ]) {
        const at = `${who}, ${reserved}`;
        for (const answer of [
          await call(credential, "POST", "/keys", {
            ...named("reserved-claim"),
            sources: [reserved],
          }),
          await call(credential, "POST", "/keys", {
            label: "reserved-source",
            source: reserved,
          }),
          await call(credential, "PATCH", `/keys/${target.id}`, {
            sources: [reserved],
          }),
        ]) {
          expect(answer.status, at).toBe(400);
          expect(refusal(answer).code, at).toBe("validation_error");
        }
      }
    }
    expect(await labels()).not.toContain("reserved-claim");
    expect(await labels()).not.toContain("reserved-source");
    expect((await listed(target.id))?.sources ?? []).toEqual([]);
  });
});

describe("keys made through the MCP tool marfa_manage_key", () => {
  const connections: McpConnection[] = [];

  afterAll(async () => {
    await Promise.all(connections.map((connection) => connection.close()));
  });

  async function adminOf(app: App): Promise<McpConnection> {
    const connection = await connectMcp(
      server.apiUrl,
      app.token,
      "2026-07-28",
      "/mcp/admin",
    );
    connections.push(connection);
    return connection;
  }

  function make(
    connection: McpConnection,
    label: string,
    body: Record<string, unknown> = {},
  ) {
    return callTool(connection, "marfa_manage_key", {
      action: "make",
      ...named(label),
      type_permissions: { "core.note": "read" },
      ...body,
    });
  }

  it("makes an owner's key through an app that holds keys.mint and keys.manage, and an app's key without owner_key", async () => {
    const connection = await adminOf(manageAndMint);
    const apps = toolResult(await make(connection, "mcp-apps-key"));
    const owners = toolResult(
      await make(connection, "mcp-owners-key", { owner_key: true }),
    );
    // The witness: without the field, the same call makes an app's key.
    const appKey = apps.key as Key;
    const ownerKey = owners.key as Key;
    expect(appKey.oauth_client_id).toBe(manageAndMint.clientId);
    expect(ownerKey).not.toHaveProperty("oauth_client_id");
    expect(await listed(ownerKey.id)).not.toHaveProperty("oauth_client_id");
    expect((await listed(appKey.id))?.oauth_client_id).toBe(
      manageAndMint.clientId,
    );
    expect(await itemsStatus(server, owners.secret as string)).toBe(200);
  });

  it("refuses owner_key through an app that does not hold keys.manage, and both fields where a key is narrowed", async () => {
    // The app is answered with the scope it lacks, which a client asks the
    // person for (`keys-and-oauth/mcp-challenge-scope`).
    await expect(
      make(await adminOf(mintOnly), "mcp-owner-refused", { owner_key: true }),
    ).rejects.toThrow('required "keys.manage"');
    expect(await labels()).not.toContain("mcp-owner-refused");

    const target = await localKey("mcp-narrow-target", {
      type_permissions: { "core.note": "read" },
    });
    const connection = await adminOf(manageAndMint);
    for (const field of [{ owner_key: true }, { sources: ["elsewhere"] }]) {
      const answer = toolError(
        await callTool(connection, "marfa_manage_key", {
          action: "narrow",
          id: target.id,
          label: "narrowed",
          ...field,
        }),
      );
      expect(answer.code, JSON.stringify(field)).toBe("validation_error");
    }
    // The witness: the same call without them narrows the key.
    const narrowed = toolResult(
      await callTool(connection, "marfa_manage_key", {
        action: "narrow",
        id: target.id,
        label: "narrowed",
      }),
    );
    expect((narrowed.key as Key).label).toBe("narrowed");
  });

  it("grants a claim through an app that holds keys.manage, and refuses it to one that does not", async () => {
    const elsewhere = `mcp-elsewhere-${randomUUID()}`;
    const refused = toolError(
      await make(await adminOf(mintOnly), "mcp-claim-refused", {
        sources: [elsewhere],
      }),
    );
    expect(refused.code).toBe("forbidden");
    expect(await labels()).not.toContain("mcp-claim-refused");

    const granted = toolResult(
      await make(await adminOf(manageAndMint), "mcp-claim-granted", {
        sources: [elsewhere],
      }),
    );
    expect((granted.key as Key).sources).toEqual([elsewhere]);
    expect((await listed((granted.key as Key).id))?.sources).toEqual([
      elsewhere,
    ]);
  });
});
