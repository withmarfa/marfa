import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup } from "../../utils/setup.js";
import { cliContext } from "./harness.js";
import type { CliContext } from "./harness.js";

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
    // The same command answers from a hydrated copy in the folder scenario;
    // here the copy has never been hydrated.
    const store = join(dir, "copy");
    const unhydrated = await c.cli.refused([
      "device",
      "--db",
      store,
      "items",
      "list",
    ]);
    expect(unhydrated.code).toBe(4);
    expect(unhydrated.envelope.exit).toBe(4);
    expect(unhydrated.envelope.error.code).toBe("hydration_incomplete");
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
