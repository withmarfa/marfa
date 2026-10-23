import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { refusalLine } from "../../device/cli-adapter.js";
import { requireBinary } from "./harness.js";

/**
 * What the `types scaffold` fixtures share: the binary run with nothing
 * inherited from `MARFA_*`, and what it printed. It is not a test file, so the
 * `include` globs in `vitest.config.ts` do not run it.
 */

const run = promisify(execFile);

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** The binary with only the `MARFA_*` variables `env` names. */
export async function marfa(
  args: string[],
  env: Record<string, string> = {},
): Promise<Ran> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("MARFA_")) {
      inherited[name] = value;
    }
  }
  try {
    const { stdout, stderr } = await run(requireBinary(), args, {
      env: { ...inherited, ...env },
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failed.code ?? -1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

/** The refusal on standard error, from `--json`. */
export function refusal(ran: Ran): {
  error: { code: string; message: string };
  exit: number;
} {
  return JSON.parse(refusalLine(ran.stderr)) as {
    error: { code: string; message: string };
    exit: number;
  };
}

/** A keychain that does not exist, so anything that reached for a credential would fail. */
export const NO_KEYCHAIN = { MARFA_KEYCHAIN: "/marfa-test-no-keychain" };
