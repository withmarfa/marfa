import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";

/**
 * The MCP tools where a fixture must script what the server meets: a file
 * host reached by a name the server resolves as the fault
 * `resolve:<hostname>=<public>><loopback>` scripts, so its check sees a
 * public address and its socket reaches a host on loopback, and the server's
 * clock moved past a confirmation's life.
 */
const PUBLIC_ADDRESS = "93.184.216.34";
const FETCH_MAX_BYTES = 4096;
const CONFIRMATION_LIFE_MS = 5 * 60 * 1000;

let server: FreshServer;
let mcp: McpConnection;
const hosts: Server[] = [];

beforeAll(async () => {
  server = await bootFreshServer("mcp-scripted", {
    MARFA_MCP_FETCH_MAX_BYTES: String(FETCH_MAX_BYTES),
  });
  mcp = await connectMcp(server.apiUrl, server.workingKey);
}, FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
  await Promise.all(
    hosts.splice(0).map(
      (host) =>
        new Promise<void>((resolve) => {
          host.closeAllConnections();
          host.close(() => {
            resolve();
          });
        }),
    ),
  );
});

afterAll(async () => {
  await mcp?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function owner(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}

interface FileHost {
  port: number;
  hits(): number;
  /** The host's address under `name`, which the server resolves as public. */
  at(name: string, path: string): Promise<string>;
}

async function fileHost(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<FileHost> {
  let hits = 0;
  const host = createServer((req, res) => {
    hits += 1;
    respond(req, res);
  });
  hosts.push(host);
  await new Promise<void>((resolve) =>
    host.listen(0, "127.0.0.1", () => {
      resolve();
    }),
  );
  const address = host.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the file host did not bind");
  }
  return {
    port: address.port,
    hits: () => hits,
    at: async (name, path) => {
      await server.setFault(`resolve:${name}=${PUBLIC_ADDRESS}>127.0.0.1`);
      return `http://${name}:${String(address.port)}${path}`;
    },
  };
}

describe("marfa_create with a file", () => {
  it("saves a file from a public address as a file item with its bytes and address", async () => {
    const host = await fileHost((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end("%PDF-1.7 minutes");
    });
    const url = await host.at("files.test", "/minutes.pdf");
    const created = toolResult(await callTool(mcp, "marfa_create", { url }));
    expect(created).toMatchObject({
      type: "core.file",
      title: "minutes.pdf",
      file: { mime_type: "application/pdf", size_bytes: 16 },
    });
    const item = await owner().getItem(created.id as string);
    expect(item.data.item.properties).toMatchObject({
      blob_ref: (created.file as { hash: string }).hash,
      source_url: url,
    });
  });

  it("refuses a file at a loopback address with file_not_fetched and reason not_public, without connecting", async () => {
    const host = await fileHost((_req, res) => {
      res.end("private");
    });
    const error = toolError(
      await callTool(mcp, "marfa_create", {
        url: `http://127.0.0.1:${String(host.port)}/private`,
      }),
    );
    expect(error).toMatchObject({
      code: "file_not_fetched",
      reason: "not_public",
    });
    expect(host.hits()).toBe(0);
  });

  it("does not follow a redirect, and answers file_not_fetched with reason redirect", async () => {
    const inner = await fileHost((_req, res) => {
      res.end("private");
    });
    const outer = await fileHost((_req, res) => {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${String(inner.port)}/private`,
      });
      res.end();
    });
    const url = await outer.at("moved.test", "/file");
    const error = toolError(await callTool(mcp, "marfa_create", { url }));
    expect(error).toMatchObject({
      code: "file_not_fetched",
      reason: "redirect",
    });
    expect(outer.hits()).toBe(1);
    expect(inner.hits()).toBe(0);
  });

  it("refuses a file larger than MARFA_MCP_FETCH_MAX_BYTES with reason too_large and saves nothing", async () => {
    const host = await fileHost((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(2 * 1024 * 1024 * 1024),
      });
      res.write("x".repeat(FETCH_MAX_BYTES));
    });
    const url = await host.at("large.test", "/movie.mp4");
    const error = toolError(await callTool(mcp, "marfa_create", { url }));
    expect(error).toMatchObject({
      code: "file_not_fetched",
      reason: "too_large",
    });
    const videos = await owner().listItems({ type: "core.file.video" });
    expect(videos.data.data).toHaveLength(0);
  });

  it("answers a chat file whose link has gone with file_not_fetched and the status", async () => {
    const host = await fileHost((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const url = await host.at("chat.test", "/files/gone");
    const error = toolError(
      await callTool(mcp, "marfa_create", {
        file: { download_url: url, file_id: "file_gone" },
      }),
    );
    expect(error).toMatchObject({
      code: "file_not_fetched",
      reason: "status",
      status: 404,
    });
  });
});

describe("marfa_delete", () => {
  it("refuses a confirmation once five minutes have passed since the preview", async () => {
    const made = await owner().createItem({
      type: "core.note",
      properties: { body: "kept" },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const id = made.data.item.id;
    const preview = toolResult(
      await callTool(mcp, "marfa_delete", { ids: [id] }),
    );
    await server.advanceClock(CONFIRMATION_LIFE_MS + 1_000);
    const error = toolError(
      await callTool(mcp, "marfa_delete", {
        ids: [id],
        confirm: preview.confirm,
      }),
    );
    expect(error.code).toBe("confirmation_stale");
    expect((await owner().getItem(id)).data.item.state).toBe("active");
  });
});
