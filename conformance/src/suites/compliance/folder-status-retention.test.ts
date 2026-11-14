import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { DAY_MS, QUIET_SCHEDULE, runJob } from "../../utils/moved-clock.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
} from "../../utils/signed-in.js";

let server: FreshServer;
let origin: string;
let number = 0;
const report = {
  folder_store_id: "copy-a",
  sequence: 1,
  last_success_at: null,
  pending_uploads: 2,
  pending_downloads: 3,
  paused_removals: 1,
  first_sync_waiting: true,
  problems: [{ code: "held_file", count: 2 }],
};
interface Status {
  sign_ins: { sign_in: { kind: string; id: string }; current: boolean }[];
}

beforeAll(async () => {
  server = await bootFreshServer("folder-status-retention", QUIET_SCHEDULE);
  origin = await issuerOrigin(server);
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function call(
  method: string,
  path: string,
  body?: unknown,
  bearer = server.workingKey,
): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      origin,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function folder(): Promise<string> {
  const r = await call("POST", "/folders", { title: "Sync reports" });
  expect(r.status).toBe(201);
  return ((await r.json()) as { item: { id: string } }).item.id;
}
async function key(): Promise<{ id: string; key: string }> {
  number++;
  const r = await call("POST", "/keys", {
    label: "Sync reports",
    source: `folder-status-retention-${number}`,
    type_permissions: { "system.folder": "read" },
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; key: string };
}
async function status(id: string): Promise<Status> {
  const r = await call("GET", `/folders/${id}/status`);
  expect(r.status).toBe(200);
  return (await r.json()) as Status;
}
async function put(id: string, bearer: string): Promise<void> {
  const r = await call("PUT", `/folders/${id}/status`, report, bearer);
  expect(r.status).toBe(200);
}

describe("how long a sign-in's folder reports are kept", () => {
  it("removes a key's reports when the credential clean-up removes the key, and no other sign-in's", async () => {
    const id = await folder();
    const ended = await key();
    const kept = await key();
    await put(id, ended.key);
    await put(id, kept.key);
    expect((await call("DELETE", `/keys/${ended.id}`)).status).toBe(200);
    const history = (await status(id)).sign_ins;
    expect(history.map((g) => [g.sign_in.id, g.current])).toEqual(
      expect.arrayContaining([
        [ended.id, false],
        [kept.id, true],
      ]),
    );

    await server.advanceClock(31 * DAY_MS);
    const run = await runJob(server, "credential-cleanup");
    expect(run.outcome, JSON.stringify(run)).toBe("ok");
    const after = (await status(id)).sign_ins;
    expect(after.map((g) => g.sign_in.id)).toEqual([kept.id]);
  });

  it("removes an app grant's reports when the credential clean-up removes the grant", async () => {
    const id = await folder();
    const cookie = await signIn(server, origin);
    const app = await registerApp(server, "system.folder:read offline_access");
    const token = await connect(
      server,
      origin,
      cookie,
      app,
      "system.folder:read offline_access",
    );
    await put(id, token.access_token!);
    const held = (await status(id)).sign_ins.filter(
      (g) => g.sign_in.kind === "app",
    );
    expect(held).toHaveLength(1);
    const ended = await call("DELETE", `/auth/grants/${held[0]!.sign_in.id}`);
    expect(ended.status).toBe(200);
    const history = (await status(id)).sign_ins.filter(
      (g) => g.sign_in.kind === "app",
    );
    expect(history.map((g) => g.current)).toEqual([false]);

    await server.advanceClock(91 * DAY_MS);
    const run = await runJob(server, "credential-cleanup");
    expect(run.outcome, JSON.stringify(run)).toBe("ok");
    expect(
      (await status(id)).sign_ins.filter((g) => g.sign_in.kind === "app"),
    ).toEqual([]);
  });
});
