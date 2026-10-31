/**
 * The source tools at `/mcp/schema`: reading sources, and setting the name
 * and mark of one's own source, refused for a source the key may not name.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { TestContext } from "../test-utils.js";
import {
  cleanupTestContext,
  createTestContext,
  mintWorkingKey,
} from "../test-utils.js";
import { callTool, connectMcp, errorOf, payloadOf } from "./test-client.js";

let ctx: TestContext;
let client: Client;
const OWN = "mcp-sources-own";

beforeAll(async () => {
  ctx = await createTestContext();
  const key = await mintWorkingKey(ctx, {
    label: "Sync script",
    source: OWN,
  });
  client = await connectMcp(ctx, key, { path: "/mcp/schema" });
});

afterAll(async () => {
  await client.close();
  await cleanupTestContext(ctx);
});

describe("the source tools", () => {
  it("reads the key's own source, named by its label", async () => {
    const one = payloadOf(
      await callTool(client, "marfa_sources", { source: OWN }),
    );
    expect(one.sources).toEqual([
      { source: OWN, name: "Sync script", name_from: "key" },
    ]);
    const all = payloadOf(await callTool(client, "marfa_sources", {}));
    expect(all.sources).toContainEqual({
      source: OWN,
      name: "Sync script",
      name_from: "key",
    });
  });

  it("sets and clears the name and mark of its own source", async () => {
    const set = payloadOf(
      await callTool(client, "marfa_name_source", {
        source: OWN,
        name: "Readwise",
        mark: "lucide:book-open",
      }),
    );
    expect(set).toEqual({
      source: OWN,
      name: "Readwise",
      name_from: "set",
      mark: "lucide:book-open",
    });
    const cleared = payloadOf(
      await callTool(client, "marfa_name_source", {
        source: OWN,
        name: null,
        mark: null,
      }),
    );
    expect(cleared).toEqual({
      source: OWN,
      name: "Sync script",
      name_from: "key",
    });
  });

  it("is refused another source, and a source it cannot see", async () => {
    const other = errorOf(
      await callTool(client, "marfa_name_source", {
        source: "someone-else",
        name: "Nope",
      }),
    );
    expect(other.code).toBe("forbidden");
    const unseen = errorOf(
      await callTool(client, "marfa_sources", { source: "someone-else" }),
    );
    expect(unseen.code).toBe("source_not_found");
  });
});
