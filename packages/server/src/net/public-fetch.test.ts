import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { clearFaults, setFault } from "../control/faults.js";
import { createPublicFetcher } from "./public-fetch.js";

const servers: Server[] = [];

afterEach(async () => {
  clearFaults();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** A file host on loopback that answers with `respond`, counting hits. */
async function host(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    respond(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve();
    }),
  );
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the host did not bind");
  }
  return { port: address.port, hits: () => hits };
}

/** A public address the check passes, connected to loopback by the fault. */
const PUBLIC = "93.184.215.14";

function publicName(name: string): string {
  setFault(`resolve:${name}`, `${PUBLIC}>127.0.0.1`);
  return name;
}

const fetcher = (maxBytes = 1024, timeoutMs = 5_000) =>
  createPublicFetcher({ maxBytes, timeoutMs });

describe("createPublicFetcher", () => {
  it("fetches a file from a public address with its type and name", async () => {
    const files = await host((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/pdf; charset=binary",
        "Content-Disposition": 'attachment; filename="report.pdf"',
      });
      res.end("%PDF-1.7");
    });
    const outcome = await fetcher()(
      `http://${publicName("files.test")}:${String(files.port)}/report`,
    );
    expect(outcome).toMatchObject({
      kind: "fetched",
      mimeType: "application/pdf",
      fileName: "report.pdf",
    });
    if (outcome.kind !== "fetched") throw new Error("not fetched");
    expect(new TextDecoder().decode(outcome.bytes)).toBe("%PDF-1.7");
  });

  it("refuses an address written out that is not public, without connecting", async () => {
    const files = await host((_req, res) => {
      res.end("secret");
    });
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "[::1]",
      "[fc00::1]",
      "[::ffff:127.0.0.1]",
    ]) {
      const outcome = await fetcher()(
        `http://${address}:${String(files.port)}/`,
      );
      expect(outcome, address).toMatchObject({
        kind: "failed",
        reason: "not_public",
      });
    }
    expect(files.hits()).toBe(0);
  });

  it("refuses a name that resolves to a private address, without connecting", async () => {
    const files = await host((_req, res) => {
      res.end("secret");
    });
    setFault("resolve:inside.test", "127.0.0.1");
    // The witness: the same host is reached through a name checked as public.
    const reached = await fetcher()(
      `http://${publicName("outside.test")}:${String(files.port)}/`,
    );
    expect(reached.kind).toBe("fetched");
    expect(files.hits()).toBe(1);
    const outcome = await fetcher()(
      `http://inside.test:${String(files.port)}/`,
    );
    expect(outcome).toMatchObject({ kind: "failed", reason: "not_public" });
    expect(files.hits()).toBe(1);
  });

  it("refuses a name with one private address among public ones", async () => {
    const files = await host((_req, res) => {
      res.end("secret");
    });
    setFault("resolve:mixed.test", `${PUBLIC}>127.0.0.1,10.0.0.1`);
    const outcome = await fetcher()(`http://mixed.test:${String(files.port)}/`);
    expect(outcome).toMatchObject({ kind: "failed", reason: "not_public" });
    expect(files.hits()).toBe(0);
  });

  it("does not follow a redirect", async () => {
    const inside = await host((_req, res) => {
      res.end("secret");
    });
    const files = await host((_req, res) => {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${String(inside.port)}/`,
      });
      res.end();
    });
    const outcome = await fetcher()(
      `http://${publicName("moved.test")}:${String(files.port)}/`,
    );
    expect(outcome).toMatchObject({
      kind: "failed",
      reason: "redirect",
      status: 302,
    });
    expect(inside.hits()).toBe(0);
  });

  it("refuses a file larger than the cap, declared or streamed", async () => {
    const declared = await host((_req, res) => {
      res.writeHead(200, { "Content-Length": "2048" });
      res.end(Buffer.alloc(2048));
    });
    const streamed = await host((_req, res) => {
      res.writeHead(200, { "Transfer-Encoding": "chunked" });
      for (let i = 0; i < 8; i++) res.write(Buffer.alloc(256));
      res.end();
    });
    const name = publicName("big.test");
    expect(
      await fetcher(1024)(`http://${name}:${String(declared.port)}/`),
    ).toMatchObject({ kind: "failed", reason: "too_large" });
    expect(
      await fetcher(1024)(`http://${name}:${String(streamed.port)}/`),
    ).toMatchObject({ kind: "failed", reason: "too_large" });
    // The witness: the same streamed file under a larger cap is fetched.
    const fits = await fetcher(4096)(
      `http://${name}:${String(streamed.port)}/`,
    );
    expect(fits.kind === "fetched" ? fits.bytes.byteLength : -1).toBe(2048);
  });

  it("reports an address that answers without the file", async () => {
    const files = await host((_req, res) => {
      res.writeHead(404);
      res.end("gone");
    });
    expect(
      await fetcher()(
        `http://${publicName("gone.test")}:${String(files.port)}/`,
      ),
    ).toMatchObject({ kind: "failed", reason: "status", status: 404 });
  });

  it("gives up on an address that does not answer in time", async () => {
    const files = await host(() => {
      // Never answers.
    });
    expect(
      await fetcher(
        1024,
        200,
      )(`http://${publicName("slow.test")}:${String(files.port)}/`),
    ).toMatchObject({ kind: "failed", reason: "timeout" });
  });

  it("refuses a URL that is not http or https, or carries credentials", async () => {
    for (const url of [
      "ftp://files.example/a",
      "file:///etc/passwd",
      "https://user:pass@files.example/a",
      "not a url",
    ]) {
      expect(await fetcher()(url), url).toMatchObject({
        kind: "failed",
        reason: "bad_url",
      });
    }
  });
});
