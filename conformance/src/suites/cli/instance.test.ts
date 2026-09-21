import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  cleanup,
  trackItem,
  trackKey,
  trackType,
  trackWebhook,
} from "../../utils/setup.js";
import { startReceiver } from "../../utils/webhook-receiver.js";
import type { Receiver } from "../../utils/webhook-receiver.js";
import { cliContext, releaseHeld, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

/**
 * The instance from the terminal: what it says about itself, its keys, its
 * configuration, its audit log, its exports, and the doors an operator
 * holds.
 */

let c: CliContext;
let dir: string;
let receiver: Receiver;

beforeAll(async () => {
  c = await cliContext("instance");
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-instance-"));
  receiver = await startReceiver();
});

afterAll(async () => {
  releaseHeld();
  await receiver.close();
  rmSync(dir, { recursive: true, force: true });
  await cleanup(c.ctx);
});

/** Bytes uploaded from the terminal, answered by their hash. */
async function upload(text: string): Promise<string> {
  const path = join(dir, `${unique("blob")}.txt`);
  writeFileSync(path, text);
  const stored = await c.cli.json<{ hash: string }>(["blobs", "upload", path]);
  return stored.hash;
}

interface Status {
  server: string;
  instance: { name: string; instance_id: string; version: string };
  health: { status: string };
  stats: unknown;
  credential: string | null;
}

describe("the instance from the terminal", () => {
  it("reports the instance it is pointed at, with and without a credential", async () => {
    const root = (await fetch(`${c.apiUrl}/`).then((r) => r.json())) as {
      instance_id: string;
    };
    const anonymous = await c.cli.as(undefined).json<Status>(["status"]);
    expect(anonymous.instance.instance_id).toBe(root.instance_id);
    expect(anonymous.health.status).toBe("ok");
    expect(anonymous.credential).toBeNull();
    expect(anonymous.stats).toBeNull();

    const held = await c.cli.json<Status>(["status"]);
    expect(held.credential).toBe("MARFA_API_KEY");
    expect(held.stats).not.toBeNull();
  });

  it("mints, lists, changes and revokes a key, and a revoked key is refused with exit 5", async () => {
    const source = unique("cli-key");
    const minted = await c.cli.json<{
      id: string;
      key: string;
      label: string;
      source: string;
    }>([
      "keys",
      "create",
      "--label",
      "scenario",
      "--source",
      source,
      "--type-permission",
      "core.note=write",
      "--permission",
      "audit.read",
    ]);
    trackKey(c.ctx, minted.id);
    expect(minted.key).toMatch(/^marfa_k1_/);
    expect(minted.source).toBe(source);

    const listed = await c.cli.json<{
      keys: Array<{ id: string; label: string }>;
    }>(["keys", "list"]);
    expect(listed.keys.map((key) => key.id)).toContain(minted.id);

    const relabeled = await c.cli.json<{ label: string }>([
      "keys",
      "update",
      minted.id,
      "--label",
      "scenario-renamed",
    ]);
    expect(relabeled.label).toBe("scenario-renamed");

    // The minted key reaches what it was given and nothing else.
    const narrow = c.cli.as(minted.key);
    const note = await narrow.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: unique("cli-narrow"), body: "b" }),
    ]);
    trackItem(c.ctx, note.item.id);
    const outside = await narrow.refused(["config", "get"]);
    expect(outside.code).toBe(1);
    expect(outside.envelope.error.code).toBe("forbidden");

    await c.cli.json(["keys", "revoke", minted.id]);
    const revoked = await narrow.refused(["items", "list"]);
    expect(revoked.code).toBe(5);
    expect(revoked.envelope.error.code).toBe("unauthorized");
    expect(revoked.envelope.error.server?.status).toBe(401);
  });

  it("reads and replaces the configuration under a credential that holds config.manage", async () => {
    const root = (await fetch(`${c.apiUrl}/`).then((r) => r.json())) as {
      instance_id: string;
    };
    const config = await c.cli.json<{
      instance_id: string;
      trash_retention_days?: number;
    }>(["config", "get"]);
    expect(config.instance_id).toBe(root.instance_id);
    // A change goes through the door and comes back from the next read,
    // then the configuration is put back as it was whatever the assertions
    // said, since every file after this one runs against the same server:
    // the door replaces whole, so sending the first read back restores it.
    const days = (config.trash_retention_days ?? 30) + 1;
    let replaced: { trash_retention_days: number } | undefined;
    let read: { trash_retention_days: number } | undefined;
    try {
      replaced = await c.cli.json<{ trash_retention_days: number }>(
        ["config", "replace", "--file", "-"],
        { stdin: JSON.stringify({ ...config, trash_retention_days: days }) },
      );
      read = await c.cli.json<{ trash_retention_days: number }>([
        "config",
        "get",
      ]);
    } finally {
      await c.cli.json(["config", "replace", "--file", "-"], {
        stdin: JSON.stringify(config),
      });
    }
    expect(replaced?.trash_retention_days).toBe(days);
    expect(read?.trash_retention_days).toBe(days);
    const restored = await c.cli.json<{ trash_retention_days?: number }>([
      "config",
      "get",
    ]);
    expect(restored.trash_retention_days).toBe(config.trash_retention_days);
  });

  it("reads the audit log, which holds this file's own writes", async () => {
    const created = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: unique("cli-audit"), body: "b" }),
    ]);
    trackItem(c.ctx, created.item.id);
    const audit = await c.cli.json<{
      data: Array<{ resource_id: string; action: string }>;
    }>(["audit", "--resource-id", created.item.id]);
    expect(audit.data.length).toBeGreaterThan(0);
    // The filter reached the wire: every row is the item's, and the create
    // is among them.
    for (const row of audit.data) expect(row.resource_id).toBe(created.item.id);
    expect(audit.data.map((row) => row.action)).toContain("item.create");
  });

  it("exports as NDJSON to stdout and as an archive to a file", async () => {
    const title = unique("cli-export");
    const created = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title, body: "b" }),
    ]);
    trackItem(c.ctx, created.item.id);

    const ndjson = await c.cli.run([
      "export",
      "--format",
      "ndjson",
      "--source",
      c.ctx.source,
    ]);
    expect(ndjson.code).toBe(0);
    const lines = ndjson.stdout
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    // The source filter reached the wire: every item line is this file's,
    // and the edge lines that follow join only those items.
    const exported = new Set<string>();
    for (const line of lines) {
      const record = JSON.parse(line) as {
        item?: { id: string; source: string };
        edge?: { source_id: string; target_id: string };
      };
      if (record.item !== undefined) {
        expect(record.item.source).toBe(c.ctx.source);
        exported.add(record.item.id);
      } else {
        expect(record.edge).toBeDefined();
        expect(exported.has(record.edge!.source_id)).toBe(true);
        expect(exported.has(record.edge!.target_id)).toBe(true);
      }
    }
    expect(ndjson.stdout).toContain(title);

    const archive = join(dir, "export.tar.gz");
    const report = await c.cli.json<{ path: string; size_bytes: number }>([
      "export",
      "--format",
      "archive",
      "--output",
      archive,
    ]);
    expect(report.size_bytes).toBeGreaterThan(0);
    expect(statSync(archive).size).toBe(report.size_bytes);
    // The archive is a whole gzip stream, and the tar inside carries the
    // note by its title: the body is witnessed, not only its length.
    const tar = gunzipSync(readFileSync(archive));
    expect(tar.toString("latin1")).toContain(title);
  });

  it("reaches the operator doors under the operator key and is refused them under a working key", async () => {
    // A type of this scenario's own, so the report below is held against a
    // row that is there rather than against the whole instance. Drift is a
    // platform row an older build seeded and this one no longer ships, and
    // it is computed at boot: no door on a running server can make one, so
    // the report's rows are not this suite's to produce and an assertion
    // that it is empty would be an assertion about somebody else's server.
    // What this scenario owns is a runtime registration, which must never
    // be reported as drift however many rows the report holds.
    const registered = `user.${unique("clidrift").replace(/-/g, "")}`;
    await c.cli.json<{ type: { id: string } }>([
      "types",
      "register",
      "--body",
      JSON.stringify({
        id: registered,
        description: "A type registered from the terminal.",
        fields: { title: { type: "string", description: "The title." } },
        required: ["title"],
      }),
    ]);
    trackType(c.ctx, registered);
    // The witness: the row resolves, so it is a type this instance carries
    // and the absence below is about a row that exists.
    expect(
      (await c.cli.json<{ id: string }>(["types", "get", registered])).id,
    ).toBe(registered);
    const drift = await c.operator.json<{
      types: Array<{ id: string; item_count: number; removable: boolean }>;
    }>(["types", "drift"]);
    expect(drift.types.map((type) => type.id)).not.toContain(registered);
    const refused = await c.cli.refused(["types", "drift"]);
    expect(refused.code).toBe(1);
    expect(refused.envelope.error.server?.status).toBe(403);

    // The stores, the orphan report and the housekeeping table are the
    // operator's too; a job run by name answers what it did, and a name
    // the server does not run is a refusal the envelope carries whole.
    const stores = await c.operator.json<{
      data: { id: string; kind: string }[];
      min_copies: number;
    }>(["blobs", "stores"]);
    expect(stores.data.length).toBeGreaterThan(0);
    expect(stores.data[0]?.kind).toBe("disk");
    expect(stores.min_copies).toBeGreaterThan(0);
    // Two blobs of this scenario's own, one referenced and one not, so the
    // report is read for the hashes this scenario uploaded rather than for
    // the whole instance: the report is a table every credential's sweeps
    // write into, and a run that has already swept somebody else's blob is
    // the common case rather than the odd one.
    const orphaned = await upload("nothing names me");
    const referenced = await upload("an item names me");
    const owner = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.file",
      "--properties",
      JSON.stringify({
        title: unique("cli-orphans"),
        blob_ref: referenced,
        mime_type: "text/plain",
      }),
    ]);
    trackItem(c.ctx, owner.item.id);
    await c.operator.json(["housekeeping", "run", "blob-orphans"]);
    const reported = (
      await c.operator.json<{ data: { hash: string }[] }>(["blobs", "orphans"])
    ).data.map((row) => row.hash);
    // The witness: the door does report, and it reported the hash this
    // scenario uploaded with nothing pointing at it.
    expect(
      reported,
      "the sweep found nothing this scenario uploaded, so the absence below is about a report nothing reaches",
    ).toContain(orphaned);
    expect(
      reported,
      "a blob an item names was reported unreferenced",
    ).not.toContain(referenced);
    const refusedOrphans = await c.cli.refused(["blobs", "orphans"]);
    expect(refusedOrphans.envelope.error.server?.status).toBe(403);
    // The grace is zero on the server the suite boots, so the run after a
    // report purges: the scenario leaves the report as it found it, and the
    // blob it orphaned is gone rather than left for somebody else's run.
    await c.operator.json(["housekeeping", "run", "blob-orphans"]);
    const swept = (
      await c.operator.json<{ data: { hash: string }[] }>(["blobs", "orphans"])
    ).data.map((row) => row.hash);
    expect(swept).not.toContain(orphaned);
    const jobs = await c.operator.json<{ data: { name: string }[] }>([
      "housekeeping",
      "list",
    ]);
    const names = jobs.data.map((job) => job.name);
    expect(names).toContain("trash-purge");
    const ran = await c.operator.json<{ name: string; outcome: string }>([
      "housekeeping",
      "run",
      "trash-purge",
    ]);
    expect(ran.name).toBe("trash-purge");
    expect(ran.outcome).toBe("ok");
    const unknown = await c.operator.refused([
      "housekeeping",
      "run",
      "no-such-job",
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.envelope.error.server?.code).toBe(
      "housekeeping_job_not_found",
    );
    expect(unknown.envelope.error.code).toBe("not_found");
  });

  it("registers, reads, pauses and removes a webhook, and reads its deliveries", async () => {
    const created = await c.cli.json<{
      id: string;
      url: string;
      secret: string;
      active: boolean;
    }>([
      "webhooks",
      "create",
      "--to",
      "https://hooks.example/in",
      "--event",
      "item.created",
    ]);
    trackWebhook(c.ctx, created.id);
    expect(created.url).toBe("https://hooks.example/in");
    expect(created.secret).toBeTruthy();
    expect(created.active).toBe(true);

    const listed = await c.cli.json<{ webhooks: Array<{ id: string }> }>([
      "webhooks",
      "list",
    ]);
    expect(listed.webhooks.map((hook) => hook.id)).toContain(created.id);
    const read = await c.cli.json<{ id: string }>([
      "webhooks",
      "get",
      created.id,
    ]);
    expect(read.id).toBe(created.id);
    const paused = await c.cli.json<{ active: boolean }>([
      "webhooks",
      "update",
      created.id,
      "--inactive",
    ]);
    expect(paused.active).toBe(false);

    // A second subscription on the same event, live and pointed at a
    // receiver this file is running. It is what bounds the absence below:
    // one write, two subscriptions, and the delivery that reaches this one
    // is what says the write was dispatched at all. Asserting the paused
    // subscription's log is empty on its own would pass against a server
    // that had stopped delivering, and against a door that reports nothing.
    const live = await c.cli.json<{ id: string }>([
      "webhooks",
      "create",
      "--to",
      receiver.hookUrl("cli"),
      "--event",
      "item.created",
    ]);
    trackWebhook(c.ctx, live.id);
    const written = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: unique("cli-hooked"), body: "b" }),
    ]);
    trackItem(c.ctx, written.item.id);
    await receiver.waitFor(
      (hit) => hit.path === "/hook/cli" && hit.body.includes(written.item.id),
    );
    const delivered = await vi.waitFor(
      async () => {
        const rows = await c.cli.json<{
          deliveries: Array<{ event_type: string; succeeded: boolean }>;
        }>(["webhooks", "deliveries", live.id]);
        expect(rows.deliveries.length).toBeGreaterThan(0);
        return rows.deliveries;
      },
      { timeout: 20_000, interval: 250 },
    );
    expect(delivered[0]?.event_type).toBe("item.created");
    expect(delivered[0]?.succeeded).toBe(true);

    // The same write, and the paused subscription has nothing: a pause
    // stops delivery rather than only stopping the log.
    const quiet = await c.cli.json<{ deliveries: unknown[] }>([
      "webhooks",
      "deliveries",
      created.id,
    ]);
    expect(quiet.deliveries).toEqual([]);
    await c.cli.json(["webhooks", "delete", created.id]);
    const gone = await c.cli.refused(["webhooks", "get", created.id]);
    expect(gone.envelope.error.code).toBe("not_found");
  });
});
