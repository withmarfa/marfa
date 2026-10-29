import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
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

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

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
/** How many files the server fetches for tools at once. */
const FETCHES_AT_ONCE = 4;
/** How many fetches one credential's tool calls make in a window. */
const FETCHES_PER_WINDOW = 30;

let server: FreshServer;
let mcp: McpConnection;
const hosts: Server[] = [];

beforeAll(async () => {
  server = await bootFreshServer("mcp-scripted", {
    MARFA_MCP_FETCH_MAX_BYTES: String(FETCH_MAX_BYTES),
    RATE_LIMIT_ENABLED: "true",
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

/** A connection with a key of its own, holding what the working key holds. */
async function connectWithNewKey(label: string): Promise<McpConnection> {
  const minted = await new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  }).createKey({
    label: `mcp-scripted-${label}`,
    source: `mcp-scripted-${label}`,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return connectMcp(server.apiUrl, minted.data.key);
}

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

  it("answers a repeated save naming attach_to as attached, with one edge", async () => {
    const agent = await connectWithNewKey("attach-repeat");
    try {
      const note = await owner().createItem({
        type: "core.note",
        properties: { title: "Receipts" },
      });
      expect(note.status).toBe(201);
      const host = await fileHost((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end("%PDF-1.7 receipt");
      });
      const args = {
        id: uuidv7(),
        url: await host.at("receipts.test", "/receipt.pdf"),
        attach_to: note.data.item.id,
      };
      const first = toolResult(await callTool(agent, "marfa_create", args));
      expect(first).toMatchObject({
        created: true,
        attached_to: note.data.item.id,
      });

      const again = toolResult(await callTool(agent, "marfa_create", args));
      expect(again).toMatchObject({
        id: args.id,
        created: false,
        attached_to: note.data.item.id,
      });
      const edges = await owner().listItemEdges(args.id, {
        edge_type: "attached-to",
      });
      expect(edges.data.data.map((edge) => edge.target_id)).toEqual([
        note.data.item.id,
      ]);
    } finally {
      await agent.close();
    }
  });

  it("leaves file out of a repeated save whose stored item holds other bytes", async () => {
    const agent = await connectWithNewKey("other-bytes");
    try {
      let body = "first bytes";
      const host = await fileHost((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(body);
      });
      const args = {
        id: uuidv7(),
        url: await host.at("notes.test", "/a.txt"),
      };
      const first = toolResult(await callTool(agent, "marfa_create", args));
      // The witness: a save that wrote the item describes its file.
      expect(first).toHaveProperty("file.size_bytes", 11);

      body = "other bytes, longer";
      const again = toolResult(await callTool(agent, "marfa_create", args));
      expect(again).toMatchObject({ id: args.id, created: false });
      expect(again).not.toHaveProperty("file");
    } finally {
      await agent.close();
    }
  });
});

describe("marfa_create's fetches", () => {
  it("records each fetch with its scheme, host and outcome, and its path and query only as lengths and a hash", async () => {
    const host = await fileHost((req, res) => {
      if (req.url?.startsWith("/gone") === true) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("agenda");
    });
    const query = "signature=kept-out-of-the-log";
    const saved = await host.at("audit.test", `/agenda.txt?${query}`);
    const gone = await host.at("audit.test", "/gone");
    const connection = await connectWithNewKey("audit");
    try {
      toolResult(await callTool(connection, "marfa_create", { url: saved }));
      toolError(await callTool(connection, "marfa_create", { url: gone }));
    } finally {
      await connection.close();
    }
    const audit = await new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.managementKey,
    }).listAudit({ action: "mcp.file_fetch", q: "audit.test", limit: 10 });
    expect(audit.status, JSON.stringify(audit.error)).toBe(200);
    const entries = audit.data.data.reverse();
    expect(entries.map((entry) => entry.details)).toMatchObject([
      {
        scheme: "http",
        host: `audit.test:${String(host.port)}`,
        path_length: "/agenda.txt".length,
        path_sha256: sha256("/agenda.txt"),
        query_length: query.length,
        outcome: "fetched",
      },
      {
        scheme: "http",
        host: `audit.test:${String(host.port)}`,
        path_length: "/gone".length,
        path_sha256: sha256("/gone"),
        query_length: 0,
        outcome: "status",
      },
    ]);
    const [first, second] = entries;
    expect(first?.key_id).not.toBeNull();
    expect(second?.key_id).toBe(first?.key_id);
    expect(JSON.stringify(entries)).not.toContain("kept-out-of-the-log");
    expect(JSON.stringify(entries)).not.toContain("agenda.txt");
  });

  it("refuses a fifth fetch at once with reason busy, without connecting", async () => {
    const finish: (() => void)[] = [];
    const host = await fileHost((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("a");
      finish.push(() => res.end("b"));
    });
    const connection = await connectWithNewKey("busy");
    try {
      const held = [];
      for (let i = 0; i < FETCHES_AT_ONCE; i++) {
        const url = await host.at("busy.test", `/held-${String(i)}`);
        held.push(callTool(connection, "marfa_create", { url }));
      }
      await expect.poll(() => finish.length).toBe(FETCHES_AT_ONCE);
      const url = await host.at("busy.test", "/one-more");
      const error = toolError(
        await callTool(connection, "marfa_create", { url }),
      );
      expect(error).toMatchObject({ code: "file_not_fetched", reason: "busy" });
      expect(host.hits()).toBe(FETCHES_AT_ONCE);
      for (const end of finish.splice(0)) end();
      // The witness: the fetches it was making were made and saved.
      for (const answer of await Promise.all(held)) {
        expect(toolResult(answer)).toMatchObject({ type: "core.file" });
      }
    } finally {
      for (const end of finish.splice(0)) end();
      await connection.close();
    }
  });

  it("refuses a credential's 31st fetch in a window with reason rate_limited, and not another credential's", async () => {
    const first = await connectWithNewKey("rate-first");
    const second = await connectWithNewKey("rate-second");
    try {
      const url = "http://127.0.0.1:9/private";
      for (let i = 0; i < FETCHES_PER_WINDOW; i++) {
        expect(
          toolError(await callTool(first, "marfa_create", { url })),
        ).toMatchObject({ reason: "not_public" });
      }
      const refused = toolError(await callTool(first, "marfa_create", { url }));
      expect(refused).toMatchObject({
        code: "file_not_fetched",
        reason: "rate_limited",
      });
      expect(refused.retry_after_seconds).toBeGreaterThan(0);
      expect(
        toolError(await callTool(second, "marfa_create", { url })),
      ).toMatchObject({ reason: "not_public" });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it(
    "refuses url and file with reason disabled while MARFA_MCP_FETCH_ENABLED is off, without connecting",
    async () => {
      const host = await fileHost((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("agenda");
      });
      const url = await host.at("off.test", "/agenda.txt");
      // The witness: a server with fetching on fetches the file.
      toolResult(await callTool(mcp, "marfa_create", { url }));
      expect(host.hits()).toBe(1);

      const off = await bootFreshServer("mcp-scripted-off", {
        MARFA_MCP_FETCH_ENABLED: "false",
      });
      await off.setFault(`resolve:off.test=${PUBLIC_ADDRESS}>127.0.0.1`);
      const connection = await connectMcp(off.apiUrl, off.workingKey);
      try {
        for (const args of [
          { url },
          { file: { download_url: url, file_id: "file_off" } },
        ]) {
          expect(
            toolError(await callTool(connection, "marfa_create", args)),
          ).toMatchObject({ code: "file_not_fetched", reason: "disabled" });
        }
        expect(host.hits()).toBe(1);
      } finally {
        await connection.close();
        await off.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a tool call's writes", () => {
  it("records a tool call's write with the caller's address and marks it as made through MCP", async () => {
    const direct = await owner().createItem({
      type: "core.note",
      properties: { body: "written directly" },
    });
    expect(direct.status, JSON.stringify(direct.error)).toBe(201);
    const created = toolResult(
      await callTool(mcp, "marfa_create", {
        type: "core.note",
        properties: { body: "written through MCP" },
      }),
    );
    const audit = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.managementKey,
    });
    const entryFor = async (id: string) => {
      const page = await audit.listAudit({
        action: "item.create",
        resource_id: id,
      });
      expect(page.status, JSON.stringify(page.error)).toBe(200);
      expect(page.data.data).toHaveLength(1);
      return page.data.data[0];
    };
    const plain = await entryFor(direct.data.item.id);
    const through = await entryFor(created.id as string);
    expect(plain?.client_ip).not.toBeNull();
    expect(plain?.details).not.toHaveProperty("via");
    expect(through).toMatchObject({
      key_id: plain?.key_id,
      client_ip: plain?.client_ip,
      details: { via: "mcp" },
    });
  });
});

describe("marfa_update", () => {
  it("tags nothing when the item changes between the call's read and its tag write", async () => {
    const made = await owner().createItem({
      type: "core.note",
      properties: { body: "one" },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const { id, version } = made.data.item;
    await server.setFault("hold:write=item.tag@1");
    const pending = callTool(mcp, "marfa_update", {
      id,
      version,
      add_tags: ["late"],
    });
    await server.waitForHold("hold:write");
    const moved = await owner().updateItem(id, {
      version,
      properties: { body: "two" },
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    await server.clearFault("hold:write");
    expect(toolError(await pending)).toMatchObject({
      code: "version_conflict",
      failed_step: "add_tags",
      applied: [],
      current: { id, version: version + 1 },
    });
    expect((await owner().getMetadata(id)).data.metadata.tags).toEqual([]);
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
  it("trashes none of the items when a child joins one of them between the confirmation's check and the trash", async () => {
    const save = async (body: string): Promise<string> => {
      const made = await owner().createItem({
        type: "core.note",
        properties: { body },
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      return made.data.item.id;
    };
    const first = await save("first parent");
    const second = await save("second parent");
    const late = await save("joins after the check");
    const ids = [first, second];
    const preview = toolResult(await callTool(mcp, "marfa_delete", { ids }));
    await server.setFault("hold:write=items.trash@1");
    const pending = callTool(mcp, "marfa_delete", {
      ids,
      confirm: preview.confirm,
    });
    await server.waitForHold("hold:write");
    const linked = await owner().createEdge({
      source_id: second,
      target_id: late,
      edge_type: "parent-of",
    });
    expect(linked.status, JSON.stringify(linked.error)).toBe(201);
    await server.clearFault("hold:write");
    expect(toolError(await pending).code).toBe("trash_plan_changed");
    for (const id of [first, second, late]) {
      expect((await owner().getItem(id)).data.item.state).toBe("active");
    }
  });
});
