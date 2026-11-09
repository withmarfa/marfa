/**
 * A source's code and name are counted in characters, and a code takes no
 * Unicode White_Space at either end.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getOwnerClient,
} from "../../utils/setup.js";

let ctx: TestContext;
let owner: MarfaClient;
const named = new Set<string>();

beforeAll(async () => {
  ({ ctx } = await createTestContext("compliance", "source-name-characters"));
  owner = getOwnerClient();
});

afterAll(async () => {
  for (const source of named) {
    await owner.rawRequest(sourcePath(source), {
      method: "PATCH",
      body: { name: null, mark: null },
    });
  }
  await cleanup(ctx);
});

function sourcePath(source: string): string {
  return `/source?source=${encodeURIComponent(source)}`;
}

function nameSource(
  source: string,
  body: { name?: string | null; mark?: string | null },
) {
  named.add(source);
  return owner.rawRequest<{ name: string }>(sourcePath(source), {
    method: "PATCH",
    body,
  });
}

describe("a source's code and name", () => {
  it("counts a code in characters and takes no Unicode White_Space at either end", async () => {
    const emoji = await nameSource("😀".repeat(200), { name: "Emoji" });
    expect(emoji.status, JSON.stringify(emoji.error)).toBe(200);
    const past = await nameSource("😀".repeat(201), { name: "Past" });
    expect(past.status).toBe(400);
    for (const edge of ["\u0085", "\u3000", "\u00a0"]) {
      const refused = await nameSource(`${ctx.source}${edge}`, {
        name: "Padded",
      });
      expect(refused.status, JSON.stringify(edge)).toBe(400);
    }
  });

  it("counts a name in characters", async () => {
    const source = `${ctx.source}-name-characters`;
    await nameSource(source, { name: "Kept" });
    const past = await nameSource(source, { name: "😀".repeat(201) });
    expect(past.status).toBe(400);
    expect(past.error?.error.code).toBe("validation_error");
    // The witness: the longest name that fits is taken, though it holds more
    // than 200 UTF-16 units.
    const fits = await nameSource(source, { name: "😀".repeat(200) });
    expect(fits.status, JSON.stringify(fits.error)).toBe(200);
  });
});
