import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type CatchUpReport,
  type DeviceUnderTest,
  type HydrateReport,
  type Item,
  type ListFilters,
  type Outcome,
  type Refusal,
  type SearchHit,
  type Status,
  type Tier,
} from "./protocol.js";

const run = promisify(execFile);

/**
 * The `marfa` binary, driven as the device under test.
 *
 * There is one device implementation and it is the binary; nothing here is a
 * second engine. The adapter's whole job is translation: an operation becomes
 * a command, stdout becomes an answer, and a non-zero exit becomes a refusal.
 */

/**
 * The binary prints `marfa: <error>` and exits 1. `CoreError` renders one
 * sentence per variant, each with a distinctive opening, so the opening is
 * what the adapter reads. It is a reading of the device rather than a
 * contract with it: when the binary learns to report a refusal as data, this
 * table goes and the code comes from the device.
 */
const REFUSAL_OPENINGS: ReadonlyArray<readonly [string, string]> = [
  ["no server configured", "no_server"],
  ["no event cursor stored", "no_cursor"],
  ["hydration did not complete", "hydration_incomplete"],
  ["the event log no longer holds the cursor", "catch_up_too_old"],
  ["the event stream ended early", "stream_incomplete"],
  ["this file belongs to", "wrong_server"],
  ["not found (", "not_found"],
  ["unauthorized (", "unauthorized"],
  ["forbidden (", "forbidden"],
  ["validation (", "validation"],
  ["unknown type:", "unknown_type"],
  ["rate limited (", "rate_limited"],
  ["server answered", "server"],
  ["network:", "network"],
  ["decoding:", "decoding"],
  ["store:", "store"],
  ["no data directory", "no_data_directory"],
  ["output closed", "closed_output"],
];

function classify(stderr: string, exitCode: number | null): Refusal {
  const raw = stderr.trim();
  const sentence = raw.startsWith("marfa: ")
    ? raw.slice("marfa: ".length)
    : raw;
  for (const [opening, code] of REFUSAL_OPENINGS) {
    if (sentence.startsWith(opening)) return { code, raw };
  }
  if (sentence.includes("is not in the local copy"))
    return { code: "not_held", raw };
  // clap's own refusals, which are the device refusing an operation it does
  // not offer rather than the core refusing one it does.
  if (exitCode === 2 || /^error: |Usage: /m.test(raw))
    return { code: "usage", raw };
  return { code: "unclassified", raw };
}

export interface CliDeviceOptions {
  /** The built binary. The conformance job exports it; a local run may point at a debug build. */
  binary: string;
  store: string;
  url?: string;
  key?: string;
}

export function newStore(label: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `marfa-device-${label}-`)),
    "core.sqlite",
  );
}

export class CliDevice implements DeviceUnderTest {
  constructor(private readonly options: CliDeviceOptions) {}

  get store(): string {
    return this.options.store;
  }

  reopen(overrides: { url?: string; key?: string } = {}): DeviceUnderTest {
    return new CliDevice({ ...this.options, ...overrides });
  }

  async hydrate(types: string[], tier: Tier): Promise<Outcome<HydrateReport>> {
    return this.json<HydrateReport>([
      "hydrate",
      ...this.server(),
      "--types",
      types.join(","),
      "--tier",
      tier,
    ]);
  }

  async catchUp(): Promise<Outcome<CatchUpReport>> {
    return this.json<CatchUpReport>(["catch-up", ...this.server()]);
  }

  async list(filters: ListFilters = {}): Promise<Outcome<Item[]>> {
    const args = ["items", "list"];
    if (filters.type !== undefined) args.push("--type", filters.type);
    if (filters.state !== undefined) args.push("--state", filters.state);
    if (filters.includeTrashed === true) args.push("--include-trashed");
    if (filters.tier !== undefined) args.push("--tier", filters.tier);
    for (const tag of filters.tags ?? []) args.push("--tag", tag);
    if (filters.limit !== undefined)
      args.push("--limit", String(filters.limit));
    if (filters.unsupported !== undefined)
      args.push(filters.unsupported[0], filters.unsupported[1]);
    return this.json<Item[]>(args);
  }

  async get(id: string): Promise<Outcome<Item>> {
    return this.json<Item>(["items", "get", id]);
  }

  async search(query: string, limit?: number): Promise<Outcome<SearchHit[]>> {
    const args = ["search", query];
    if (limit !== undefined) args.push("--limit", String(limit));
    return this.json<SearchHit[]>(args);
  }

  async status(): Promise<Outcome<Status>> {
    return this.json<Status>(["status"]);
  }

  /** An operation the binary offers no command for at all, for the refusal statements. */
  async attempt(args: string[]): Promise<Outcome<unknown>> {
    return this.json<unknown>(args);
  }

  private server(): string[] {
    const args: string[] = [];
    if (this.options.url !== undefined) args.push("--url", this.options.url);
    if (this.options.key !== undefined) args.push("--key", this.options.key);
    return args;
  }

  private async json<T>(args: string[]): Promise<Outcome<T>> {
    const full = ["--db", this.options.store, "--json", ...args];
    try {
      const { stdout } = await run(this.options.binary, full, {
        // A device that hangs is a failing device, and the runner owns the
        // deadline for everything else; this bound only stops one hung spawn
        // from taking the whole file's budget with nothing naming it.
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      const text = stdout.trim();
      return { ok: true, value: (text === "" ? null : JSON.parse(text)) as T };
    } catch (error) {
      const failure = error as {
        stderr?: string;
        code?: number | string;
        message?: string;
      };
      const stderr = failure.stderr ?? failure.message ?? "";
      const exitCode = typeof failure.code === "number" ? failure.code : null;
      return { ok: false, refusal: classify(stderr, exitCode) };
    }
  }
}
