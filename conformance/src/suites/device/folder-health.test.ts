import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { folderHarness, scriptWrites, type FolderHarness } from "./harness.js";

interface Report {
  folder_store_id: string;
  sequence: number;
  last_success_at: string | null;
  pending_uploads: number;
  pending_downloads: number;
  paused_removals: number;
  first_sync_waiting: boolean;
  problems: Array<{ code: string; count: number }>;
}

let harness: FolderHarness | undefined;
let second: FolderHarness | undefined;
afterEach(async () => {
  await second?.stop();
  second = undefined;
  await harness?.stop();
  harness = undefined;
});

function reports(folder: FolderHarness): Report[] {
  return folder.server.requests
    .filter(
      (request) =>
        request.method === "PUT" &&
        request.pathname === `/folders/${folder.settings.id}/status`,
    )
    .map((request) => JSON.parse(request.body) as Report);
}

it("reports a confirmed complete sync using the registry's opaque copy identity", async () => {
  harness = await folderHarness("health-complete");
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  const [report] = reports(harness);
  expect(report.last_success_at).toMatch(/^\d{4}-.*\.\d{3}Z$/);
  expect(report.pending_uploads).toBe(0);
  expect(report.pending_downloads).toBe(0);
  expect(report.problems).toEqual([]);
  const registry = JSON.parse(readFileSync(harness.registry, "utf8")) as {
    folders: Array<{ store: string }>;
  };
  expect(report.folder_store_id).toBe(registry.folders[0].store);
  expect(Object.keys(report).sort()).toEqual(
    [
      "folder_store_id",
      "sequence",
      "last_success_at",
      "pending_uploads",
      "pending_downloads",
      "paused_removals",
      "first_sync_waiting",
      "problems",
    ].sort(),
  );
});

it("reports first-sync waiting without claiming a successful content pass", async () => {
  harness = await folderHarness("health-first", {
    confirm: false,
    hydrate: false,
    files: { "note.md": "a local note\n" },
  });
  expect((await harness.folder.pushWaiting()).ok).toBe(true);
  const [report] = reports(harness);
  expect(report.first_sync_waiting).toBe(true);
  expect(report.last_success_at).toBeNull();
});

it("preserves successful content sync when reporting fails and coalesces across CLI restarts", async () => {
  harness = await folderHarness("health-failure", {
    statusReport: [
      {
        kind: "json",
        status: 503,
        body: {
          error: { code: "unavailable", message: "reporting is unavailable" },
        },
      },
      (request) => ({
        kind: "json",
        status: 200,
        body: {
          accepted: true,
          sequence: (JSON.parse(request.body) as Report).sequence,
          received_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    ],
  });
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect((await harness.folder.push()).ok).toBe(true);
  const delivered = reports(harness);
  expect(delivered).toHaveLength(2);
  expect(delivered[1].sequence).toBeGreaterThan(delivered[0].sequence);
  expect(delivered[1].problems).toEqual([]);
  expect(delivered[1].last_success_at).not.toBeNull();
});

it("distinguishes two directories following the same folder and sign-in", async () => {
  harness = await folderHarness("health-copy-one");
  second = await folderHarness("health-copy-two", {
    sharing: { server: harness.server, key: "device-fixture-key" },
    folder: harness.settings,
    registry: harness.registry,
  });
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  expect((await second.folder.push()).ok).toBe(true);
  const delivered = reports(harness);
  expect(new Set(delivered.map((report) => report.folder_store_id)).size).toBe(
    2,
  );
  expect(delivered.map((report) => report.sequence)).toEqual([1, 1]);
});

it("does not advance last full success after an offline push with an empty queue", async () => {
  harness = await folderHarness("health-offline");
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  const successful = reports(harness)[0];
  await harness.server.offline();
  const offline = await harness.folder.push();
  expect(offline.ok).toBe(true);
  if (offline.ok) expect(offline.value.catch_up).toHaveProperty("failed");
  await harness.server.online();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  // A retry from a restarted watch sends the durable offline report before
  // its first pass can produce a newer observation.
  const watched = harness.folder.watch();
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    await watched.stop();
  }
  const failed = reports(harness).find((report) =>
    report.problems.some((problem) => problem.code === "unavailable"),
  );
  expect(failed).toBeDefined();
  expect(failed?.last_success_at).toBe(successful.last_success_at);
});

it("refreshes the newest local observation above a restored backup sequence", async () => {
  harness = await folderHarness("health-restored", {
    statusReport: [
      {
        kind: "json",
        status: 200,
        body: {
          accepted: false,
          sequence: 40,
          received_at: "2026-01-01T00:00:00.000Z",
        },
      },
      (request) => ({
        kind: "json",
        status: 200,
        body: {
          accepted: true,
          sequence: (JSON.parse(request.body) as Report).sequence,
          received_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    ],
  });
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  writeFileSync(`${harness.dir}/private.md`, Buffer.from([255]));
  expect((await harness.folder.push()).ok).toBe(true);
  const delivered = reports(harness);
  expect(delivered[1].sequence).toBeGreaterThan(40);
  expect(delivered[1].problems).toContainEqual({
    code: "unreadable",
    count: 1,
  });
  expect(JSON.stringify(delivered[1])).not.toContain("private.md");
});
