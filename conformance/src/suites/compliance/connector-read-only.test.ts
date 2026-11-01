import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem, TestContext } from "../../client/types.js";
import {
  createTestContext,
  createSecondClient,
  cleanup,
  getOwnerClient,
  removeTrackedRegistrations,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { openEventStream } from "../../utils/sse.js";
import { collectUntil } from "../../utils/stream.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "connector-read-only",
  ));
});

beforeEach(async () => {
  await removeTrackedRegistrations(ctx);
});

afterAll(async () => {
  await cleanup(ctx);
});

function declare(by: MarfaClient, readOnlyTypes?: string[]) {
  return by.registerConnector({
    name: `${ctx.runId} read only`,
    ...(readOnlyTypes && { read_only_types: readOnlyTypes }),
  });
}

async function write(
  by: MarfaClient,
  type: "core.note" | "core.task",
  tag: string,
): Promise<MarfaItem> {
  const result = await by.createItem({
    type,
    properties:
      type === "core.task"
        ? { title: `${ctx.runId} ${tag}` }
        : { body: `${ctx.runId} ${tag}` },
    tags: [tag],
  });
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  trackItem(ctx, result.data.item.id);
  return result.data.item;
}

describe("declaring read_only_types", () => {
  it("stores the declared types, replaces them on a repeat and clears them when left out", async () => {
    const created = await declare(client, [
      "core.note",
      "acme.never.written",
      "core.note",
    ]);
    expect(created.status).toBe(201);
    await expectMatchesSchema("POST", "/connectors", 201, created.data);
    expect(created.data.read_only_types).toEqual([
      "core.note",
      "acme.never.written",
    ]);

    const replaced = await declare(client, ["core.task"]);
    expect(replaced.status).toBe(200);
    expect(replaced.data.read_only_types).toEqual(["core.task"]);

    const cleared = await declare(client);
    expect(cleared.status).toBe(200);
    expect(cleared.data.read_only_types).toEqual([]);
    const read = await client.getConnector(created.data.id);
    expect(read.data.read_only_types).toEqual([]);
  });

  it("refuses a malformed type identifier and registers nothing", async () => {
    const refused = await client.rawRequest<unknown>("/connectors", {
      method: "POST",
      body: { name: `${ctx.runId} malformed`, read_only_types: ["Not a type"] },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect((await client.listConnectors()).data.data).toEqual([]);
  });
});

describe("read_only on items", () => {
  it("reads an item read only while its connector declares the type, and editable once the declaration is gone", async () => {
    const tag = `read-only-${ctx.runId}`;
    const note = await write(client, "core.note", tag);
    const task = await write(client, "core.task", tag);
    const elsewhere = await write(
      await createSecondClient(ctx, "unregistered"),
      "core.note",
      tag,
    );
    expect(note.read_only).toBe(false);
    expect((await declare(client, ["core.note"])).status).toBe(201);

    // One page across two sources and two types.
    const shown = async (): Promise<Record<string, boolean>> => {
      const page = await client.listItems({ tags: [tag], limit: 10 });
      expect(page.status).toBe(200);
      await expectMatchesSchema("GET", "/items", 200, page.data);
      return Object.fromEntries(
        page.data.data.map((item) => [item.id, item.read_only]),
      );
    };
    expect(await shown()).toEqual({
      [note.id]: true,
      [task.id]: false,
      [elsewhere.id]: false,
    });
    const one = await client.getItem(note.id);
    await expectMatchesSchema("GET", "/items/{id}", 200, one.data);
    expect(one.data.item.read_only).toBe(true);
    const found = await client.search(`${ctx.runId} ${tag}`, {
      type: "core.note",
      source: ctx.source,
    });
    expect(found.status).toBe(200);
    expect(found.data.data.map((r) => [r.item.id, r.item.read_only])).toEqual([
      [note.id, true],
    ]);

    // The change frame is worked out as it is sent.
    let version = note.version;
    const updatedFrame = async (body: string): Promise<unknown> => {
      const stream = await openEventStream(apiUrl, apiKey);
      try {
        const edited = await client.updateItem(note.id, {
          properties: { body },
          version,
        });
        expect(edited.status).toBe(200);
        version = edited.data.item.version;
        expect(edited.data.item.read_only).toBe(body === "held");
        const { events } = await collectUntil(
          stream,
          (seen) =>
            seen.some(
              (e) =>
                e.event === "item.updated" &&
                (e.data as { item: MarfaItem }).item.id === note.id,
            ),
          "the note's item.updated frame",
        );
        return events.find(
          (e) =>
            e.event === "item.updated" &&
            (e.data as { item: MarfaItem }).item.id === note.id,
        )?.data;
      } finally {
        await stream.close();
      }
    };
    expect(await updatedFrame("held")).toMatchObject({
      item: { read_only: true },
    });

    expect((await declare(client)).status).toBe(200);
    expect(await shown()).toEqual({
      [note.id]: false,
      [task.id]: false,
      [elsewhere.id]: false,
    });
    expect((await client.getItem(note.id)).data.item.read_only).toBe(false);
    expect(await updatedFrame("released")).toMatchObject({
      item: { read_only: false },
    });
  });

  it("keeps an item editable while another connector that claims its source does not declare its type", async () => {
    const tag = `read-only-claimed-${ctx.runId}`;
    const note = await write(client, "core.note", tag);
    const minted = await getOwnerClient().createKey({
      label: `${ctx.source}-claimant`,
      source: `${ctx.source}-claimant`,
      sources: [ctx.source],
      default_tier: "library",
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const claimant = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const readOnly = async () =>
      (await client.getItem(note.id)).data.item.read_only;

    expect((await declare(client, ["core.note"])).status).toBe(201);
    expect((await declare(claimant, ["core.task"])).status).toBe(201);
    expect(await readOnly()).toBe(false);
    expect((await declare(claimant, ["core.note"])).status).toBe(200);
    expect(await readOnly()).toBe(true);
  });
});
