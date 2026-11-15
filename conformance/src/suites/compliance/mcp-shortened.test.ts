import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";

/**
 * What an MCP tool leaves out of an answer, and says it left out
 * (`mcp/health-error-withheld`, `mcp/health-housekeeping-withheld`, `mcp/sources-left-out`). Each needs a server of
 * the fixture's own: a fault that makes a component not well, and a list of
 * sources long enough to outgrow one answer, are not for the run's shared
 * server.
 */
let server: FreshServer;
let owner: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("mcp-shortened");
  owner = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, FRESH_SERVER_TIMEOUT_MS);

interface Health {
  health: {
    status: string;
    components: Record<string, { status: string; error?: string }>;
    housekeeping?: unknown;
  };
}

describe("marfa_health", () => {
  async function mint(permissions: string[]): Promise<McpConnection> {
    const minted = await owner.createKey({
      label: `mcp-shortened-${permissions.join("-")}`,
      source: `mcp-shortened-${permissions.join("-")}`,
      permissions,
      type_permissions: {},
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    return connectMcp(
      server.apiUrl,
      minted.data.key,
      "2026-07-28",
      "/mcp/admin",
    );
  }

  it("gives a credential without instance.read no error on a component and no housekeeping object, and gives both to one with it", async () => {
    const connectors = await mint(["connectors.manage"]);
    const instance = await connectMcp(
      server.apiUrl,
      server.managementKey,
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      const well = (await callTool(connectors, "marfa_health", {})).body;
      expect((well as unknown as Health).health.status).toBe("ok");

      await server.setFault("refuse:blob-store");
      try {
        const told = toolResult(
          await callTool(instance, "marfa_health", {}),
        ) as unknown as Health;
        // The witness: there is text to leave out, and an object to leave out.
        expect(told.health.components.blob_storage?.status).toBe("down");
        expect(told.health.components.blob_storage?.error).toEqual(
          expect.any(String),
        );
        expect(told.health).toHaveProperty("housekeeping");

        const withheld = toolResult(
          await callTool(connectors, "marfa_health", {}),
        ) as unknown as Health;
        expect(withheld.health.status).toBe("down");
        expect(withheld.health.components.blob_storage?.status).toBe("down");
        for (const component of Object.values(withheld.health.components)) {
          expect(component).not.toHaveProperty("error");
        }
        expect(withheld.health).not.toHaveProperty("housekeeping");
      } finally {
        await server.clearFault("refuse:blob-store");
      }
    } finally {
      await instance.close();
      await connectors.close();
    }
  });
});

describe("marfa_sources", () => {
  /** A source code as long as one may be, so a short list outgrows an answer. */
  const code = (n: number): string =>
    `${String(n).padStart(4, "0")}-`.padEnd(200, "s");

  it("names how many sources it left out when the list outgrows one answer, and none when it does not", async () => {
    const schema = await connectMcp(
      server.apiUrl,
      server.managementKey,
      "2026-07-28",
      "/mcp/schema",
    );
    try {
      const few = toolResult(await callTool(schema, "marfa_sources", {}));
      expect(few).not.toHaveProperty("left_out");

      const total = 200;
      for (let n = 0; n < total; n++) {
        toolResult(
          await callTool(schema, "marfa_name_source", {
            source: code(n),
            name: `Source ${String(n)}`,
          }),
        );
      }
      const all = await owner.rawRequest<{ data: unknown[] }>("/sources");
      expect(all.status).toBe(200);
      const held = all.ok ? all.data.data.length : 0;
      expect(held).toBeGreaterThanOrEqual(total);

      const answer = toolResult(
        await callTool(schema, "marfa_sources", {}),
      ) as { sources: unknown[]; left_out: number };
      expect(answer.left_out).toBeGreaterThan(0);
      expect(answer.sources.length + answer.left_out).toBe(held);
      // A source left out is still read by naming it.
      const one = toolResult(
        await callTool(schema, "marfa_sources", { source: code(total - 1) }),
      ) as { sources: { source: string }[] };
      expect(one.sources.map((entry) => entry.source)).toEqual([
        code(total - 1),
      ]);
    } finally {
      await schema.close();
    }
  }, 120_000);
});
