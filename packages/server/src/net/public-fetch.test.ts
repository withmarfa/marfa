import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { clearFaults, setFault } from "../control/faults.js";
import {
  createPublicFetcher,
  type FetchedFile,
  type PublicFetchOutcome,
} from "./public-fetch.js";

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

/** Reads the whole body, as the blob upload a tool hands it to does. */
async function readAll(file: FetchedFile): Promise<Uint8Array> {
  return new Uint8Array(await new Response(file.body).arrayBuffer());
}

/** A fetcher whose saved value is the file's bytes. */
const fetcher =
  (maxBytes = 1024, timeoutMs = 5_000) =>
  (url: string): Promise<PublicFetchOutcome<Uint8Array>> =>
    createPublicFetcher({ maxBytes, timeoutMs, maxConcurrent: 4 })(
      url,
      readAll,
    );

describe("createPublicFetcher", () => {
  it("fetches a file from a public address with its type and name", async () => {
    const files = await host((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/pdf; charset=binary",
        "Content-Disposition": 'attachment; filename="report.pdf"',
      });
      res.end("%PDF-1.7");
    });
    const outcome = await createPublicFetcher({
      maxBytes: 1024,
      timeoutMs: 5_000,
      maxConcurrent: 4,
    })(
      `http://${publicName("files.test")}:${String(files.port)}/report`,
      async (file) => ({
        text: new TextDecoder().decode(await readAll(file)),
        mimeType: file.mimeType,
        fileName: file.fileName,
      }),
    );
    expect(outcome).toEqual({
      kind: "fetched",
      value: {
        text: "%PDF-1.7",
        mimeType: "application/pdf",
        fileName: "report.pdf",
      },
      size: 8,
    });
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
    expect(fits.kind === "fetched" ? fits.value.byteLength : -1).toBe(2048);
  });

  it("hands the body on as it arrives and stops it past the cap", async () => {
    let release = (): void => undefined;
    const files = await host((_req, res) => {
      res.writeHead(200, { "Transfer-Encoding": "chunked" });
      res.write(Buffer.alloc(512));
      release = () => {
        res.write(Buffer.alloc(1024));
        res.end();
      };
    });
    const seen: number[] = [];
    let saveError: unknown;
    const outcome = await createPublicFetcher({
      maxBytes: 1024,
      timeoutMs: 5_000,
      maxConcurrent: 4,
    })(
      `http://${publicName("big.test")}:${String(files.port)}/`,
      async (file) => {
        const reader = file.body.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) return "read";
            seen.push(next.value.byteLength);
            // The first chunk reaches the save before the rest is sent.
            if (seen.length === 1) release();
          }
        } catch (err) {
          saveError = err;
          return "stopped";
        }
      },
    );
    expect(seen[0]).toBe(512);
    expect(seen.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(1024);
    expect(saveError).toBeDefined();
    expect(outcome).toMatchObject({ kind: "failed", reason: "too_large" });
  });

  it("refuses a fetch past the number it makes at once, and takes one again once a fetch ends", async () => {
    const finish: (() => void)[] = [];
    const files = await host((_req, res) => {
      res.writeHead(200);
      res.write("a");
      finish.push(() => res.end("b"));
    });
    const fetchOne = createPublicFetcher({
      maxBytes: 1024,
      timeoutMs: 5_000,
      maxConcurrent: 2,
    });
    const url = `http://${publicName("busy.test")}:${String(files.port)}/`;
    const save = (file: FetchedFile) => readAll(file);
    const first = fetchOne(url, save);
    const second = fetchOne(url, save);
    await expect.poll(() => finish.length).toBe(2);
    expect(await fetchOne(url, save)).toMatchObject({
      kind: "failed",
      reason: "busy",
    });
    expect(files.hits()).toBe(2);
    for (const end of finish.splice(0)) end();
    expect((await first).kind).toBe("fetched");
    expect((await second).kind).toBe("fetched");
    // The witness: with the two ended, the same fetch is made.
    const third = fetchOne(url, save);
    await expect.poll(() => finish.length).toBe(1);
    finish[0]?.();
    expect((await third).kind).toBe("fetched");
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
