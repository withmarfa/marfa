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
  requireApiKey,
  trackItem,
  trackKey,
  trackWebhook,
} from "../../utils/setup.js";
import { expectSignedBy, startReceiver } from "../../utils/webhook-receiver.js";
import type { Receiver } from "../../utils/webhook-receiver.js";
import { cliContext, releaseHeld, unique } from "./harness.js";
import type { Cli, CliContext, ItemEnvelope } from "./harness.js";

/**
 * The instance from the terminal: what it says about itself, its keys, its
 * configuration, its audit log, its exports, and its management operations.
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

/**
 * Runs a housekeeping job by name and answers what the run reported.
 *
 * The server this file shares runs the same housekeeping jobs on its own
 * clock, and a name the scheduler is already running answers `409`: the run
 * in flight is the same work, so the ask is repeated rather than failed.
 */
async function runHousekeepingJob(
  name: string,
): Promise<{ name: string; outcome: string }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const outcome = await c.operator.run([
      "--json",
      "housekeeping",
      "run",
      name,
    ]);
    if (outcome.code === 0) {
      return JSON.parse(outcome.stdout) as { name: string; outcome: string };
    }
    // A refusal the binary makes is one JSON object on stderr. Anything
    // else there is the binary failing outside the envelope, and that text
    // is the finding rather than a parse error over it.
    let envelope: { error: { server: { status: number | null } | null } };
    try {
      envelope = JSON.parse(outcome.stderr.trim()) as typeof envelope;
    } catch {
      throw new Error(`marfa housekeeping run ${name}: ${outcome.stderr}`);
    }
    if (envelope.error.server?.status !== 409) {
      throw new Error(`marfa housekeeping run ${name}: ${outcome.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${name} was held by a run for five seconds`);
}

interface Status {
  server: string;
  instance: { name: string; instance_id: string; version: string };
  health: { status: string };
  stats: unknown;
  credential: string | null;
}

describe("the instance from the terminal", () => {
  it("reads instance metrics with instance.read and refuses a content-only key", async () => {
    const metrics = await c.operator.json<{
      items: { total: number };
      keys: { total: number };
      uptime_seconds: number;
      cached_at: string;
    }>(["metrics"]);
    expect(metrics.items.total).toBeGreaterThanOrEqual(0);
    expect(metrics.keys.total).toBeGreaterThan(0);
    expect(metrics.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(metrics.cached_at))).toBe(false);
    const refused = await c.cli.refused(["metrics"]);
    expect(refused.envelope.error.server?.status).toBe(403);
    expect(refused.envelope.error.server?.code).toBe("forbidden");
  });

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
      data: Array<{ id: string; label: string }>;
      next_cursor: null;
    }>(["keys", "list"]);
    expect(listed.data.map((key) => key.id)).toContain(minted.id);
    expect(listed.next_cursor).toBeNull();

    const relabeled = await c.cli.json<{ label: string }>([
      "keys",
      "update",
      minted.id,
      "--label",
      "scenario-renamed",
    ]);
    expect(relabeled.label).toBe("scenario-renamed");

    // The minted key reaches what it was given and nothing else, and says
    // so of itself.
    const narrow = c.cli.as(minted.key);
    const itself = await narrow.json<{
      id: string;
      permissions: string[];
      type_permissions: Record<string, string>;
    }>(["keys", "current"]);
    expect(itself.id).toBe(minted.id);
    expect(itself.permissions).toEqual(["audit.read"]);
    expect(itself.type_permissions).toEqual({ "core.note": "write" });
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

    // Asked for out loud, a key holding nothing holds nothing on any family.
    const inert = await c.cli.json<{ id: string; key: string }>([
      "keys",
      "create",
      "--label",
      "scenario-inert",
      "--source",
      unique("cli-inert"),
      "--no-permissions",
    ]);
    trackKey(c.ctx, inert.id);
    const held = (
      await c.cli.json<{ data: Array<Record<string, unknown>> }>([
        "keys",
        "list",
      ])
    ).data.find((key) => key.id === inert.id)!;
    const families = (key: Record<string, unknown>) => [
      key.permissions,
      key.type_permissions,
      key.edge_permissions,
      key.metadata_permissions,
      key.extension_permissions,
      key.profile_permissions,
    ];
    expect(
      families(held),
      "a key minted with --no-permissions held something",
    ).toEqual([[], {}, {}, {}, {}, {}]);

    // A key minted too wide is narrowed to nothing in place, rather than
    // revoked and minted again.
    const wide = await c.cli.json<{ id: string; key: string }>([
      "keys",
      "create",
      "--label",
      "scenario-wide",
      "--source",
      unique("cli-wide"),
    ]);
    trackKey(c.ctx, wide.id);
    const wideHeld = async () =>
      (
        await c.cli.json<{ data: Array<Record<string, unknown>> }>([
          "keys",
          "list",
        ])
      ).data.find((key) => key.id === wide.id)!;
    expect(
      (await wideHeld()).permissions,
      "a key minted naming nothing held no permission, so narrowing it below proves nothing",
    ).not.toEqual([]);
    await c.cli.json(["keys", "update", wide.id, "--no-permissions"]);
    expect(
      families(await wideHeld()),
      "a key updated with --no-permissions still held something",
    ).toEqual([[], {}, {}, {}, {}, {}]);

    await c.cli.json(["keys", "revoke", minted.id]);
    const revoked = await narrow.refused(["items", "list"]);
    expect(revoked.code).toBe(5);
    expect(revoked.envelope.error.code).toBe("unauthorized");
    expect(revoked.envelope.error.server?.status).toBe(401);
  });

  it("empties one key permission map at a time and retains every other family", async () => {
    const minted = await c.cli
      .as(requireApiKey())
      .json<{ id: string }>([
        "keys",
        "create",
        "--label",
        "selective-clear",
        "--source",
        unique("cli-selective-clear"),
        "--permission",
        "audit.read",
        "--type-permission",
        "core.note=write",
        "--extension-permission",
        "app.cursor=read",
        "--edge-permission",
        "references=read",
        "--metadata-permission",
        "types=read",
        "--profile-permission",
        "email=read",
      ]);
    trackKey(c.ctx, minted.id);

    const families = [
      ["type_permissions", "--no-type-permissions", { "core.note": "write" }],
      [
        "extension_permissions",
        "--no-extension-permissions",
        { "app.cursor": "read" },
      ],
      ["edge_permissions", "--no-edge-permissions", { references: "read" }],
      ["metadata_permissions", "--no-metadata-permissions", { types: "read" }],
      ["profile_permissions", "--no-profile-permissions", { email: "read" }],
    ] as const;
    const read = async () => {
      const listed = await c.operator.json<{
        data: Array<Record<string, unknown>>;
      }>(["keys", "list"]);
      const key = listed.data.find((entry) => entry.id === minted.id);
      expect(key).toBeDefined();
      return key!;
    };

    let previous = await read();
    expect(previous.permissions).toEqual(["audit.read"]);
    for (const [field, , initial] of families) {
      expect(previous[field]).toEqual(initial);
    }
    for (const [field, flag] of families) {
      await c.operator.json(["keys", "update", minted.id, flag]);
      const current = await read();
      expect(current[field], `${flag} did not clear ${field}`).toEqual({});
      expect(current.permissions).toEqual(previous.permissions);
      for (const [other] of families) {
        if (other !== field) expect(current[other]).toEqual(previous[other]);
      }
      previous = current;
    }
  });

  it("mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5", async () => {
    const DAY_MS = 86_400_000;
    const expiryOf = async (id: string) =>
      (
        await c.operator.json<{
          data: Array<{ id: string; expires_at: string | null }>;
        }>(["keys", "list"])
      ).data.find((key) => key.id === id)?.expires_at;

    // A duration from now, on the command's own clock.
    const weekly = await c.cli.json<{ id: string; expires_at: string | null }>([
      "keys",
      "create",
      "--label",
      "expiring-in",
      "--source",
      unique("cli-expiring-in"),
      "--type-permission",
      "core.note=read",
      "--expires-in",
      "7d",
    ]);
    trackKey(c.ctx, weekly.id);
    const mintedFor = Date.parse(weekly.expires_at ?? "") - Date.now();
    expect(
      Math.abs(mintedFor - 7 * DAY_MS),
      `--expires-in 7d minted a key expiring ${String(weekly.expires_at)}`,
    ).toBeLessThan(600_000);
    expect(await expiryOf(weekly.id)).toBe(weekly.expires_at);

    // A time of its own at mint, which the server reads and answers in UTC.
    const exact = new Date(Date.now() + 2 * DAY_MS);
    const dated = await c.cli.json<{ id: string; expires_at: string | null }>([
      "keys",
      "create",
      "--label",
      "expiring-at",
      "--source",
      unique("cli-expiring-at"),
      "--type-permission",
      "core.note=read",
      "--expires-at",
      `${exact.toISOString().slice(0, 19)}Z`,
    ]);
    trackKey(c.ctx, dated.id);
    expect(dated.expires_at).toBe(`${exact.toISOString().slice(0, 19)}.000Z`);

    // A duration and a time together are a wrong command line.
    const both = await c.cli.refused([
      "keys",
      "create",
      "--label",
      "expiring-both",
      "--source",
      unique("cli-expiring-both"),
      "--expires-in",
      "7d",
      "--expires-at",
      exact.toISOString(),
    ]);
    expect(both.code).toBe(2);
    expect(both.envelope.error.code).toBe("usage");
    for (const args of [
      ["--expires-in", "7d", "--expires-at", exact.toISOString()],
      ["--no-expiry", "--expires-in", "7d"],
      ["--no-expiry", "--expires-at", exact.toISOString()],
    ]) {
      const refusedUpdate = await c.cli.refused([
        "keys",
        "update",
        weekly.id,
        ...args,
      ]);
      expect(refusedUpdate.code, args.join(" ")).toBe(2);
      expect(refusedUpdate.envelope.error.code, args.join(" ")).toBe("usage");
    }

    // A time of its own, shortened by a caller that can only narrow.
    const shorter = new Date(Date.now() + DAY_MS).toISOString();
    const shortened = await c.operator.json<{ expires_at: string }>([
      "keys",
      "update",
      weekly.id,
      "--expires-at",
      shorter,
    ]);
    expect(shortened.expires_at).toBe(shorter);
    const lengthened = await c.operator.refused([
      "keys",
      "update",
      weekly.id,
      "--expires-in",
      "30d",
    ]);
    expect(lengthened.code).toBe(1);
    expect(lengthened.envelope.error.code).toBe("forbidden");
    const kept = await c.operator.refused([
      "keys",
      "update",
      weekly.id,
      "--no-expiry",
    ]);
    expect(kept.envelope.error.code).toBe("forbidden");
    expect(await expiryOf(weekly.id)).toBe(shorter);

    // A caller that is not held to narrowing clears it, and the key reads back with none.
    const cleared = await c.cli.json<{ expires_at: string | null }>([
      "keys",
      "update",
      weekly.id,
      "--no-expiry",
    ]);
    expect(cleared.expires_at).toBeNull();
    expect(await expiryOf(weekly.id)).toBeNull();

    // A duration on an update is measured from now, as it is on a mint.
    const again = await c.cli.json<{ expires_at: string | null }>([
      "keys",
      "update",
      weekly.id,
      "--expires-in",
      "2d",
    ]);
    expect(
      Math.abs(Date.parse(again.expires_at ?? "") - Date.now() - 2 * DAY_MS),
      `--expires-in 2d set ${String(again.expires_at)}`,
    ).toBeLessThan(600_000);

    // A time that has passed, and a duration that is no duration, are
    // refused, and the key keeps the expiry it had.
    const past = await c.cli.refused([
      "keys",
      "update",
      weekly.id,
      "--expires-at",
      "2001-01-01T00:00:00Z",
    ]);
    expect(past.code).toBe(1);
    expect(past.envelope.error.server?.code).toBe("validation_error");
    for (const nonsense of ["soon", "0d", "7y", "1.5h", "7", "-1d"]) {
      const refused = await c.cli.refused([
        "keys",
        "update",
        weekly.id,
        `--expires-in=${nonsense}`,
      ]);
      expect(refused.code, nonsense).toBe(1);
      expect(refused.envelope.error.code, nonsense).toBe("invalid");
      expect(refused.envelope.error.server, nonsense).toBeNull();
    }
    expect(await expiryOf(weekly.id)).toBe(again.expires_at);

    // A key works until its expiry and is refused after it.
    const brief = await c.cli.json<{ id: string; key: string }>([
      "keys",
      "create",
      "--label",
      "expiring-soon",
      "--source",
      unique("cli-expiring-soon"),
      "--type-permission",
      "core.note=read",
      "--expires-in",
      "8s",
    ]);
    trackKey(c.ctx, brief.id);
    const holder = c.cli.as(brief.key);
    expect((await holder.json<{ id: string }>(["keys", "current"])).id).toBe(
      brief.id,
    );
    const deadline = Date.now() + 30_000;
    let refused: Awaited<ReturnType<Cli["refused"]>> | undefined;
    while (refused === undefined && Date.now() < deadline) {
      const outcome = await holder.run(["--json", "keys", "current"]);
      if (outcome.code === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      } else {
        refused = await holder.refused(["keys", "current"]);
      }
    }
    expect(refused, "the key was never refused after its expiry").toBeDefined();
    expect(refused?.code).toBe(5);
    expect(refused?.envelope.error.code).toBe("unauthorized");
    expect(refused?.envelope.error.server?.status).toBe(401);
  });

  it("mints a key claiming a source, and a create under it names that source until the claim is taken away", async () => {
    const claimed = unique("cli-claimed");
    const socket = process.env.MARFA_CONTROL_SOCKET;
    expect(
      socket,
      "the fixture exposes its private control socket",
    ).toBeTruthy();
    const minted = await c.cli.viaSocket(socket!).json<{
      id: string;
      key: string;
      sources: string[];
    }>(["keys", "create", "--label", "claimer", "--source", unique("cli-claimer"), "--type-permission", "core.note=write", "--claim", claimed]);
    trackKey(c.ctx, minted.id);
    expect(minted.sources).toEqual([claimed]);

    const claimer = c.cli.as(minted.key);
    const create = (title: string) => [
      "items",
      "create",
      "--type",
      "core.note",
      "--source",
      claimed,
      "--properties",
      JSON.stringify({ title: unique(title), body: "b" }),
    ];
    const note = await claimer.json<ItemEnvelope>(create("cli-claimed"));
    trackItem(c.ctx, note.item.id);
    expect(note.item.source).toBe(claimed);

    const unclaimed = await c.operator.json<{ sources: string[] }>([
      "keys",
      "update",
      minted.id,
      "--no-claims",
    ]);
    expect(unclaimed.sources).toEqual([]);
    const refused = await claimer.refused(create("cli-unclaimed"));
    expect(refused.code).toBe(1);
    expect(refused.envelope.error.code).toBe("forbidden");
  });

  it("lists, renames and ends a sign-in through the private socket, and refuses an ordinary key", async () => {
    const socket = process.env.MARFA_CONTROL_SOCKET;
    expect(
      socket,
      "the fixture exposes its private control socket",
    ).toBeTruthy();
    const local = c.cli.viaSocket(socket!);
    const label = unique("cli-sign-in");
    const minted = await local.json<{ id: string; key: string }>([
      "keys",
      "create",
      "--label",
      label,
      "--source",
      unique("cli-sign-in-source"),
      "--type-permission",
      "core.note=read",
    ]);
    trackKey(c.ctx, minted.id);
    const holder = c.cli.as(minted.key);
    // The witness: the key reaches the server before it is ended.
    await holder.json(["keys", "current"]);

    interface SignIn {
      id: string;
      kind: string;
      name: string;
      current: boolean;
    }
    const listed = await local.json<{ data: SignIn[] }>(["sign-ins", "list"]);
    expect(listed.data.find((row) => row.id === minted.id)).toMatchObject({
      kind: "key",
      name: label,
      current: false,
    });
    const plain = await local.run(["sign-ins", "list"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(`${minted.id}  key      ${label}`);

    const renamed = await local.json<SignIn>([
      "sign-ins",
      "rename",
      minted.id,
      `${label} renamed`,
    ]);
    expect(renamed).toMatchObject({ id: minted.id, name: `${label} renamed` });

    for (const ordinary of [c.cli, c.operator]) {
      const refused = await ordinary.refused(["sign-ins", "list"]);
      expect(refused.code).toBe(1);
      expect(refused.envelope.error.server?.code).toBe("forbidden");
    }

    expect(await local.json(["sign-ins", "end", minted.id])).toEqual({
      ok: true,
    });
    const after = await holder.refused(["keys", "current"]);
    expect(after.code).toBe(5);
    expect(after.envelope.error.server?.status).toBe(401);
    const again = await local.refused(["sign-ins", "end", minted.id]);
    expect(again.code).toBe(1);
    expect(again.envelope.error.server?.code).toBe("sign_in_not_found");
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

  it("takes an archive back through the private socket and refuses ordinary keys", async () => {
    // The other half of the archive round trip, reachable from the client
    // because the door is published: a published door the reference client
    // cannot call is a hole, which is what the binary's own coverage gate
    // is for.
    const title = unique("cli-restore");
    const created = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title, body: "b" }),
    ]);
    trackItem(c.ctx, created.item.id);

    const archive = join(dir, "restore.tar.gz");
    const written = await c.cli.json<{ size_bytes: number }>([
      "export",
      "--format",
      "archive",
      "--output",
      archive,
    ]);
    expect(written.size_bytes).toBeGreaterThan(0);

    // Every row in it is already here, so the restore counts duplicates
    // rather than imports. That the counts come back at all is what says
    // the archive reached the door and was read.
    const socket = process.env.MARFA_CONTROL_SOCKET;
    expect(
      socket,
      "the fixture exposes its private control socket",
    ).toBeTruthy();
    const report = await c.cli.viaSocket(socket!).json<{
      imported: number;
      duplicates: number;
      edges_imported: number;
    }>(["restore", archive]);
    expect(report.duplicates).toBeGreaterThanOrEqual(1);
    expect(report.imported).toBeGreaterThanOrEqual(0);

    // The same archive is refused under both content and management keys.
    const refused = await c.cli.refused(["restore", archive]);
    expect(refused.envelope.error.server?.status).toBe(403);
    const managerRefused = await c.operator.refused(["restore", archive]);
    expect(managerRefused.envelope.error.server?.status).toBe(403);
  });

  it("downloads a blob through the private socket, byte for byte", async () => {
    const socket = process.env.MARFA_CONTROL_SOCKET;
    expect(
      socket,
      "the fixture exposes its private control socket",
    ).toBeTruthy();
    const viaSocket = c.cli.viaSocket(socket!);

    // Bytes that are not text, uploaded under the ordinary key, so the
    // download below is the only thing the socket is asked to do.
    const bytes = Buffer.alloc(4096);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) % 256;
    const source = join(dir, "socket-blob.bin");
    writeFileSync(source, bytes);
    const uploaded = await c.cli.json<{ hash: string }>([
      "blobs",
      "upload",
      source,
    ]);

    const out = join(dir, "socket-blob.out");
    await viaSocket.json(["blobs", "download", uploaded.hash, "--output", out]);
    expect(readFileSync(out).equals(bytes)).toBe(true);
  });

  it("explains a 401 through the private socket as an operation that needs a key, for streamed and plain commands", async () => {
    const socket = process.env.MARFA_CONTROL_SOCKET;
    expect(
      socket,
      "the fixture exposes its private control socket",
    ).toBeTruthy();
    const viaSocket = c.cli.viaSocket(socket!);

    // Witness: the plain and the streamed command both succeed under the
    // key, so what follows is the server's 401 and not the command line.
    expect((await c.cli.run(["--json", "items", "list"])).code).toBe(0);
    expect((await c.cli.run(["--json", "export"])).code).toBe(0);

    // Direct local authority carries no key, so the server answers 401.
    for (const args of [["items", "list"], ["export"], ["events"]]) {
      const label = args.join(" ");
      const refused = await viaSocket.refused(args);
      expect(refused.code, label).toBe(5);
      expect(refused.envelope.error.code, label).toBe("unauthorized");
      expect(refused.envelope.error.server?.status, label).toBe(401);
      expect(refused.envelope.error.message, label).toContain(
        "this operation needs a key or a token, which --socket does not carry; run it without --socket",
      );
    }
  });

  it("reaches management operations with named permissions and refuses a content key", async () => {
    const drift = await c.operator.json<{
      data: Array<{ id: string; item_count: number; removable: boolean }>;
    }>(["types", "drift"]);
    // **What this asserts is that the door answers and who it answers to**,
    // and nothing about how many rows it holds. Drift is a platform row an
    // older build seeded and this one no longer ships, computed once at
    // boot: no door on a running server can make one, so a report read here
    // is empty on every server this suite could be pointed at and an
    // assertion that it is empty would pass against a handler that reports
    // nothing. The server's own suite is where the populated report is
    // proved, because seeding a drifted row is in-process work.
    expect(Array.isArray(drift.data)).toBe(true);
    const refused = await c.cli.refused(["types", "drift"]);
    expect(refused.code).toBe(1);
    expect(refused.envelope.error.server?.status).toBe(403);

    // The stores, the orphan report and the housekeeping table are the
    // operator's too; a housekeeping job run by name answers what it did,
    // and a name the server does not run is a refusal the envelope carries
    // whole.
    const stores = await c.operator.json<{
      data: { id: string; kind: string }[];
      min_copies: number;
    }>(["blobs", "stores"]);
    expect(stores.data.length).toBeGreaterThan(0);
    expect(stores.data[0]?.kind).toBe("disk");
    expect(stores.min_copies).toBeGreaterThan(0);
    // Two blobs of this scenario's own, one referenced and one not, so the
    // report is read for the hashes this scenario uploaded rather than for
    // the whole instance: it is one table the whole instance writes into,
    // and a run that has already swept somebody else's blob is the common
    // case rather than the odd one.
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
    // Driven until one run answers for a hash of this scenario's own. The
    // grace is zero on the server the suite boots, so the sweep's own run
    // on its own clock purges what the run below reported the moment it
    // lands between the run and the read — which is a race rather than the
    // contract failing, and a fresh upload is what takes it out of the way.
    // Only the positive witness is retried. The negative is held against
    // the report the loop settled on, because a retry after a report that
    // named the referenced blob would purge that blob and the evidence with
    // it, and pass the second time round against nothing.
    let orphaned = "";
    let reported: string[] = [];
    await vi.waitFor(
      async () => {
        orphaned = await upload(`nothing names me ${unique("orphan")}`);
        await runHousekeepingJob("blob-orphans");
        reported = (
          await c.operator.json<{ data: { hash: string }[] }>([
            "blobs",
            "orphans",
          ])
        ).data.map((row) => row.hash);
        // The witness: the door does report, and it reported the hash this
        // scenario uploaded with nothing pointing at it.
        expect(
          reported,
          "the sweep found nothing this scenario uploaded, so the absence below is about a report nothing reaches",
        ).toContain(orphaned);
      },
      { timeout: 30_000, interval: 250 },
    );
    expect(
      reported,
      "a blob an item names was reported unreferenced",
    ).not.toContain(referenced);
    const refusedOrphans = await c.cli.refused(["blobs", "orphans"]);
    expect(refusedOrphans.envelope.error.server?.status).toBe(403);
    // Reported on one run and purged on the next. This run also re-reports
    // whatever else on the instance is unreferenced, as any run does; what
    // it must never do is touch the blob an item names, which is why those
    // bytes are read back after it rather than trusted to a report.
    await runHousekeepingJob("blob-orphans");
    const swept = (
      await c.operator.json<{ data: { hash: string }[] }>(["blobs", "orphans"])
    ).data.map((row) => row.hash);
    expect(
      swept,
      "the blob reported on the previous run was not purged on this one",
    ).not.toContain(orphaned);
    const kept = await c.cli.run(["blobs", "download", referenced]);
    expect(
      kept.code,
      `the blob an item names did not survive the sweeps: ${kept.stderr}`,
    ).toBe(0);
    expect(kept.stdout).toBe("an item names me");
    const jobs = await c.operator.json<{ data: { name: string }[] }>([
      "housekeeping",
      "list",
    ]);
    const names = jobs.data.map((job) => job.name);
    expect(names).toContain("trash-purge");
    const ran = await runHousekeepingJob("trash-purge");
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

    const listed = await c.cli.json<{ data: Array<{ id: string }> }>([
      "webhooks",
      "list",
    ]);
    expect(listed.data.map((hook) => hook.id)).toContain(created.id);
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
          data: Array<{ event_type: string; succeeded: boolean }>;
        }>(["webhooks", "deliveries", live.id]);
        expect(rows.data.length).toBeGreaterThan(0);
        return rows.data;
      },
      { timeout: 20_000, interval: 250 },
    );
    expect(delivered[0]?.event_type).toBe("item.created");
    expect(delivered[0]?.succeeded).toBe(true);

    // The same write, and the paused subscription has nothing: a pause
    // stops delivery rather than only stopping the log.
    const quiet = await c.cli.json<{ data: unknown[] }>([
      "webhooks",
      "deliveries",
      created.id,
    ]);
    expect(quiet.data).toEqual([]);
    await c.cli.json(["webhooks", "delete", created.id]);
    const gone = await c.cli.refused(["webhooks", "get", created.id]);
    expect(gone.envelope.error.code).toBe("not_found");
  });

  it("redelivers a failed webhook delivery and reports permission and state refusals", async () => {
    const failing = await startReceiver({ status: 400 });
    try {
      const hook = await c.cli.json<{ id: string; secret: string }>([
        "webhooks",
        "create",
        "--to",
        failing.hookUrl("failed"),
        "--event",
        "item.created",
      ]);
      trackWebhook(c.ctx, hook.id);
      const item = await c.cli.json<ItemEnvelope>([
        "items",
        "create",
        "--type",
        "core.note",
        "--properties",
        JSON.stringify({ title: unique("cli-redeliver"), body: "b" }),
      ]);
      trackItem(c.ctx, item.item.id);
      const first = await failing.waitFor((hit) =>
        hit.body.includes(item.item.id),
      );
      expectSignedBy(first, hook.secret);
      const deliveryId = (JSON.parse(first.body) as { delivery_id: string })
        .delivery_id;
      const failed = await vi.waitFor(
        async () => {
          const rows = await c.cli.json<{
            data: Array<{
              id: string;
              status: string;
              attempt: number;
              status_code: number | null;
            }>;
          }>(["webhooks", "deliveries", hook.id]);
          const row = rows.data.find((delivery) => delivery.id === deliveryId);
          expect(row?.status).toBe("dead_letter");
          return row!;
        },
        { timeout: 20_000, interval: 250 },
      );
      expect(failed).toMatchObject({ attempt: 1, status_code: 400 });

      const inert = await c.cli.json<{ id: string; key: string }>([
        "keys",
        "create",
        "--label",
        "redelivery-inert",
        "--source",
        unique("cli-redelivery-inert"),
        "--no-permissions",
      ]);
      trackKey(c.ctx, inert.id);
      const args = ["webhooks", "redeliver", hook.id, deliveryId];
      const forbidden = await c.cli.as(inert.key).refused(args);
      expect(forbidden.envelope.error.server?.status).toBe(403);
      expect(forbidden.envelope.error.server?.code).toBe("forbidden");

      const missing = await c.cli.refused([
        "webhooks",
        "redeliver",
        hook.id,
        "missing-delivery",
      ]);
      expect(missing.envelope.error.server?.status).toBe(404);
      expect(missing.envelope.error.server?.code).toBe("webhook_not_found");

      await c.cli.json([
        "webhooks",
        "update",
        hook.id,
        "--to",
        receiver.hookUrl("redelivered"),
      ]);
      const queued = await c.cli.json<{
        id: string;
        status: string;
        attempt: number;
        status_code: number | null;
      }>(args);
      expect(queued).toMatchObject({
        id: deliveryId,
        status: "pending",
        attempt: 1,
        status_code: 400,
      });
      const second = await receiver.waitFor(
        (hit) =>
          hit.path === "/hook/redelivered" && hit.body.includes(item.item.id),
      );
      expectSignedBy(second, hook.secret);
      expect(
        (JSON.parse(second.body) as { delivery_id: string }).delivery_id,
      ).toBe(deliveryId);
      await vi.waitFor(
        async () => {
          const rows = await c.cli.json<{
            data: Array<{ id: string; status: string }>;
          }>(["webhooks", "deliveries", hook.id]);
          expect(rows.data.find((row) => row.id === deliveryId)?.status).toBe(
            "success",
          );
        },
        { timeout: 20_000, interval: 250 },
      );
      const conflict = await c.cli.refused(args);
      expect(conflict.envelope.error.server?.status).toBe(409);
      expect(conflict.envelope.error.server?.code).toBe("conflict");
    } finally {
      await failing.close();
    }
  });
});
