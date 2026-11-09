import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { Cli, requireBinary } from "./harness.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
let server: FreshServer;
let local: Cli;
beforeAll(async () => {
  server = await bootFreshServer("cli-attention");
  vi.stubEnv("MARFA_API_URL", server.apiUrl);
  local = new Cli(
    requireBinary(),
    server.apiUrl,
    undefined,
    server.controlSocket,
  );
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
  vi.unstubAllEnvs();
}, FRESH_SERVER_TIMEOUT_MS);
interface Inventory {
  data: {
    kind: string;
    reference: string;
    title: string;
    description: string;
  }[];
}
const owner = (path: string, init: RequestInit = {}) =>
  fetch(`${server.apiUrl}${path}`, {
    ...init,
    headers: {
      cookie: server.ownerCookie,
      origin: server.apiUrl,
      "content-type": "application/json",
      ...init.headers,
    },
  });
it("shares owner HTTP and private-socket attention, keeps known concerns, and refuses keys", async () => {
  expect(await local.json(["attention"])).toEqual({ data: [] });
  const key = await owner("/keys", {
    method: "POST",
    body: JSON.stringify({
      label: "Ending",
      source: "attention",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    }),
  });
  expect(key.status).toBe(201);
  const { id } = (await key.json()) as { id: string };
  const throughHttp = await owner("/attention");
  expect(throughHttp.status).toBe(200);
  const http = (await throughHttp.json()) as Inventory;
  await expectMatchesSchema("GET", "/attention", 200, http);
  expect(http.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "key", reference: id }),
    ]),
  );
  expect(await local.json(["attention"])).toEqual(http);
  await server.setFault("fail:housekeeping-read");
  try {
    const incomplete = await local.json<Inventory>(["attention"]);
    expect(incomplete.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "key", reference: id }),
        expect.objectContaining({
          kind: "unavailable",
          reference: "Housekeeping",
        }),
      ]),
    );
  } finally {
    await server.clearFault();
  }

  await server.setFault("free:blobs=0");
  try {
    const impaired = await local.json<Inventory>(["attention"]);
    expect(impaired.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "health", reference: "disk" }),
        expect.objectContaining({ kind: "key", reference: id }),
      ]),
    );
  } finally {
    await server.clearFault();
  }
  expect((await owner("/attention?unknown=1")).status).toBe(400);
  expect((await fetch(`${server.apiUrl}/attention`)).status).toBe(401);
  for (const credential of [server.workingKey, server.managementKey]) {
    const refused = await new Cli(
      requireBinary(),
      server.apiUrl,
      credential,
    ).refused(["attention"]);
    expect(refused.envelope.error.code).toBe("forbidden");
  }
  expect((await owner(`/keys/${id}`, { method: "DELETE" })).status).toBe(200);
  expect(await local.json(["attention"])).toEqual({ data: [] });
  const writer = new Cli(requireBinary(), server.apiUrl, server.workingKey);
  const folder = await writer.json<{ item: { id: string } }>([
    "folders",
    "create",
    "--title",
    "Sync concern",
  ]);
  const report = await fetch(
    `${server.apiUrl}/folders/${folder.item.id}/status`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${server.workingKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        folder_store_id: "copy",
        sequence: 1,
        last_success_at: null,
        pending_uploads: 0,
        pending_downloads: 0,
        paused_removals: 0,
        first_sync_waiting: false,
        problems: [{ code: "conflict", count: 1 }],
      }),
    },
  );
  expect(report.status).toBe(200);
  const registered = await fetch(`${server.apiUrl}/connectors`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.workingKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Quiet connector" }),
  });
  expect(registered.status).toBe(201);
  const connector = (await registered.json()) as { id: string };
  // Registration is the only report so far, and a day without one is quiet.
  await server.advanceClock(2 * 86400000);
  // After the clock moves: the job is then due again, and the scheduler's next
  // poll would run it and replace this failure with a success.
  await server.setFault("fail:housekeeping:audit-cleanup");
  try {
    const ended = await local.json(["housekeeping", "run", "audit-cleanup"]);
    expect(ended).toMatchObject({ name: "audit-cleanup", outcome: "error" });
  } finally {
    await server.clearFault();
  }
  const concerns = await local.json<Inventory>(["attention"]);
  expect(concerns.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "folder", reference: folder.item.id }),
      expect.objectContaining({ kind: "connector", reference: connector.id }),
      expect.objectContaining({ kind: "job", reference: "audit-cleanup" }),
    ]),
  );
});
