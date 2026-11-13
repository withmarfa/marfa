import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Cli, requireBinary } from "./harness.js";

/**
 * `marfa server status` says how the server answered `/health`, and leaves by
 * 0 whenever it can say. The install is a folder of this file's own that
 * names a Docker container, with a stand-in `docker` that reports the
 * container running, and the health door is a listener of this file's own, so
 * what the server answers is what each scenario chooses.
 */

let dir: string;
let health: Server;
let answer: { status: number; body: string } = { status: 200, body: "{}" };
let cli: Cli;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-server-status-"));
  health = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => health.listen(0, "127.0.0.1", done));
  const port = (health.address() as AddressInfo).port;
  const install = join(dir, "install");
  mkdirSync(install);
  writeFileSync(
    join(install, ".env"),
    [
      "MARFA_NAME=statusfixture",
      "MARFA_RELEASE=0.0.0",
      `MARFA_PORT=${String(port)}`,
      "MARFA_ACCESS=local",
      "MARFA_RUNTIME=docker",
      "",
    ].join("\n"),
  );
  const docker = join(dir, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh
case "$1" in
  compose) exit 0 ;;
  info) echo 27.0.0 ;;
  container) echo statusfixture ;;
  inspect) echo '{"Status":"running"}' ;;
  exec) echo '{}' ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  cli = new Cli(requireBinary(), "http://127.0.0.1:1", undefined).withEnv({
    MARFA_DOCKER: docker,
  });
});

afterAll(async () => {
  await new Promise((done) => health.close(done));
  rmSync(dir, { recursive: true, force: true });
});

async function status(): Promise<{
  code: number;
  text: string;
  report: {
    running: boolean;
    answering: boolean;
    healthy: boolean;
    health: { status: string } | null;
    backups: {
      status: string;
      reason: string | null;
      say: string | null;
    } | null;
  };
}> {
  const args = ["server", "status", "--dir", join(dir, "install")];
  const said = await cli.run(args);
  const json = await cli.run(["--json", ...args]);
  expect(json.code, json.stderr).toBe(said.code);
  return {
    code: said.code,
    text: said.stdout,
    report: JSON.parse(json.stdout) as never,
  };
}

describe("marfa server status", () => {
  it("says a server that answers degraded is degraded, and leaves by 0", async () => {
    answer = {
      status: 200,
      body: JSON.stringify({
        status: "degraded",
        components: { disk: { status: "degraded" } },
      }),
    };
    const got = await status();
    expect(got.code).toBe(0);
    expect(got.text).toContain("degraded: disk degraded");
    expect(got.text).not.toContain("running and healthy");
    expect(got.report).toMatchObject({
      running: true,
      answering: true,
      healthy: false,
      health: { status: "degraded" },
    });
  });

  it("says a server that answers down is down, not silent, and leaves by 0", async () => {
    answer = {
      status: 503,
      body: JSON.stringify({
        status: "down",
        components: { database_write: { status: "down" } },
      }),
    };
    const got = await status();
    expect(got.code).toBe(0);
    expect(got.text).toContain("database write down");
    expect(got.text).not.toContain("not answering");
    expect(got.report).toMatchObject({
      answering: true,
      healthy: false,
      health: { status: "down" },
    });
  });

  it("says no backups are kept, and how to set one, when the server has no destination", async () => {
    answer = {
      status: 200,
      body: JSON.stringify({
        status: "ok",
        components: {},
        backups: { status: "off", reason: "no_backup_destination" },
      }),
    };
    const got = await status();
    expect(got.code).toBe(0);
    expect(got.text).toContain("No backups are kept");
    for (const part of [
      "MARFA_BACKUP_PATH",
      "S3_BUCKET",
      join(dir, "install", "marfa.env"),
      "marfa server restart",
    ]) {
      expect(got.text, part).toContain(part);
    }
    expect(got.report.backups).toMatchObject({
      status: "off",
      reason: "no_backup_destination",
      say: expect.stringContaining("No backups are kept"),
    });
  });

  it("says scheduled backups are turned off, apart from having no destination", async () => {
    answer = {
      status: 200,
      body: JSON.stringify({
        status: "ok",
        components: {},
        backups: { status: "off", reason: "turned_off" },
      }),
    };
    const got = await status();
    expect(got.text).toContain("Scheduled backups are turned off");
    expect(got.text).not.toContain("No backups are kept");
    expect(got.text).not.toContain("MARFA_BACKUP_PATH");
    expect(got.report.backups).toMatchObject({
      status: "off",
      reason: "turned_off",
    });
  });

  it("says nothing of backups that run", async () => {
    answer = {
      status: 200,
      body: JSON.stringify({
        status: "ok",
        components: {},
        backups: { status: "ok" },
      }),
    };
    const got = await status();
    expect(got.text).toContain("running and healthy");
    expect(got.text).not.toContain("Backups ");
    expect(got.report.backups).toMatchObject({ status: "ok", say: null });
  });
});
