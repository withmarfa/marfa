import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackItem } from "../../utils/setup.js";
import { cliContext } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

let c: CliContext;
let dir: string;
let contract: string;
const servers: Server[] = [];

beforeAll(async () => {
  c = await cliContext("key-and-files");
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-key-and-files-"));
  const current = await fetch(`${c.apiUrl}/keys/current`, {
    headers: { authorization: `Bearer ${c.apiKey}` },
  });
  contract = current.headers.get("x-marfa-contract") ?? "";
  expect(contract).not.toBe("");
});

afterAll(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  rmSync(dir, { recursive: true, force: true });
  await cleanup(c.ctx);
});

interface Arrival {
  method: string;
  url: string;
  authorization: string | undefined;
}

type Answer = (
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
) => void;

/** Records every request and CONNECT, and answers each as `answer` says. */
async function listen(
  bind: string,
  answer: Answer,
): Promise<{ arrivals: Arrival[]; port: number }> {
  const arrivals: Arrival[] = [];
  const server = createServer((request, response) => {
    arrivals.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
    });
    request.resume();
    answer(request, response);
  });
  server.on("connect", (request, socket) => {
    arrivals.push({
      method: "CONNECT",
      url: request.url ?? "",
      authorization: undefined,
    });
    socket.destroy();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, bind, resolve));
  return { arrivals, port: (server.address() as AddressInfo).port };
}

const unavailable: Answer = (_request, response) => {
  response.writeHead(503, { "content-type": "application/json" });
  response.end("{}");
};

function otherHost(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  throw new Error(
    "this machine has no network address but loopback, so no address can stand for another host",
  );
}

describe("a request to a server on this machine", () => {
  it("never goes through a proxy the environment names, and one to another host does", async () => {
    const proxy = await listen("127.0.0.1", unavailable);
    const through = `http://127.0.0.1:${String(proxy.port)}`;
    const named = c.cli.withEnv({
      HTTP_PROXY: through,
      http_proxy: through,
      HTTPS_PROXY: through,
      ALL_PROXY: through,
      all_proxy: through,
    });

    const { port } = new URL(c.apiUrl);
    for (const host of ["127.0.0.1", "localhost"]) {
      const answered = await named
        .at(`http://${host}:${port}`)
        .json<{ id: string }>(["whoami"]);
      expect(answered, host).toBeTruthy();
    }
    expect(proxy.arrivals).toEqual([]);

    const elsewhere = await listen("0.0.0.0", unavailable);
    const outcome = await named
      .at(`http://${otherHost()}:${String(elsewhere.port)}`)
      .run(["--json", "whoami"]);
    expect(outcome.code).not.toBe(0);
    expect(proxy.arrivals.length).toBeGreaterThan(0);
    expect(elsewhere.arrivals).toEqual([]);
  });
});

describe("a key from MARFA_API_KEY", () => {
  it("goes only to the server MARFA_API_URL names, and a --url for another server refuses", async () => {
    const other = await listen("127.0.0.1", unavailable);
    const otherUrl = `http://127.0.0.1:${String(other.port)}`;

    const refused = await c.cli.refused(["--url", otherUrl, "whoami"]);
    expect(refused.code).toBe(2);
    expect(refused.envelope.error.code).toBe("usage");
    expect(refused.envelope.error.message).toContain("--key");
    expect(refused.envelope.error.message).toContain("MARFA_API_URL");
    expect(other.arrivals).toEqual([]);

    // The same server named twice is the pair it was exported as.
    const same = await c.cli.run(["--json", "--url", c.apiUrl, "whoami"]);
    expect(same.code, same.stderr).toBe(0);

    // The witness: an explicit key reaches the other server.
    const given = await c.cli.run([
      "--json",
      "--url",
      otherUrl,
      "--key",
      c.apiKey,
      "whoami",
    ]);
    expect(given.code).toBe(3);
    expect(other.arrivals.length).toBeGreaterThan(0);
  });
});

const BODY = Buffer.from("the bytes of a stored file\n");
const DIGEST = `sha256:${createHash("sha256").update(BODY).digest("hex")}`;

function files(): string[] {
  return readdirSync(dir).sort();
}

describe("a file the binary writes", () => {
  it("is readable by its owner alone whatever the umask, for an export and a download", async () => {
    const served = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-marfa-contract": contract,
      });
      response.end(BODY);
    });
    const server = c.cli.at(`http://127.0.0.1:${String(served.port)}`);
    const before = process.umask(0o022);
    try {
      const exported = join(dir, "items.ndjson");
      const made = await c.cli.run([
        "--json",
        "export",
        "--format",
        "ndjson",
        "--output",
        exported,
      ]);
      expect(made.code, made.stderr).toBe(0);
      expect(statSync(exported).mode & 0o777).toBe(0o600);

      const downloaded = join(dir, "stored.bin");
      const got = await server.run([
        "--json",
        "blobs",
        "download",
        DIGEST,
        "--output",
        downloaded,
      ]);
      expect(got.code, got.stderr).toBe(0);
      expect(readFileSync(downloaded)).toEqual(BODY);
      expect(statSync(downloaded).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(before);
    }
  });

  it("replaces the file at --output only when the download arrives whole and matches its digest", async () => {
    const target = join(dir, "kept.bin");
    writeFileSync(target, "the earlier file");
    const listing = files();

    const cut = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-marfa-contract": contract,
        "content-length": String(BODY.length),
      });
      response.write(BODY.subarray(0, 5));
      setTimeout(() => response.destroy(), 50);
    });
    const shortened = await c.cli
      .at(`http://127.0.0.1:${String(cut.port)}`)
      .run(["--json", "blobs", "download", DIGEST, "--output", target]);
    expect(shortened.code).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("the earlier file");
    expect(files()).toEqual(listing);

    const wrong = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-marfa-contract": contract,
      });
      response.end("not the file that was asked for");
    });
    const mismatched = await c.cli
      .at(`http://127.0.0.1:${String(wrong.port)}`)
      .run(["--json", "blobs", "download", DIGEST, "--output", target]);
    expect(mismatched.code).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("the earlier file");
    expect(files()).toEqual(listing);

    // The witness: the same download, whole and matching, replaces it.
    const whole = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-marfa-contract": contract,
      });
      response.end(BODY);
    });
    const replaced = await c.cli
      .at(`http://127.0.0.1:${String(whole.port)}`)
      .run(["--json", "blobs", "download", DIGEST, "--output", target]);
    expect(replaced.code, replaced.stderr).toBe(0);
    expect(readFileSync(target)).toEqual(BODY);
    expect(existsSync(target)).toBe(true);
  });
});

// Terminal sequences, a C1 control, and bidirectional overrides and isolates.
const HOSTILE =
  "\u001b]0;pwned\u0007\u001b]52;c;aGk=\u0007\u001b[2Kfake\u009b31m‮⁦⁩end";

describe("a listing of items", () => {
  it("prints no control or bidirectional character from a title, and --json is unchanged", async () => {
    const created = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--prop",
      `title=${HOSTILE}`,
      "--tag",
      "listing-escape",
    ]);
    trackItem(c.ctx, created.item.id);

    const listed = await c.cli.run([
      "items",
      "list",
      "--type",
      "core.note",
      "--all",
    ]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(created.item.id);
    // eslint-disable-next-line no-control-regex
    expect(listed.stdout).not.toMatch(
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/,
    );
    expect(listed.stdout).toContain("fake");

    const json = await c.cli.json([
      "items",
      "list",
      "--type",
      "core.note",
      "--all",
    ]);
    expect(JSON.stringify(json)).toContain(
      JSON.stringify(HOSTILE).slice(1, -1),
    );
  });
});
