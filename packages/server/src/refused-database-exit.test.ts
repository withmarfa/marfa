import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "./storage/sqlite/connection.js";
import { REFUSED_DATABASE_EXIT_CODE } from "./storage/sqlite/refused-database.js";

/**
 * The server process, not the connection: what a supervisor sees when the
 * database on the volume was written by another build.
 */

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function boot(env: Record<string, string>): Promise<{
  status: number | null;
  output: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "test",
        MARFA_AUTH_SECRET: "test-secret-for-local-runs-0123456789abcdef",
        PORT: "8699",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    const kill = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("close", (status) => {
      clearTimeout(kill);
      resolve({ status, output });
    });
  });
}

/** A database file written by a build whose audit log lacked a column. */
async function otherBuildsDatabase(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "marfa-refused-"));
  dirs.push(dir);
  const path = join(dir, "marfa.db");
  const start = SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS `audit_log` (");
  const end = SCHEMA_SQL.indexOf(");", start);
  const table = SCHEMA_SQL.slice(start, end);
  const older = table.replace("\n\t`client_ip` text,", "");
  expect(older).not.toBe(table);
  const client = createClient({ url: `file:${path}` });
  await client.executeMultiple(
    SCHEMA_SQL.slice(0, start) + older + SCHEMA_SQL.slice(end),
  );
  client.close();
  return path;
}

describe("the server process on a database another build wrote", () => {
  it("exits with the refusal's own status, names the way forward, and leaves the file as it found it", async () => {
    const path = await otherBuildsDatabase();
    const before = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");

    const stopped = await boot({
      SQLITE_PATH: path,
      BLOB_PATH: join(path, "..", "blobs"),
    });

    expect(stopped.status).toBe(REFUSED_DATABASE_EXIT_CODE);
    expect(stopped.output).toContain("the audit_log table lacks client_ip");
    expect(stopped.output).toContain("export it with the build that wrote it");
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
      before,
    );
  }, 90_000);

  // The witness that the status is the refusal's and not every failed start's:
  // a stop for another reason, which a supervisor should start again.
  it("exits 1, not the refusal's status, when it stops for another reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marfa-refused-"));
    dirs.push(dir);

    const stopped = await boot({
      SQLITE_PATH: join(dir, "marfa.db"),
      BLOB_PATH: join(dir, "blobs"),
      MARFA_AUTH_SECRET: "short",
    });

    expect(stopped.status).toBe(1);
    expect(stopped.status).not.toBe(REFUSED_DATABASE_EXIT_CODE);
  }, 90_000);
});
