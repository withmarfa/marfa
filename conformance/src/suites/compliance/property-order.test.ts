/**
 * An item's properties come back in the order they were written, whether or
 * not a name reads as a number.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "property-order",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("the order of an item's properties", () => {
  it("answers the properties in the order they were written, names that read as numbers included", async () => {
    // A JavaScript object puts a name such as `10` first when it is written
    // out, and a parsed one cannot show the order the server sent, so the
    // body goes out as text and the order is read from the text that returns.
    const orderOf = (text: string, names: string[]): string[] =>
      names
        .map((name) => ({ name, at: text.indexOf(`"${name}":`) }))
        .filter(({ at }) => at >= 0)
        .sort((x, y) => x.at - y.at)
        .map(({ name }) => name);
    const send = async (method: string, path: string, body?: string) =>
      await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });
    const served = async (id: string) =>
      await (await send("GET", `/items/${id}`)).text();

    const created = await send(
      "POST",
      "/items",
      `{"type":"core.note","source":"${ctx.source}","properties":{"b":"sent first","body":"declared","1":"one","a":"sent last"}}`,
    );
    expect(created.status).toBe(201);
    const made = (await created.json()) as {
      item: { id: string; version: number };
    };
    trackItem(ctx, made.item.id);
    const everyName = ["body", "b", "1", "a", "10", "2", "01", "7", "-1"];
    expect(orderOf(await served(made.item.id), everyName)).toEqual([
      "body",
      "b",
      "1",
      "a",
    ]);
    const merged = await send(
      "PATCH",
      `/items/${made.item.id}`,
      `{"version":${made.item.version},"properties":{"10":"ten","2":"two","01":"padded","7":"seven"}}`,
    );
    expect(merged.status).toBe(200);
    expect(orderOf(await served(made.item.id), everyName)).toEqual([
      "body",
      "b",
      "1",
      "a",
      "10",
      "2",
      "01",
      "7",
    ]);
  });
});
