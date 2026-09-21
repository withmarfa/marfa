import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  cleanup,
  trackItem,
  trackKey,
  trackWebhook,
} from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

/**
 * The instance from the terminal: what it says about itself, its keys, its
 * configuration, its audit log, its exports, and the doors an operator
 * holds.
 */

let c: CliContext;
let dir: string;

beforeAll(async () => {
  c = await cliContext("instance");
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-instance-"));
});

afterAll(async () => {
  await cleanup(c.ctx);
});

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
    const config = await c.cli.json<{ instance_id: string }>(["config", "get"]);
    expect(config.instance_id).toBeTruthy();
    const replaced = await c.cli.json<{ instance_id: string }>(
      ["config", "replace", "--file", "-"],
      { stdin: JSON.stringify(config) },
    );
    expect(replaced.instance_id).toBe(config.instance_id);
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
    const audit = await c.cli.json<{ data: Array<{ resource_id: string }> }>([
      "audit",
      "--resource-id",
      created.item.id,
    ]);
    expect(audit.data.length).toBeGreaterThan(0);
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
    for (const line of lines) JSON.parse(line);
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
    // A gzip stream begins with its magic bytes.
    const head = readFileSync(archive).subarray(0, 2);
    expect([head[0], head[1]]).toEqual([0x1f, 0x8b]);
  });

  it("reaches the operator doors under the operator key and is refused them under a working key", async () => {
    const drift = await c.operator.json<unknown>(["types", "drift"]);
    expect(drift).toBeDefined();
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
    const orphans = await c.operator.json<{ data: unknown[] }>([
      "blobs",
      "orphans",
    ]);
    expect(Array.isArray(orphans.data)).toBe(true);
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
    const deliveries = await c.cli.json<unknown>([
      "webhooks",
      "deliveries",
      created.id,
    ]);
    expect(deliveries).toBeDefined();
    await c.cli.json(["webhooks", "delete", created.id]);
    const gone = await c.cli.refused(["webhooks", "get", created.id]);
    expect(gone.envelope.error.code).toBe("not_found");
  });
});
