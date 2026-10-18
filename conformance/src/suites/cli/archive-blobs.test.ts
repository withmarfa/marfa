import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  diskPath,
  DISK_ONLY,
} from "../../utils/own-blob-server.js";
import { Cli, releaseHeld, requireBinary } from "./harness.js";

/**
 * An archive the server writes whole but for blobs no store could read, as
 * `marfa export` and `marfa restore` report it.
 *
 * **Why a server of its own.** A blob's file is removed from the server's
 * disk, and no object store may hold a second copy, so the server is booted
 * with its disk store alone.
 */
let server: FreshServer | undefined;
let working: MarfaClient;
let cli: Cli;
let dir: string;
let lost: string;

beforeAll(async () => {
  server = await bootFreshServer("cli-archive-blobs", DISK_ONLY);
  ({ working } = clientsFor(server));
  cli = new Cli(requireBinary(), server.apiUrl, server.workingKey);
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-archive-blobs-"));

  const upload = await working.uploadBlob(
    bytesOf("a blob whose file leaves the disk", 120),
    "text/plain",
  );
  expect(upload.status, JSON.stringify(upload.error)).toBe(201);
  lost = upload.data.hash;
  const note = await working.createItem({
    type: "core.note",
    properties: { body: `![bytes](${lost})` },
  });
  expect(note.status, JSON.stringify(note.error)).toBe(201);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  releaseHeld();
  rmSync(dir, { recursive: true, force: true });
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("an archive that lacks a blob it names", () => {
  it("writes the archive and exits 1 with blobs_missing, naming the blob", async () => {
    const whole = join(dir, "whole.tar.gz");
    // The witness: the same export exits 0 while the file is there.
    await cli.json(["export", "--format", "archive", "--output", whole]);

    unlinkSync(diskPath(server!, lost));
    const path = join(dir, "lacking.tar.gz");
    const refused = await cli.refused([
      "export",
      "--format",
      "archive",
      "--output",
      path,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.envelope.error.code).toBe("blobs_missing");
    expect(refused.envelope.error.message).toContain(lost);
    // Written whole: the gzip stream ends, and the manifest names the blob.
    const tar = gunzipSync(readFileSync(path)).toString("latin1");
    expect(tar).toContain('"missing_blobs":{');
    expect(tar).toContain(lost);

    const toStdout = await cli.run(["--json", "export", "--format", "archive"]);
    expect(toStdout.code).toBe(1);
    expect(toStdout.stderr).toContain("blobs_missing");
  });

  it("prints the answer of a restore of it and exits 1 with blobs_missing", async () => {
    const path = join(dir, "lacking.tar.gz");
    const outcome = await cli
      .viaSocket(server!.controlSocket)
      .run(["--json", "restore", path]);
    expect(outcome.code, outcome.stderr).toBe(1);
    const answer = JSON.parse(outcome.stdout) as { blobs_missing: string[] };
    expect(answer.blobs_missing).toEqual([lost]);
    const envelope = JSON.parse(outcome.stderr) as {
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe("blobs_missing");
    expect(envelope.error.message).toContain(lost);
  });
});
