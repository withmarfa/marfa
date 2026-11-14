import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { SPEC_DIR } from "../../utils/spec-statements.js";
import { refusalLine } from "../../device/cli-adapter.js";
import { requireBinary } from "./harness.js";

/**
 * The codes a refusal carries are the two tables of `device.md`, and the
 * help lists the codes the binary can give. The help is generated from the
 * lists the core and the binary give their codes from, so a code added to
 * either appears in it and fails here until the tables list it.
 */

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "marfa-error-codes-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function environment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("MARFA_")) env[name] = value;
  }
  return { ...env, MARFA_NO_KEYCHAIN: "1" };
}

async function marfa(args: string[]) {
  try {
    const done = await run(requireBinary(), args, {
      env: environment(),
      timeout: 30_000,
    });
    return { code: 0, stdout: done.stdout, stderr: done.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failed.code ?? -1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

/** Every code in the two tables of the section. */
function contractCodes(): string[] {
  const text = readFileSync(join(SPEC_DIR, "device.md"), "utf8");
  const start = text.indexOf("\n## The codes a refusal carries\n");
  expect(start, "the section of codes is missing").toBeGreaterThan(-1);
  const end = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/^\| `([a-z_]+)`/gm)].map((match) => match[1]!);
}

describe("the codes a refusal carries", () => {
  it("lists in its help exactly the codes the contract lists", async () => {
    const help = await marfa(["--help"]);
    expect(help.code, help.stderr).toBe(0);
    const listed = /where error\.code is one of: ([a-z_,\s]+)\./
      .exec(help.stdout)?.[1]
      ?.replace(/\s+/g, " ");
    expect(listed, "the help names no codes").toBeDefined();
    const named = listed!.split(", ").sort();
    const contract = contractCodes().sort();
    // The witness: both lists were read.
    expect(contract).toContain("not_found");
    expect(named).toContain("not_found");
    expect(new Set(contract).size, "a code is listed twice").toBe(
      contract.length,
    );
    expect(named).toEqual(contract);
  });

  it("gives a refusal of each kind a code from the contract's tables", async () => {
    const codes = new Set(contractCodes());
    const store = join(dir, "copy");
    const made = await marfa(["--json", "device", "--db", store, "status"]);
    expect(made.code, made.stderr).toBe(0);
    const id = "00000000-0000-7000-8000-000000000000";
    const refusals: Array<[string, string[]]> = [
      ["usage", ["--json", "items", "get"]],
      ["not_found", ["--json", "device", "--db", store, "items", "get", id]],
      ["no_server", ["--json", "device", "--db", store, "catch-up"]],
      [
        "no_store",
        ["--json", "device", "--db", join(dir, "absent"), "items", "list"],
      ],
      [
        "network",
        [
          "--json",
          "--url",
          "http://127.0.0.1:1",
          "--key",
          "marfa_k1_x",
          "status",
        ],
      ],
    ];
    for (const [expected, args] of refusals) {
      const refused = await marfa(args);
      expect(refused.code, args.join(" ")).not.toBe(0);
      const code = (
        JSON.parse(refusalLine(refused.stderr)) as { error: { code: string } }
      ).error.code;
      expect(code, args.join(" ")).toBe(expected);
      expect(codes.has(code), `${code} is in neither table`).toBe(true);
    }
    // The witness: a word no table lists is not taken for a code.
    expect(codes.has("not_held")).toBe(false);
  });
});
