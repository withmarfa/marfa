import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
} from "../../utils/signed-in.js";
import { Cli, requireBinary } from "./harness.js";

/**
 * The command line lists an app's own data and deletes it in pages, and
 * deletes it as it ends the app. Apps are signed in by a person, so this file
 * boots a server of its own.
 */
let server: FreshServer;
let origin: string;
let cookie: string;
let local: Cli;

const REGISTERS = "content:write metadata.types:write";
const BIG = 1_050;

beforeAll(async () => {
  server = await bootFreshServer("cli-app-data");
  origin = await issuerOrigin(server);
  cookie = await signIn(server, origin);
  local = new Cli(
    requireBinary(),
    server.apiUrl,
    undefined,
    server.controlSocket,
  );
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function freshVendor(): string {
  const tag = Array.from({ length: 8 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join("");
  return `app.cli${tag}`;
}

async function send(
  token: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${server.apiUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const answer = (await response.json()) as Record<string, unknown>;
  expect(response.status, JSON.stringify(answer)).toBeLessThan(300);
  return answer;
}

/** An app holding a fresh vendor with `count` items of one type. */
async function appHolding(count: number): Promise<{
  vendor: string;
  clientId: string;
}> {
  const vendor = freshVendor();
  const app = await registerApp(server, REGISTERS);
  const token = (await connect(server, origin, cookie, app, REGISTERS))
    .access_token!;
  await send(token, "/types", {
    id: `${vendor}.setting`,
    version: 1,
    fields: { title: { type: "string" } },
  });
  const run = randomUUID().slice(0, 8);
  await send(token, "/items/bulk", {
    mode: "create_only",
    items: Array.from({ length: count }, (_, i) => ({
      type: `${vendor}.setting`,
      source_id: `${run}-${i}`,
      properties: { title: `setting ${i}` },
    })),
  });
  return { vendor, clientId: app.clientId };
}

interface Listed {
  types: Array<{ type: string; active: number }>;
  data: unknown[];
}

it("lists an app's data and deletes it in pages until none is left, and refuses the delete without --confirm PURGE", async () => {
  const { vendor } = await appHolding(BIG);
  const listed = await local.json<Listed>([
    "apps",
    "vendors",
    "data",
    "list",
    vendor,
    "--limit",
    "2",
  ]);
  expect(listed.types).toEqual([
    expect.objectContaining({ type: `${vendor}.setting`, active: BIG }),
  ]);
  expect(listed.data).toHaveLength(2);

  const unconfirmed = await local.run([
    "apps",
    "vendors",
    "data",
    "delete",
    vendor,
  ]);
  expect(unconfirmed.code).not.toBe(0);
  const still = await local.json<Listed>([
    "apps",
    "vendors",
    "data",
    "list",
    vendor,
  ]);
  expect(still.types[0]!.active).toBe(BIG);

  const deleted = await local.run([
    "apps",
    "vendors",
    "data",
    "delete",
    vendor,
    "--confirm",
    "PURGE",
  ]);
  expect(deleted.code, deleted.stderr).toBe(0);
  expect(deleted.stdout).toContain(
    `1000 items deleted so far, ${BIG - 1_000} left`,
  );
  expect(deleted.stdout).toContain(
    `deleted ${BIG} items and 1 type of ${vendor}`,
  );
  const after = await local.json<Listed>([
    "apps",
    "vendors",
    "data",
    "list",
    vendor,
  ]);
  expect(after).toMatchObject({ types: [], data: [] });
});

it("ends an app with its data with apps revoke --remove-data, and keeps it without", async () => {
  interface Grant {
    id: string;
    client_id: string;
    vendors: string[];
  }
  const grants = async () =>
    (await local.json<{ data: Grant[] }>(["apps", "list"])).data;
  const kept = await appHolding(3);
  const removed = await appHolding(3);
  const grantOf = async (clientId: string) =>
    (await grants()).find((grant) => grant.client_id === clientId)!;
  expect((await grantOf(removed.clientId)).vendors).toEqual([removed.vendor]);

  const keptGrant = await grantOf(kept.clientId);
  expect((await local.run(["apps", "revoke", keptGrant.id])).code).toBe(0);
  const keptData = await local.json<Listed>([
    "apps",
    "vendors",
    "data",
    "list",
    kept.vendor,
  ]);
  expect(keptData.data).toHaveLength(3);

  const removedGrant = await grantOf(removed.clientId);
  const refused = await local.run([
    "apps",
    "revoke",
    removedGrant.id,
    "--remove-data",
  ]);
  expect(refused.code).not.toBe(0);
  const unconfirmedEnd = await local.run([
    "sign-ins",
    "end",
    removedGrant.id,
    "--remove-data",
  ]);
  expect(unconfirmedEnd.code).not.toBe(0);
  expect(await grantOf(removed.clientId)).toBeDefined();

  const ended = await local.run([
    "apps",
    "revoke",
    removedGrant.id,
    "--remove-data",
    "--confirm",
    "PURGE",
  ]);
  expect(ended.code, ended.stderr).toBe(0);
  expect(ended.stdout).toContain(
    `revoked the app ${removedGrant.id} and deleted its data`,
  );
  expect(
    (await grants()).some((grant) => grant.client_id === removed.clientId),
  ).toBe(false);
  const removedData = await local.json<Listed>([
    "apps",
    "vendors",
    "data",
    "list",
    removed.vendor,
  ]);
  expect(removedData).toMatchObject({ types: [], data: [] });
});
