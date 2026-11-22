import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackKey,
  trackType,
} from "../../utils/setup.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";

/**
 * `marfa_overview` with `type`, and `marfa_save_type` taking guidance
 * (`mcp/overview-one-type`, `mcp/save-type-guidance`).
 */

let ctx: TestContext;
let client: MarfaClient;
let apiUrl: string;
let mcp: McpConnection;

const FIELDS = { title: { type: "string" } };

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface Compact {
  id: string;
  guidance?: string;
  ancestor_guidance?: { type: string; guidance: string }[];
  fields?: {
    status?: { status_values?: { value?: string; description?: string }[] };
  };
}

function typeOf(body: Record<string, unknown>): Compact {
  return body.type as Compact;
}

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "mcp-type-guidance",
  ));
  const minted = await client.createKey({
    label: `${ctx.source}-schema`,
    source: `${ctx.source}-schema`,
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  mcp = await connectMcp(apiUrl, minted.data.key, "2026-07-28", "/mcp/schema");
});

afterAll(async () => {
  await mcp?.close();
  await cleanup(ctx);
});

describe("marfa_overview type", () => {
  it("returns one type for a string and the asked types, in order, for an array", async () => {
    const one = toolResult(
      await callTool(mcp, "marfa_overview", { type: "core.note" }),
    );
    expect(typeOf(one).id).toBe("core.note");
    expect(one).not.toHaveProperty("types");

    const listed = toolResult(
      await callTool(mcp, "marfa_overview", {
        type: ["core.task", "no.such.type", "core.collection", "core.note"],
      }),
    );
    const types = listed.types as Compact[];
    expect(types.map((entry) => entry.id)).toEqual([
      "core.task",
      "core.collection",
      "core.note",
    ]);
    expect(listed.unknown).toEqual(["no.such.type"]);
    expect(listed).not.toHaveProperty("type");

    const known = toolResult(
      await callTool(mcp, "marfa_overview", {
        type: ["core.bookmark", "core.note"],
      }),
    );
    expect(known).not.toHaveProperty("unknown");
    expect((known.types as Compact[]).map((entry) => entry.id)).toEqual([
      "core.bookmark",
      "core.note",
    ]);
  });

  it("answers type_not_found when no asked id is a type, matching one id sent as a string", async () => {
    const asString = await callTool(mcp, "marfa_overview", {
      type: "no.such.only",
    });
    const asArray = await callTool(mcp, "marfa_overview", {
      type: ["no.such.only"],
    });
    expect(toolError(asString).code).toBe("type_not_found");
    expect(toolError(asArray)).toEqual(toolError(asString));

    const both = toolError(
      await callTool(mcp, "marfa_overview", {
        type: ["no.such.left", "no.such.right"],
      }),
    );
    expect(both.code).toBe("type_not_found");
    expect(String(both.message)).toContain("no.such.left");
    expect(String(both.message)).toContain("no.such.right");
  });

  it("refuses an empty, over-long, repeated or non-string type array, naming type", async () => {
    const tooMany = Array.from(
      { length: 21 },
      (_, index) => `user.t${String(index)}`,
    );
    for (const type of [
      [],
      tooMany,
      ["core.note", "core.note"],
      ["core.note", 1],
    ]) {
      const answer = await callTool(mcp, "marfa_overview", { type });
      expect(answer.isError, JSON.stringify(type)).toBe(true);
      expect(toolError(answer).code, answer.text).toBe("validation_error");
      expect(answer.text).toContain("type");
    }
    toolResult(await callTool(mcp, "marfa_overview", { type: "core.note" }));
  });

  it("returns shipped guidance, ancestor guidance on a child, and neither key when a type has none", async () => {
    const shipped = toolResult(
      await callTool(mcp, "marfa_overview", {
        type: [
          "core.note",
          "core.collection",
          "core.task",
          "core.bookmark",
          "core.entity",
        ],
      }),
    );
    const byId = Object.fromEntries(
      (shipped.types as Compact[]).map((entry) => [entry.id, entry]),
    );
    for (const id of [
      "core.note",
      "core.collection",
      "core.task",
      "core.bookmark",
    ]) {
      expect(typeof byId[id]?.guidance, id).toBe("string");
      expect(byId[id]?.guidance?.length, id).toBeGreaterThan(0);
    }
    expect(byId["core.entity"]).not.toHaveProperty("guidance");
    expect(byId["core.entity"]).not.toHaveProperty("ancestor_guidance");

    const page = typeOf(
      toolResult(
        await callTool(mcp, "marfa_overview", { type: "core.file.webpage" }),
      ),
    );
    expect(page).not.toHaveProperty("guidance");
    expect(page.ancestor_guidance?.[0]?.type).toBe("core.file");
    expect(page.ancestor_guidance?.[0]?.guidance.length).toBeGreaterThan(0);

    const id = `user.guided${unique()}`;
    const saved = toolResult(
      await callTool(mcp, "marfa_save_type", {
        action: "register",
        id,
        parent: "core.note",
        guidance: "A child of a note.",
        fields: FIELDS,
      }),
    );
    trackType(ctx, id, client, "core.note");
    expect(typeOf(saved).guidance).toBe("A child of a note.");
    const child = typeOf(
      toolResult(await callTool(mcp, "marfa_overview", { type: id })),
    );
    expect(child.guidance).toBe("A child of a note.");
    expect(child.ancestor_guidance?.map((entry) => entry.type)).toEqual([
      "core.note",
    ]);
    expect(child.ancestor_guidance?.[0]?.guidance.length).toBeGreaterThan(0);
  });

  it("keeps a status word's description on the type it returns", async () => {
    const id = `user.status${unique()}`;
    const saved = await client.registerType({
      id,
      fields: {
        status: {
          type: "status",
          status_values: [
            {
              value: "open",
              group: "not_started",
              description: "Not begun.",
            },
          ],
        },
      },
    });
    expect(saved.status, JSON.stringify(saved.error)).toBe(201);
    trackType(ctx, id, client);
    const read = typeOf(
      toolResult(await callTool(mcp, "marfa_overview", { type: id })),
    );
    expect(read.fields?.status?.status_values?.[0]?.description).toBe(
      "Not begun.",
    );
  });

  it("returns an existing app type and lists a missing id as unknown", async () => {
    const id = `app.guided.note${unique()}`;
    const saved = await client.registerType({ id, fields: FIELDS });
    expect(saved.status, JSON.stringify(saved.error)).toBe(201);
    trackType(ctx, id, client);
    const one = typeOf(
      toolResult(await callTool(mcp, "marfa_overview", { type: id })),
    );
    expect(one.id).toBe(id);
    const mixed = toolResult(
      await callTool(mcp, "marfa_overview", { type: [id, "no.such.app"] }),
    );
    expect((mixed.types as Compact[]).map((entry) => entry.id)).toEqual([id]);
    expect(mixed.unknown).toEqual(["no.such.app"]);
  });
});

describe("marfa_save_type guidance", () => {
  it("stores guidance on register and on change, removes it for an empty string, and leaves it when the call omits it", async () => {
    const id = `user.guide${unique()}`;
    const registered = toolResult(
      await callTool(mcp, "marfa_save_type", {
        action: "register",
        id,
        guidance: "First.",
        fields: FIELDS,
      }),
    );
    trackType(ctx, id, client);
    expect(typeOf(registered).guidance).toBe("First.");

    const relabelled = toolResult(
      await callTool(mcp, "marfa_save_type", {
        action: "change",
        id,
        label: "Guided",
      }),
    );
    expect(typeOf(relabelled).guidance).toBe("First.");

    const replaced = toolResult(
      await callTool(mcp, "marfa_save_type", {
        action: "change",
        id,
        guidance: "Second.",
      }),
    );
    expect(typeOf(replaced).guidance).toBe("Second.");

    const cleared = toolResult(
      await callTool(mcp, "marfa_save_type", {
        action: "change",
        id,
        guidance: "",
      }),
    );
    expect(typeOf(cleared)).not.toHaveProperty("guidance");
    const read = typeOf(
      toolResult(await callTool(mcp, "marfa_overview", { type: id })),
    );
    expect(read).not.toHaveProperty("guidance");
  });

  it("refuses guidance of 1,001 characters, naming guidance, and stores 1,000", async () => {
    const overId = `user.over${unique()}`;
    const over = await callTool(mcp, "marfa_save_type", {
      action: "register",
      id: overId,
      guidance: "a".repeat(1001),
      fields: FIELDS,
    });
    expect(over.isError).toBe(true);
    expect(toolError(over).code, over.text).toBe("validation_error");
    expect(over.text).toContain("guidance");
    const missing = await callTool(mcp, "marfa_overview", { type: overId });
    expect(toolError(missing).code).toBe("type_not_found");

    const atId = `user.at${unique()}`;
    const guidance = "😀".repeat(1000);
    const at = toolResult(
      await callTool(mcp, "marfa_save_type", {
        action: "register",
        id: atId,
        guidance,
        fields: FIELDS,
      }),
    );
    trackType(ctx, atId, client);
    expect(typeOf(at).guidance).toBe(guidance);
  });

  it("refuses guidance from a key without schema.write, and the same key registers the type without it", async () => {
    const minted = await client.createKey({
      label: `${ctx.source}-noschema`,
      source: `${ctx.source}-noschema-${unique()}`,
      permissions: [],
      metadata_permissions: { types: "write" },
      type_permissions: { "*": "write" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const limited = await connectMcp(
      apiUrl,
      minted.data.key,
      "2026-07-28",
      "/mcp/schema",
    );
    try {
      const plain = `user.plain${unique()}`;
      const made = toolResult(
        await callTool(limited, "marfa_save_type", {
          action: "register",
          id: plain,
          fields: FIELDS,
        }),
      );
      trackType(ctx, plain, client);
      expect(typeOf(made)).not.toHaveProperty("guidance");

      const blocked = `user.blocked${unique()}`;
      const refused = await callTool(limited, "marfa_save_type", {
        action: "register",
        id: blocked,
        guidance: "Not allowed.",
        fields: FIELDS,
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(toolError(refused))).toContain("schema.write");
      const absent = await callTool(mcp, "marfa_overview", { type: blocked });
      expect(toolError(absent).code).toBe("type_not_found");

      const changed = await callTool(limited, "marfa_save_type", {
        action: "change",
        id: plain,
        guidance: "Not allowed.",
      });
      expect(changed.isError).toBe(true);
      expect(JSON.stringify(toolError(changed))).toContain("schema.write");
      const read = typeOf(
        toolResult(await callTool(mcp, "marfa_overview", { type: plain })),
      );
      expect(read).not.toHaveProperty("guidance");
    } finally {
      await limited.close();
    }
  });
});
