import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { DISK_ONLY, everythingClient } from "../../utils/own-blob-server.js";
import { Cli, requireBinary } from "./harness.js";

/**
 * What `marfa restore` prints of what the archive left out, and of the
 * previous instance, after a restore into an instance of its own.
 */
let origin: FreshServer | undefined;
let target: FreshServer | undefined;
let cli: Cli;
let dir: string;

beforeAll(async () => {
  origin = await bootFreshServer("cli-restore-says-origin", DISK_ONLY);
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-restore-says-"));
  target = await bootFreshServer("cli-restore-says-target", {
    ...DISK_ONLY,
    MARFA_BACKUP_PATH: join(dir, "backups"),
    MARFA_BACKUP_INTERVAL_SECONDS: "0",
  });
  cli = new Cli(requireBinary(), target.apiUrl, target.workingKey);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await origin?.stop();
  await target?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
}, FRESH_SERVER_TIMEOUT_MS);

describe("marfa restore", () => {
  it("prints one line on standard error for each kind a restore left out, and what it did with the settings", async () => {
    const exported = await (await everythingClient(origin!)).exportArchive();
    expect(exported.status).toBe(200);
    const path = join(dir, "origin.tar");
    writeFileSync(path, exported.data);

    const outcome = await cli
      .viaSocket(target!.controlSocket)
      .run(["restore", path]);
    expect(outcome.code, outcome.stderr).toBe(0);
    for (const kind of [
      "sign-in",
      "Keys",
      "Apps",
      "Webhooks",
      "Inbound endpoints",
      "connector",
      "addresses",
      "name",
      "audit log",
    ]) {
      expect(outcome.stderr, kind).toContain(kind);
    }
    expect(outcome.stderr).toMatch(/backups\/[0-9a-f-]{36}/);
    expect(outcome.stderr).toMatch(/files\/[0-9a-f-]{36}/);
    expect(outcome.stderr).toContain("no longer runs");
    expect(outcome.stderr).not.toMatch(/safe to delete/i);
  });
});
