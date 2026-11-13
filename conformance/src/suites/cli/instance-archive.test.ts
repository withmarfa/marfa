import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readLineFile } from "../../utils/archive.js";
import { cleanup, trackItem } from "../../utils/setup.js";
import { cliContext, releaseHeld, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

/** An instance's archive from the terminal: written to a file, and taken back. */

let c: CliContext;
let dir: string;

beforeAll(async () => {
  c = await cliContext("instance-archive");
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-instance-archive-"));
});

afterAll(async () => {
  releaseHeld();
  rmSync(dir, { recursive: true, force: true });
  await cleanup(c.ctx);
});

describe("the instance's archive from the terminal", () => {
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

    const archive = join(dir, "export.tar");
    const report = await c.cli.json<{ path: string; size_bytes: number }>([
      "export",
      "--format",
      "archive",
      "--output",
      archive,
    ]);
    expect(report.size_bytes).toBeGreaterThan(0);
    expect(statSync(archive).size).toBe(report.size_bytes);
    // The archive's items carry the note by its title: the body is
    // witnessed, not only its length.
    expect(
      readLineFile(new Uint8Array(readFileSync(archive)), "items"),
    ).toContain(title);
  });

  it("exports the whole archive when no format is given, and the items as text only when asked", async () => {
    const title = unique("cli-export-default");
    const created = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title, body: "b" }),
    ]);
    trackItem(c.ctx, created.item.id);

    const plain = join(dir, "default.tar");
    const report = await c.cli.json<{ content_type: string }>([
      "export",
      "--output",
      plain,
    ]);
    expect(report.content_type).toBe("application/x-tar");
    const archive = new Uint8Array(readFileSync(plain));
    expect(readLineFile(archive, "items")).toContain(title);
    // Standard output is the archive too, as bytes a redirect keeps.
    const piped = await c.cli.run(["export"]);
    expect(piped.code, piped.stderr).toBe(0);
    expect(piped.stdout.startsWith("manifest.json")).toBe(true);

    // The witness: the flag still gives items, one per line, as text.
    const items = await c.cli.run([
      "export",
      "--format",
      "ndjson",
      "--source",
      c.ctx.source,
    ]);
    expect(items.code, items.stderr).toBe(0);
    expect(items.stdout.startsWith("manifest.json")).toBe(false);
    expect(items.stdout).toContain(title);
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

    const archive = join(dir, "restore.tar");
    const written = await c.cli.json<{ size_bytes: number }>([
      "export",
      "--format",
      "archive",
      "--output",
      archive,
    ]);
    expect(written.size_bytes).toBeGreaterThan(0);

    // Every item in it is already here, so the restore counts duplicates
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
});
