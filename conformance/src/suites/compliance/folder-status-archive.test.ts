import { afterAll, beforeAll, expect, it } from "vitest";
import { readLineFile } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("folder-status-archive");
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${server.workingKey}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it("keeps witnessed reports outside portable item archives", async () => {
  const made = await call("POST", "/folders", { title: "Sync reports" });
  expect(made.status).toBe(201);
  const id = ((await made.json()) as { item: { id: string } }).item.id;
  const folder_store_id = "portable-archive-witness-copy";
  const reported = await call("PUT", `/folders/${id}/status`, {
    folder_store_id,
    sequence: 1,
    last_success_at: null,
    pending_uploads: 2,
    pending_downloads: 3,
    paused_removals: 1,
    first_sync_waiting: true,
    problems: [{ code: "held_file", count: 2 }],
  });
  expect(reported.status).toBe(200);
  const status = await call("GET", `/folders/${id}/status`);
  expect(
    (
      (await status.json()) as {
        sign_ins: { copies: { folder_store_id: string }[] }[];
      }
    ).sign_ins[0]!.copies[0]!.folder_store_id,
  ).toBe(folder_store_id);
  const archive = await call("GET", "/export?format=archive");
  expect(archive.status).toBe(200);
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const text = (["instance", "items", "edges"] as const)
    .map((name) => readLineFile(bytes, name))
    .join("\n");
  expect(text).toContain(id);
  expect(text).not.toContain(folder_store_id);
});
