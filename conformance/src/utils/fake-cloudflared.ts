import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { onCleanup, tempFolder } from "./temp-folder.js";
import { waitFor } from "./wait.js";

/**
 * A stand-in for the tunnel connector `cloudflared`, for a server booted
 * with `MARFA_CLOUDFLARED` at its `path`.
 *
 * The file at `path` is a small Node program with a shebang line and the
 * folder baked in, because the server gives the connector none of its own
 * environment, so nothing can be passed that way, and no shell stands between
 * the server and it to add variables of its own. It records each start
 * (arguments, environment, process ID, and the token file it was given, as
 * it was when the program started), prints what the connector prints, serves `/ready` on the address `--metrics` names, and acts as the
 * plan for that start says.
 *
 * A plan is one entry per start, the last standing for every start after
 * it. An entry says whether the connector `ready`s itself, whether it
 * `refuse`s the tunnel tokens it lists (or every one, with `"*"`) as the
 * edge refuses an old token (with the error text in `refusal`, which is the
 * edge's secret refusal unless given), whether it `echoToken`s the token it was given
 * into its output, which `lines` it prints, and whether it `exit`s with a
 * code after a time, and whether, asked to end, it first `onTerminate`s by
 * sending one request, as the connector sends the requests it still carries.
 * `ready(true)` makes `/ready` answer `200` whatever the
 * plan says, and `ready(false)` goes back to the plan. `refuseNow` refuses
 * tokens while the connector runs.
 *
 * It prints the line the real connector prints at every start, that no
 * ingress rules were defined, since the origin is set on Marfa Cloud.
 */
export interface FakeCloudflared {
  /** The file to give `MARFA_CLOUDFLARED`. */
  path: string;
  /** The folder that holds it and its records. */
  folder: string;
  plan(entries: PlanEntry[]): void;
  ready(on: boolean): void;
  /**
   * Makes every connector running with one of `tokens`, now or later, print
   * the refusal and stop answering `/ready`, as the edge does for a token
   * that was rotated.
   */
  refuseNow(tokens: string[]): void;
  /** Every start so far, oldest first. */
  starts(): Start[];
  /** Waits until `count` starts have been recorded. */
  waitForStarts(count: number, timeoutMs?: number): Promise<Start[]>;
  /** Removes the file at `path`, as a connector that is not installed. */
  uninstall(): void;
  /** Puts the file back after `uninstall`. */
  install(): void;
}

export interface PlanEntry {
  ready?: boolean;
  refuse?: string[] | "*";
  refusal?: string;
  echoToken?: boolean;
  lines?: string[];
  exit?: { code: number; afterMs: number };
  /** The one request sent, and answered, before the connector ends when it is asked to. */
  onTerminate?: { url: string; headers: Record<string, string>; body: string };
}

export interface Start {
  index: number;
  pid: number;
  argv: string[];
  env: Record<string, string>;
  at: number;
  tokenFile: { path: string; mode: string; text: string } | null;
}

const PROGRAM = String.raw`
const { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");

const argv = process.argv.slice(2);
const read = (name, fallback) => {
  try {
    return JSON.parse(readFileSync(folder + "/" + name, "utf8"));
  } catch {
    return fallback;
  }
};
const index = read("count.json", 0);
writeFileSync(folder + "/count.json", JSON.stringify(index + 1));
const plan = read("plan.json", []);
const entry = plan.length === 0 ? {} : plan[Math.min(index, plan.length - 1)];

const after = (flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};
const tokenPath = after("--token-file");
let tokenFile = null;
if (tokenPath !== undefined) {
  try {
    tokenFile = {
      path: tokenPath,
      mode: (statSync(tokenPath).mode & 0o777).toString(8),
      text: readFileSync(tokenPath, "utf8"),
    };
  } catch {
    tokenFile = null;
  }
}
appendFileSync(
  folder + "/starts.jsonl",
  JSON.stringify({
    index,
    pid: process.pid,
    argv,
    env: process.env,
    at: Date.now(),
    tokenFile,
  }) + "\n",
);

const say = (text) => process.stderr.write(new Date().toISOString().slice(0, 19) + "Z " + text + "\n");
say("INF Starting tunnel tunnelID=00000000-0000-0000-0000-000000000000");
say("WRN No ingress rules were defined in provided config (if any) nor from the cli, cloudflared will return 502 for all incoming HTTP requests");
for (const line of entry.lines ?? []) say(line);
if (entry.echoToken && tokenFile !== null) say("INF token " + tokenFile.text);

let refused = false;
const refuse = () => {
  if (refused) return;
  refused = true;
  say("ERR Register tunnel error from server side error=\"" + (entry.refusal ?? "Unauthorized: Invalid tunnel secret") + "\" connIndex=0");
};
const refusedNow = () => {
  const tokens = read("refuse-now.json", []);
  return tokenFile !== null && tokens.includes(tokenFile.text.trim());
};
const planned =
  tokenFile !== null &&
  (entry.refuse === "*" || (entry.refuse ?? []).includes(tokenFile.text.trim()));
if (planned) setTimeout(refuse, 100);
setInterval(() => {
  if (refusedNow()) refuse();
}, 100);

const metrics = after("--metrics");
if (metrics !== undefined) {
  const at = metrics.lastIndexOf(":");
  createServer((request, response) => {
    if (request.url !== "/ready") {
      response.writeHead(404).end();
      return;
    }
    const up =
      existsSync(folder + "/ready") || (entry.ready === true && !refused && !planned);
    response
      .writeHead(up ? 200 : 503, { "content-type": "application/json" })
      .end(JSON.stringify({ status: up ? 200 : 503, readyConnections: up ? 4 : 0 }));
  }).listen(Number(metrics.slice(at + 1)), metrics.slice(0, at));
} else {
  setInterval(() => {}, 1000);
}

if (entry.onTerminate !== undefined) {
  process.on("SIGTERM", () => {
    const { url, headers, body } = entry.onTerminate;
    fetch(url, { method: "POST", headers, body })
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

if (entry.exit !== undefined) {
  setTimeout(() => process.exit(entry.exit.code), entry.exit.afterMs);
}
`;

export function fakeCloudflared(): FakeCloudflared {
  const folder = tempFolder("fc-");
  const path = join(folder, "cloudflared");
  const script = `#!${process.execPath}\nconst folder = ${JSON.stringify(folder)};${PROGRAM}`;
  const install = () => {
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  };
  install();
  mkdirSync(join(folder, "records"), { recursive: true });
  const starts = (): Start[] => {
    const file = join(folder, "starts.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Start);
  };
  // A fixture that failed leaves no connector behind it: the server's own
  // stop is what is under test, so only what is still running is ended.
  onCleanup(() => {
    for (const start of starts()) {
      try {
        process.kill(start.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  return {
    path,
    folder,
    plan: (entries) => {
      writeFileSync(join(folder, "plan.json"), JSON.stringify(entries));
    },
    ready: (on) => {
      const file = join(folder, "ready");
      if (on) writeFileSync(file, "");
      else rmSync(file, { force: true });
    },
    refuseNow: (tokens) => {
      writeFileSync(join(folder, "refuse-now.json"), JSON.stringify(tokens));
    },
    starts,
    waitForStarts: (count, timeoutMs = 30_000) =>
      waitFor(
        `${String(count)} starts of the connector`,
        async () => (starts().length >= count ? starts() : undefined),
        timeoutMs,
        50,
      ),
    uninstall: () => rmSync(path, { force: true }),
    install,
  };
}
