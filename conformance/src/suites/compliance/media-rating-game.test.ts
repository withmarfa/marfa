import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "compliance",
    "media-rating-game",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function create(type: string, properties: Record<string, unknown>) {
  const created = await client.createItem({
    type,
    source: ctx.source,
    properties,
  });
  if (created.ok) trackItem(ctx, created.data.item.id);
  return created;
}

describe("the rating of a media item", () => {
  it("is an optional integer from 1 to 5 on core.media and the game type", async () => {
    for (const id of ["core.media", "core.media.book", "core.media.game"]) {
      const read = await client.getType(id);
      expect(read.status, id).toBe(200);
      expect(read.data.fields.rating, id).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: 5,
      });
      expect(read.data.fields.rating?.required, id).toBeUndefined();
    }
  });

  it("takes a book rated 5 and reads it back", async () => {
    const book = await create("core.media.book", { title: "Rated", rating: 5 });
    expect(book.status, JSON.stringify(book.error)).toBe(201);
    expect(book.data.item.properties.rating).toBe(5);
  });

  it.each([0, 6, 3.5])(
    "refuses a rating of %s, naming rating",
    async (rating) => {
      const refused = await create("core.media.book", {
        title: "Rated",
        rating,
      });
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("invalid_properties");
      expect(JSON.stringify(refused.error)).toContain("rating");
    },
  );
});

describe("the game type", () => {
  it("lists core.media.game beneath core.media", async () => {
    const listed = await client.listTypes();
    expect(listed.status).toBe(200);
    const game = listed.data.data.find((t) => t.id === "core.media.game");
    expect(game?.parent).toBe("core.media");
    expect(game?.label).toBeTruthy();
  });

  it("declares its own fields and inherits progress and rating", async () => {
    const read = await client.getType("core.media.game");
    expect(read.data.fields.platforms).toMatchObject({
      type: "array",
      items_type: "string",
    });
    for (const name of ["min_players", "max_players"]) {
      expect(read.data.fields[name], name).toMatchObject({
        type: "integer",
        minimum: 1,
      });
    }
    expect(read.data.fields.progress?.type).toBe("status");
    expect(read.data.fields.rating?.type).toBe("integer");
  });

  it("takes a game on two platforms for one to four players", async () => {
    const properties = {
      title: "A game",
      platforms: ["Nintendo Switch", "PC"],
      min_players: 1,
      max_players: 4,
      progress: "started",
      rating: 4,
    };
    const game = await create("core.media.game", properties);
    expect(game.status, JSON.stringify(game.error)).toBe(201);
    expect(game.data.item.properties).toMatchObject(properties);
  });

  it("refuses 0 players, naming min_players", async () => {
    const refused = await create("core.media.game", {
      title: "A game",
      min_players: 0,
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(JSON.stringify(refused.error)).toContain("min_players");
  });
});
