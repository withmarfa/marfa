import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackFolder } from "../../utils/setup.js";
import { cliContext } from "./harness.js";
import type { CliContext } from "./harness.js";
import { keychainEnv } from "../../utils/keychain.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import { answers } from "../../device/marfa-answers.js";

/**
 * The six exit codes `marfa --help` documents, each reached once against
 * the real server, so an agent reading the code alone classifies the
 * outcome the way the binary meant it: done, refused, wrong command line,
 * environment, the device rules, the credential.
 */

let c: CliContext;
let dir: string;

beforeAll(async () => {
  c = await cliContext("exits");
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-exits-"));
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await cleanup(c.ctx);
});

describe("the exit codes", () => {
  it("keeps real drain answers and reports a refused credential as exit five", async () => {
    const store = join(dir, "drain");
    const device = ["device", "--db", store];
    await c.cli.json([
      ...device,
      "hydrate",
      "--types",
      "core.note",
      "--tier",
      "library",
    ]);
    await c.cli.json([
      ...device,
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: "drain outcome", body: "fixture" }),
    ]);
    const done = await c.cli.run(["--json", ...device, "drain"]);
    expect(done.code, done.stderr).toBe(0);
    expect(JSON.parse(done.stdout).answered).toBe(1);
    expect(JSON.parse(done.stdout).verdicts[0].verdict, done.stdout).toBe(
      "accepted",
    );
    const pending = await c.cli.json<{ id: string }>([
      ...device,
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: "pending outcome", body: "fixture" }),
    ]);
    const stopped = await c.cli
      .as("marfa_k1_refused_fixture")
      .run(["--json", ...device, "drain"]);
    expect(stopped.code).toBe(5);
    expect(stopped.stderr).toBe("");
    const report = JSON.parse(stopped.stdout);
    expect(report.stopped).toBeTruthy();
    expect(report.verdicts[0].id).toBe(pending.id);
    expect(report.verdicts[0].verdict).toBe("blocked");
    const queue = await c.cli.json<Array<{ id: string }>>([...device, "queue"]);
    expect(queue.some((write) => write.id === pending.id)).toBe(true);
  });

  it.runIf(process.platform === "darwin")(
    "keeps an ended folder renewal local while reaching a real server",
    async () => {
      const folder = await c.cli.json<{ item: { id: string } }>(
        ["folders", "create", "--file", "-", "--title", "renewal fixture"],
        { stdin: JSON.stringify({ search: { types: ["core.note"] } }) },
      );
      trackFolder(c.ctx, folder.item.id);
      const directory = join(dir, "renewal-folder");
      await c.cli.json([
        "folders",
        "add",
        directory,
        "--folder",
        folder.item.id,
      ]);
      const tokenDoor = await ScriptedServer.start();
      try {
        tokenDoor.answer(
          "POST",
          "/token",
          answers.validation("invalid_grant", "fixture sign-in ended"),
        );
        execFileSync("security", [
          "add-generic-password",
          "-A",
          "-s",
          "marfa",
          "-a",
          c.cli.url,
          "-w",
          JSON.stringify({
            kind: "token",
            access_token: "marfa_at_fixture",
            refresh_token: "marfa_rt_fixture",
            expires_at: null,
            client_id: "fixture",
            scope: "*:read",
            token_endpoint: `${tokenDoor.url}/token`,
            revocation_endpoint: null,
          }),
          keychainEnv().MARFA_KEYCHAIN!,
        ]);
        const result = await c.cli
          .as(undefined)
          .refused(["folders", "hydrate", directory]);
        expect(result.code).toBe(5);
        expect(result.envelope.error.code).toBe("signed_out");
        expect(result.envelope.error.server).toBeNull();
      } finally {
        await tokenDoor.stop();
      }
    },
  );

  it("leaves by 0 when done", async () => {
    const outcome = await c.cli.run(["--json", "status"]);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(outcome.stderr).toBe("");
  });

  it("leaves by 1 when the server refuses, carrying the server's answer", async () => {
    // A well-formed id no item has, so the refusal is the door's rather
    // than the validator's.
    const refused = await c.cli.refused([
      "items",
      "get",
      "00000000-0000-7000-8000-000000000000",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.envelope.exit).toBe(1);
    expect(refused.envelope.error.code).toBe("not_found");
    expect(refused.envelope.error.server?.status).toBe(404);
  });

  it("leaves by 2 when the command line is wrong, with the envelope under --json and the usage text without it", async () => {
    const refused = await c.cli.refused(["items", "get"]);
    expect(refused.code).toBe(2);
    expect(refused.envelope.exit).toBe(2);
    expect(refused.envelope.error.code).toBe("usage");
    expect(refused.envelope.error.server).toBeNull();

    const outcome = await c.cli.run(["items", "get"]);
    expect(outcome.code).toBe(2);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("Usage:");
    expect(outcome.stderr.trimStart().startsWith("{")).toBe(false);
  });

  it("leaves by 3 when the server cannot be reached", async () => {
    const unreachable = await c.cli.refused([
      "--url",
      "http://127.0.0.1:1",
      "status",
    ]);
    expect(unreachable.code).toBe(3);
    expect(unreachable.envelope.exit).toBe(3);
    expect(unreachable.envelope.error.code).toBe("network");
    expect(unreachable.envelope.error.server).toBeNull();
  });

  it("leaves by 4 when the working copy refuses under the device rules", async () => {
    const store = join(dir, "copy");
    const made = await c.cli.run(["--json", "device", "--db", store, "status"]);
    expect(made.code, made.stderr).toBe(0);
    // A never-hydrated copy answers local reads, but has no cursor to catch up.
    expect(
      await c.cli.json(["device", "--db", store, "items", "list"]),
    ).toEqual([]);
    const unhydrated = await c.cli.refused([
      "device",
      "--db",
      store,
      "catch-up",
    ]);
    expect(unhydrated.code).toBe(4);
    expect(unhydrated.envelope.exit).toBe(4);
    expect(unhydrated.envelope.error.code).toBe("no_cursor");
  });

  it("leaves by 5 with no credential, and by 5 again when the server refuses the one given", async () => {
    const none = await c.cli.as(undefined).refused(["items", "list"]);
    expect(none.code).toBe(5);
    expect(none.envelope.exit).toBe(5);
    expect(none.envelope.error.code).toBe("no_credential");
    expect(none.envelope.error.server).toBeNull();

    const wrong = await c.cli
      .as("marfa_k1_not_a_key_the_server_minted")
      .refused(["items", "list"]);
    expect(wrong.code).toBe(5);
    expect(wrong.envelope.error.code).toBe("unauthorized");
    expect(wrong.envelope.error.server?.status).toBe(401);
  });
});
