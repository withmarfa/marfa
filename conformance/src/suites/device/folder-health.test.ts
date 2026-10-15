import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { afterEach, expect, it } from "vitest";
import { folderHarness, scriptWrites, type FolderHarness } from "./harness.js";

import { writeAnswers } from "../../device/marfa-answers.js";
import type { DoorRow } from "../../device/folder-door.js";
import { scriptFolderWrites } from "./folders.shared.js";

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

it("does not report a send-only run as a full success, where a push that pulls does", async () => {
  harness = await folderHarness("health-send-only");
  scriptWrites(harness.server);
  expect((await harness.folder.pushSendOnly()).ok).toBe(true);
  const [sent] = reports(harness);
  expect(
    sent.last_success_at,
    "a run that caught up with nothing and pulled nothing was reported as a complete sync",
  ).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect((await harness.folder.push()).ok).toBe(true);
  expect(
    reports(harness).at(-1)?.last_success_at,
    "the witness: the same folder, pushed in full, reports a full success",
  ).not.toBeNull();
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

it("keeps dead file effects current until an accepted replacement, survives clear and restart, and restores them on release", async () => {
  const id = "01a00000-0000-7000-8000-00000000000a";
  harness = await folderHarness("health-dead-effects", {
    rows: {
      "core.note": [
        {
          item: {
            id,
            version: 3,
            properties: { title: "Held", body: "baseline\n" },
          },
        },
      ],
    },
  });
  let broken = false;
  scriptFolderWrites(harness, {
    door: (door) => {
      const update = door.update.bind(door);
      door.update = (...args) =>
        broken
          ? { kind: "json", status: 200, body: "unreadable answer" }
          : update(...args);
    },
  });
  expect((await harness.folder.push()).ok).toBe(true);
  const path = `${harness.dir}/Held.md`;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("baseline", "dead bytes"),
  );
  expect((await harness.folder.scan()).ok).toBe(true);
  broken = true;
  const device = harness.folder.device();
  for (let attempt = 0; attempt < 5; attempt++)
    expect((await device.drain()).ok).toBe(true);
  const queue = await device.queue();
  expect(queue.ok).toBe(true);
  if (!queue.ok) return;
  const dead = queue.value.find((row) => row.verdict === "dead");
  expect(dead).toBeDefined();
  if (dead === undefined) return;
  expect((await harness.folder.push()).ok).toBe(true);
  expect(reports(harness).at(-1)?.pending_uploads).toBe(1);
  expect(reports(harness).at(-1)?.problems).toContainEqual({
    code: "held_file",
    count: 1,
  });
  const heldSuccess = reports(harness).at(-1)?.last_success_at;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("dead bytes", "accepted bytes"),
  );
  broken = false;
  expect((await harness.folder.push()).ok).toBe(true);
  expect(reports(harness).at(-1)?.pending_uploads).toBe(0);
  expect(reports(harness).at(-1)?.problems).toEqual([]);
  expect(reports(harness).at(-1)?.last_success_at).not.toBe(heldSuccess);
  expect((await device.forget()).ok).toBe(true);
  expect((await harness.folder.push()).ok).toBe(true);
  expect(readFileSync(path, "utf8")).toContain("accepted bytes");
  expect(reports(harness).at(-1)?.pending_uploads).toBe(0);
  expect((await device.release({ id: dead.id })).ok).toBe(true);
  const projected = await device.get(id);
  expect(projected.ok && projected.value.properties.body).toBe("dead bytes\n");
  broken = true;
  for (let attempt = 0; attempt < 5; attempt++)
    expect((await device.drain()).ok).toBe(true);
  expect((await harness.folder.push()).ok).toBe(true);
  expect(reports(harness).at(-1)?.pending_uploads).toBe(1);
  expect(reports(harness).at(-1)?.problems).toContainEqual({
    code: "held_file",
    count: 1,
  });
  const releasedQueue = await device.queue();
  expect(releasedQueue.ok).toBe(true);
  if (releasedQueue.ok) {
    const released = releasedQueue.value.find((row) => row.id === dead.id);
    expect(released?.body).toEqual(dead.body);
    expect(released?.idempotency_key).not.toBe(dead.idempotency_key);
  }
});

it("reports an unreadable unbound directory as incomplete inventory and clears it after readable recovery", async () => {
  harness = await folderHarness("health-partial-inventory");
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  const success = reports(harness).at(-1)?.last_success_at;
  const child = `${harness.dir}/unreadable`;
  mkdirSync(child);
  writeFileSync(`${child}/Unbound.md`, "unbound bytes\n");
  const witness = await harness.folder.status();
  expect(
    witness.ok &&
      witness.value.files.some((file) => file.path === "unreadable/Unbound.md"),
  ).toBe(true);
  chmodSync(child, 0);
  try {
    const partial = await harness.folder.status();
    expect(
      partial.ok &&
        partial.value.directories.some((entry) => entry.flag === "unreadable"),
    ).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(reports(harness).at(-1)?.problems).toContainEqual({
      code: "unreadable",
      count: 1,
    });
    expect(reports(harness).at(-1)?.last_success_at).toBe(success);
  } finally {
    chmodSync(child, 0o700);
  }
  rmSync(child, { recursive: true });
  expect((await harness.folder.push()).ok).toBe(true);
  expect(reports(harness).at(-1)?.problems).toEqual([]);
  expect(reports(harness).at(-1)?.last_success_at).not.toBe(success);
});

it("preserves a nonzero known upload count while an unreadable inventory hides unbound files", async () => {
  harness = await folderHarness("health-retained-inventory", {
    confirm: false,
    hydrate: false,
    files: { "unreadable/Unbound.md": "unbound bytes\n" },
  });
  expect((await harness.folder.pushWaiting()).ok).toBe(true);
  const before = reports(harness).at(-1);
  expect(before?.pending_uploads).toBe(1);
  const child = `${harness.dir}/unreadable`;
  writeFileSync(`${child}/Unseen.md`, "unbound unseen bytes\n");
  chmodSync(child, 0);
  try {
    const partial = await harness.folder.status();
    expect(
      partial.ok &&
        partial.value.files.every((file) => file.status !== "waiting"),
    ).toBe(true);
    expect(
      partial.ok &&
        partial.value.files.some(
          (file) => file.path === "unreadable/Unseen.md",
        ),
    ).toBe(false);
    expect((await harness.folder.pushWaiting()).ok).toBe(true);
    const after = reports(harness).at(-1);
    expect(after?.pending_uploads).toBe(1);
    expect(after?.problems).toContainEqual({ code: "unreadable", count: 1 });
    expect(after?.last_success_at).toBeNull();
  } finally {
    chmodSync(child, 0o700);
  }
  rmSync(`${child}/Unseen.md`);
  expect((await harness.folder.pushWaiting()).ok).toBe(true);
  expect(reports(harness).at(-1)?.pending_uploads).toBe(1);
  expect(reports(harness).at(-1)?.problems).toEqual([]);
});

it.each(["replacement", "tag addition"] as const)(
  "preserves accepted %s membership when projecting dead metadata intent",
  async (operation) => {
    const id = "01a00000-0000-7000-8000-00000000000a";
    harness = await folderHarness(`health-dead-metadata-${operation}`, {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 3,
              properties: { title: "Held", body: "baseline\n" },
            },
          },
        ],
      },
    });
    let broken = false;
    let rows: Map<string, DoorRow>;
    scriptFolderWrites(harness, {
      door: (door) => {
        rows = door.rows;
      },
      tagging: (request) => {
        if (broken)
          return {
            kind: "json",
            status: 409,
            body: {
              error: {
                code: "idempotency_key_in_flight",
                message: "this request is still in flight",
              },
            },
          };
        if (request.pathname.endsWith("/metadata")) {
          const row = rows.get(id)!;
          const tags = (JSON.parse(request.body) as { tags: string[] }).tags;
          row.tags =
            request.method === "PUT"
              ? tags
              : [...new Set([...(row.tags ?? []), ...tags])];
          return writeAnswers.metadata(id, row.tags);
        }
        return undefined;
      },
    });
    expect((await harness.folder.push()).ok).toBe(true);
    const device = harness.folder.device();
    const queued =
      operation === "replacement"
        ? await device.addTag(id, "stale")
        : await device.writeMetadata(id, ["old"], "replace");
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    broken = true;
    for (let attempt = 0; attempt < 5; attempt++)
      expect((await device.drain()).ok).toBe(true);
    const dead = await device.queue();
    expect(
      dead.ok &&
        dead.value.some(
          (write) => write.id === queued.value.id && write.verdict === "dead",
        ),
    ).toBe(true);
    broken = false;
    const newer =
      operation === "replacement"
        ? await device.writeMetadata(id, [], "replace")
        : await device.addTag(id, "new");
    expect(newer.ok).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    const observed = await device.get(id);
    expect(observed.ok && observed.value.tags).toEqual(
      operation === "replacement" ? [] : ["new", "old"],
    );
    expect(reports(harness).at(-1)?.pending_uploads).toBe(
      operation === "replacement" ? 0 : 1,
    );
    expect((await device.forget()).ok).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    const restarted = await device.get(id);
    expect(restarted.ok && restarted.value.tags).toEqual(
      operation === "replacement" ? [] : ["new", "old"],
    );
    const kept = await device.queue();
    expect(
      kept.ok &&
        kept.value.some(
          (write) => write.id === queued.value.id && write.verdict === "dead",
        ),
    ).toBe(true);
    expect((await device.release({ id: queued.value.id })).ok).toBe(true);
    const restored = await device.get(id);
    expect(restored.ok && restored.value.tags).toEqual(
      operation === "replacement" ? ["stale"] : ["old"],
    );
  },
);
